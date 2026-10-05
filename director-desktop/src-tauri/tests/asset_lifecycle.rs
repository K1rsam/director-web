use director_core::{
    binding, pipeline,
    store::{asset_deleted, s, Store},
    Engine,
};
use serde_json::{json, Value};

fn fixture() -> (tempfile::TempDir, Store) {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::open(temp.path().join("project")).unwrap();
    store.create("asset lifecycle", "p").unwrap();
    (temp, store)
}
fn asset(store: &Store, id: &str) -> Value {
    store.save_asset(json!({"id":id,"name":id,"kind":"character","baseAssetId":id,"variantId":"base","prompt":"image prompt"})).unwrap()
}
fn image(store: &Store, label: &str, asset: &str) -> Value {
    let file = store.root.join(format!("{label}.png"));
    image::RgbImage::from_pixel(2, 2, image::Rgb([label.len() as u8, 7, 13]))
        .save(&file)
        .unwrap();
    store
        .import_media(&file, "image", Some(asset), Some("base"))
        .unwrap()
}
fn reference(id: &str) -> Value {
    json!({"assetId":id,"variantId":"base","role":"character","order":0})
}
fn unit(store: &Store, id: &str, target: &str) -> Value {
    store.save_unit(json!({"id":id,"episodeId":"ep1","sceneId":"scene1","title":id,"duration":4,"prompt":"video prompt","assetRefs":[reference(target)]})).unwrap()
}

#[test]
fn deleting_a_test_asset_is_reversible_and_does_not_remove_files_or_rewrite_identity() {
    let (_temp, store) = fixture();
    let original = asset(&store, "test-person");
    let media = image(&store, "original", "test-person");
    store.adopt("test-person", "base", s(&media, "id")).unwrap();
    assert_eq!(store.asset_usage("test-person").unwrap()["imageCount"], 1);
    let deleted = store.set_asset_deleted("test-person", 1, true).unwrap();
    assert!(asset_deleted(&deleted));
    assert!(store.values("assets").unwrap().is_empty());
    assert_eq!(store.deleted_assets().unwrap().len(), 1);
    assert!(store.active_asset("test-person").is_err());
    assert!(store.save_asset(original).is_err());
    assert!(store.set_asset_deleted("test-person", 1, false).is_err());
    let restored = store.set_asset_deleted("test-person", 2, false).unwrap();
    assert_eq!(restored["version"], 3);
    assert_eq!(
        store.adopted("test-person", "base").unwrap().as_deref(),
        Some(s(&media, "id"))
    );
    assert!(store.verify_media(&media).is_ok());
    let mut edit = restored;
    edit["name"] = json!("correct display name");
    edit["expectedVersion"] = edit["version"].clone();
    let edited = store.save_asset(edit).unwrap();
    assert_eq!(edited["version"], 4);
    let mut bad = edited;
    bad["variantId"] = json!("wrong-identity");
    bad["expectedVersion"] = bad["version"].clone();
    assert!(store.save_asset_user(bad).unwrap_err().contains("身份"));
}

#[test]
fn deletion_targets_only_related_unsubmitted_work_and_preserves_cloud_and_unknown_submissions() {
    let (_temp, store) = fixture();
    asset(&store, "target");
    asset(&store, "unrelated");
    store
        .save_asset(
            json!({"id":"derived","name":"costume","variantId":"base","sourceAssetId":"target"}),
        )
        .unwrap();
    unit(&store, "unit", "target");
    unit(&store, "derived-unit", "derived");
    let queued = store
        .add_job(
            "video",
            "unit",
            "mock",
            "account",
            &json!({"references":[]}),
            "ready",
        )
        .unwrap();
    let dependency = store
        .add_job(
            "image",
            "derived",
            "mock",
            "account",
            &json!({"assetId":"derived"}),
            "waiting_dependency",
        )
        .unwrap();
    let unrelated = store
        .add_job(
            "image",
            "unrelated",
            "mock",
            "account",
            &json!({}),
            "queued",
        )
        .unwrap();
    let submitted = store
        .add_job(
            "image",
            "target",
            "mock",
            "account",
            &json!({"assetId":"target","prompt":"frozen","references":[]}),
            "submitted",
        )
        .unwrap();
    store
        .update_job(
            &submitted,
            "submitted",
            &json!({"providerTaskId":"cloud-original","receipt":{"taskId":"cloud-original"}}),
        )
        .unwrap();
    let unknown = store
        .add_job(
            "video",
            "unknown-unit",
            "mock",
            "account",
            &json!({"references":[reference("target")]}),
            "submission_unknown",
        )
        .unwrap();
    let before = store.job(&submitted).unwrap();
    let unknown_before = store.job(&unknown).unwrap();
    let usage = store.asset_usage("target").unwrap();
    assert_eq!(usage["units"].as_array().unwrap().len(), 2);
    assert_eq!(usage["derivedAssets"][0]["id"], "derived");
    assert_eq!(usage["submittedJobs"].as_array().unwrap().len(), 2);
    store.set_asset_deleted("target", 1, true).unwrap();
    assert_eq!(store.job(&submitted).unwrap(), before);
    assert_eq!(store.job(&unknown).unwrap(), unknown_before);
    assert_eq!(store.job(&queued).unwrap()["status"], "stale");
    assert_eq!(store.job(&dependency).unwrap()["status"], "stale");
    assert_eq!(store.job(&unrelated).unwrap()["status"], "queued");
}

#[test]
fn a_late_generated_image_remains_history_without_reviving_a_deleted_asset() {
    let (_temp, store) = fixture();
    let original = asset(&store, "target");
    let media = image(&store, "old-current", "target");
    store.adopt("target", "base", s(&media, "id")).unwrap();
    let job = store
        .add_job(
            "image",
            "target",
            "mock",
            "account",
            &json!({"assetId":"target","variantId":"base","assetVersion":original["version"]}),
            "submitted",
        )
        .unwrap();
    store
        .update_job(
            &job,
            "submitted",
            &json!({"providerTaskId":"cloud-original"}),
        )
        .unwrap();
    store.set_asset_deleted("target", 1, true).unwrap();
    let late = image(&store, "late-download", "target");
    store.attach_download_result(&job, s(&late, "id")).unwrap();
    store
        .complete_download(
            &job,
            &json!({"taskId":"cloud-original","resultUrls":["https://offline.test/image"]}),
            &[s(&late, "id").to_owned()],
        )
        .unwrap();
    assert_eq!(store.job(&job).unwrap()["status"], "downloaded");
    assert!(store.values("assets").unwrap().is_empty());
    assert_eq!(
        store.adopted("target", "base").unwrap().as_deref(),
        Some(s(&media, "id"))
    );
    assert_eq!(store.asset_usage("target").unwrap()["imageCount"], 2);
    assert_eq!(store.ensure_current_images().unwrap()["selectedCount"], 0);
    assert!(store.verify_media(&late).is_ok());
}

#[test]
fn deleted_bindings_stay_visible_and_can_be_replaced_without_changing_submitted_material() {
    let (_temp, store) = fixture();
    asset(&store, "old");
    asset(&store, "correct");
    let old = unit(&store, "unit", "old");
    store.set_asset_deleted("old", 1, true).unwrap();
    let binding = binding::bind(&store, &old, "mock", "model").unwrap();
    assert!(binding["problems"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["code"] == "ASSET_DELETED"));
    let mut editing = old;
    editing["title"] = json!("still visible while fixing");
    editing["expectedVersion"] = editing["version"].clone();
    let updated = store.save_unit(editing).unwrap();
    let mut wrong = updated.clone();
    wrong["assetRefs"][0]["role"] = json!("new reference to deleted asset");
    assert!(store.save_unit(wrong).is_err());
    let mut repaired = updated;
    repaired["assetRefs"] = json!([reference("correct")]);
    let repaired = store.save_unit(repaired).unwrap();
    assert_eq!(repaired["assetRefs"][0]["assetId"], "correct");
    assert!(store.asset_usage("old").unwrap()["units"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn user_source_changes_reject_cycles_and_drop_old_design_references_atomically() {
    let (_temp, store) = fixture();
    let a = asset(&store, "a");
    let b = store.save_asset(json!({"id":"b","name":"b","variantId":"base","sourceAssetId":"a","prompt":"keep prompt","design":{"referenceAssetIds":["a"]},"referenceAssetIds":["a"]})).unwrap();
    let mut cycle = a.clone();
    cycle["expectedVersion"] = a["version"].clone();
    cycle["sourceAssetId"] = json!("b");
    assert!(store.save_asset_user(cycle).unwrap_err().contains("循环"));
    assert_eq!(store.get("assets", "a").unwrap(), a);
    store.set_asset_deleted("a", 1, true).unwrap();
    let mut repaired = b;
    repaired["expectedVersion"] = repaired["version"].clone();
    repaired["sourceAssetId"] = Value::Null;
    repaired["sourceVariantId"] = Value::Null;
    let repaired = store.save_asset_user(repaired).unwrap();
    assert!(repaired["design"].is_null());
    assert!(repaired["referenceAssetIds"].is_null());
    assert_eq!(repaired["prompt"], "keep prompt");
    assert_eq!(repaired["designStatus"], "needsDesign");
    let mut bad = repaired.clone();
    bad["expectedVersion"] = repaired["version"].clone();
    bad["sourceAssetId"] = json!("a");
    assert!(store.save_asset_user(bad).is_err());
    assert_eq!(store.get("assets", "b").unwrap(), repaired);
}

#[test]
fn user_scope_must_match_current_source_and_applicability_without_changing_legacy_imports() {
    let (_temp, store) = fixture();
    let source =
        pipeline::prepare_source("第1集\n场景：院子\n甲：来了。\n第2集\n场景：街口\n甲：走。")
            .unwrap();
    let source = store
        .save_source(serde_json::to_value(source).unwrap())
        .unwrap();
    let original = asset(&store, "a");
    let scene = &source["scenes"][0];
    let mut valid = original.clone();
    valid["expectedVersion"] = original["version"].clone();
    valid["scope"] = json!({"kind":"SCENES","scenes":[{"episodeId":scene["episodeId"],"sceneId":scene["id"]}],"reason":"confirmed in editor"});
    valid["applicability"] = json!({"episodes":[scene["episodeId"]],"scenes":[scene["id"]]});
    let updated = store.save_asset_user(valid).unwrap();
    let mut bad = updated.clone();
    bad["expectedVersion"] = updated["version"].clone();
    bad["scope"]["kind"] = json!("GLOBAL");
    assert!(store.save_asset_user(bad).unwrap_err().contains("不一致"));
    let mut bad = updated.clone();
    bad["expectedVersion"] = updated["version"].clone();
    bad["applicability"]["scenes"] = json!([source["scenes"][1]["id"]]);
    assert!(store.save_asset_user(bad).is_err());
    assert_eq!(store.get("assets", "a").unwrap(), updated);
    store.save_asset(json!({"id":"legacy","name":"legacy","kind":"UNCLASSIFIED","variantId":"legacy","needsReview":true})).unwrap();
}

#[test]
fn public_asset_commands_expose_deleted_history_and_enforce_user_identity_and_cas() {
    let temp = tempfile::tempdir().unwrap();
    let engine = Engine::new(temp.path().join("isolated-home")).unwrap();
    let workspace = engine
        .dispatch(json!({"action":"projects.create","title":"asset commands"}))
        .unwrap();
    let project = workspace["id"].clone();
    let workspace = engine.dispatch(json!({"action":"assets.save","projectId":project,"asset":{"id":"a","name":"manual test","variantId":"base"}})).unwrap();
    assert_eq!(workspace["assets"].as_array().unwrap().len(), 1);
    assert!(engine.dispatch(json!({"action":"assets.save","projectId":project,"asset":{"id":"a","name":"bad","variantId":"other","expectedVersion":1}})).unwrap_err().contains("身份"));
    let usage = engine
        .dispatch(json!({"action":"assets.usage","projectId":project,"assetId":"a"}))
        .unwrap();
    assert_eq!(usage["version"], 1);
    let deleted = engine
        .dispatch(
            json!({"action":"assets.delete","projectId":project,"assetId":"a","expectedVersion":1}),
        )
        .unwrap();
    assert!(deleted["assets"].as_array().unwrap().is_empty());
    assert_eq!(deleted["deletedAssets"][0]["id"], "a");
    assert!(engine
        .dispatch(
            json!({"action":"assets.restore","projectId":project,"assetId":"a","expectedVersion":1})
        )
        .is_err());
    let restored = engine.dispatch(json!({"action":"assets.restore","projectId":project,"assetId":"a","expectedVersion":2})).unwrap();
    assert_eq!(restored["assets"][0]["version"], 3);
    assert!(restored["deletedAssets"].as_array().unwrap().is_empty());
}
