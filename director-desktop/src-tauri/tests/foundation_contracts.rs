//! Stage 1 source/identity/range acceptance. Uses only an in-memory text executor.
use director_core::pipeline::*;
use serde_json::{json, Value};
use std::sync::Mutex;

#[derive(Default)]
struct FoundationModel {
    requests: Mutex<Vec<Value>>,
    accepted: Mutex<Vec<Value>>,
    rejected: Mutex<Vec<Value>>,
    mode: &'static str,
}
#[async_trait::async_trait]
impl TextExecutor for FoundationModel {
    async fn execute(&self, r: TextRequest) -> Result<Value, String> {
        self.requests.lock().unwrap().push(r.input.clone());
        let input = &r.input;
        let episode = &input["episode"];
        let row = input["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["kind"] == "body")
            .unwrap();
        let asset=input["knownAssets"].as_array().unwrap().first().cloned().unwrap_or(json!({"id":"person","name":"甲","kind":"CH","aliases":[],"variants":[{"id":"base","name":"基础","sourceVariantId":null}]}));
        let variant = &asset["variants"][0];
        let name = if self.mode == "identity_change" {
            json!("另一人")
        } else {
            asset["name"].clone()
        };
        let first_appearance = input["knownAssets"].as_array().unwrap().is_empty();
        let scope = if self.mode == "global_without_evidence" {
            json!({"kind":"GLOBAL","scenes":[],"reason":null})
        } else if self.mode == "unresolved" || self.mode == "variant_resolve" && first_appearance {
            json!({"kind":"UNRESOLVED","scenes":[],"reason":"当前只提到计划，尚未实际出现"})
        } else {
            json!({"kind":"SCENES","scenes":[{"episodeId":episode["id"],"sceneId":episode["sceneIds"][0]}],"reason":null})
        };
        let variant_name = match self.mode {
            "variant_resolve" if first_appearance => json!("计分手表待定位形象"),
            "variant_resolve" => json!("计分手表基础形象"),
            "variant_label_drift" => json!("另一种展示写法"),
            _ => variant["name"].clone(),
        };
        let parent = if self.mode == "variant_parent_change" {
            json!("other-base")
        } else {
            variant["sourceVariantId"].clone()
        };
        let refs = if self.mode == "unknown_reference" {
            json!(["not-provided"])
        } else if self.mode == "scope_without_own_evidence" {
            json!([input["rows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["sceneId"].is_null() && row["episodeId"] == episode["id"])
                .unwrap()["id"]])
        } else {
            json!([row["id"]])
        };
        let episode_refs = if self.mode == "public_context" {
            input["rows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["kind"] == "context" && r["episodeId"].is_null())
                .map(|context| json!([context["id"], row["id"]]))
                .unwrap_or_else(|| refs.clone())
        } else {
            refs.clone()
        };
        Ok(
            json!({"schemaVersion":"foundation/v1","sourceSha256":input["sourceSha256"],"overview":"当前制作资料","direction":"模型擅自提出的新方向","episodes":[{"episodeId":episode["id"],"summary":format!("{}已整理",episode["id"]),"context":"必要前情","sourceRefs":episode_refs}],"assets":[{"id":asset["id"],"name":name,"kind":asset["kind"],"aliases":[],"description":"主体","sourceRefs":refs,"variants":[{"id":variant["id"],"name":variant_name,"description":"本批有据形象","sourceVariantId":parent,"sourceRefs":refs,"applicability":scope["scenes"],"scope":scope,"assetRowId":"must-not-trust-model-row-id"}]}],"facts":[{"id":format!("fact:{}",episode["id"]),"assetId":asset["id"],"variantId":if self.mode=="unbound_state"{Value::Null}else{variant["id"].clone()},"attribute":"外形","value":"本批事实","scope":if self.mode=="unbound_state"{"STATE"}else{"STABLE"},"claim":"SOURCE","sourceRefs":refs,"quotes":["模型伪造引句"]}],"issues":[]}),
        )
    }
    async fn accept(&self, _: &TextRequest, value: &Value) -> Result<(), String> {
        self.accepted.lock().unwrap().push(value.clone());
        Ok(())
    }
    async fn reject(&self, _: &TextRequest, value: &Value, reason: &str) -> Result<(), String> {
        self.rejected
            .lock()
            .unwrap()
            .push(json!({"original":value,"reason":reason}));
        Ok(())
    }
}
fn source() -> LockedSource {
    prepare_source("作者资料：人物身份由正文确认。\r\n第一集\r\n场景：门口\r\n甲（低声）：（拉门）走吧😀（停顿），别回头。\r\n第二集\r\n场景：室内\r\n甲：门已经关了。\r\n").unwrap()
}
async fn run(
    s: &LockedSource,
    c: &Value,
    m: &FoundationModel,
) -> Result<FoundationProposal, String> {
    run_foundation(s, c, m, "offline-text-model", "medium").await
}

fn episode_evidence_proposal(s: &LockedSource, refs: Vec<String>) -> FoundationProposal {
    serde_json::from_value(json!({
        "schemaVersion":"foundation/v1", "sourceSha256":s.sha256,
        "overview":"制作资料", "direction":"制作方向",
        "episodes":[{"episodeId":s.episodes[0].id,"summary":"本集事件","context":"背景资料","sourceRefs":refs}],
        "assets":[], "facts":[], "issues":[]
    }))
    .unwrap()
}

#[tokio::test]
async fn unlocated_appearance_can_gain_a_concrete_label_without_creating_a_new_identity() {
    let s = source();
    let before = serde_json::to_value(&s).unwrap();
    let model = FoundationModel {
        mode: "variant_resolve",
        ..Default::default()
    };
    let p = run(&s, &json!({}), &model).await.unwrap();
    assert_eq!(p.assets.len(), 1);
    let variant = &p.assets[0].variants[0];
    assert_eq!(p.assets[0].variants.len(), 1);
    assert_eq!(variant.id, "base");
    assert_eq!(variant.name, "计分手表基础形象");
    assert_eq!(variant.source_variant_id, None);
    assert_eq!(variant.scope.kind, "SCENES");
    assert_eq!(variant.scope.reason, None);
    assert_eq!(variant.scope.scenes.len(), 1);
    assert_eq!(variant.scope.scenes[0].episode_id, s.episodes[1].id);
    assert_eq!(variant.source_refs.len(), 2);
    assert_eq!(model.accepted.lock().unwrap().len(), 2);
    assert!(model.rejected.lock().unwrap().is_empty());
    assert_eq!(serde_json::to_value(&s).unwrap(), before);
}

#[tokio::test]
async fn rerun_does_not_unlock_resolved_labels_or_borrow_old_scene_evidence() {
    let s = source();
    let selection = json!({"episodeIds":[s.episodes[1].id]});
    let old = run(
        &s,
        &json!({"selection":selection}),
        &FoundationModel::default(),
    )
    .await
    .unwrap();
    let context = json!({"foundation":old,"selection":selection});
    let drift = FoundationModel {
        mode: "variant_label_drift",
        ..Default::default()
    };
    let p = run(&s, &context, &drift).await.unwrap();
    assert_eq!(p.assets[0].variants[0].name, "基础");
    assert_eq!(p.assets[0].variants[0].scope.scenes.len(), 1);
    let bad = FoundationModel {
        mode: "scope_without_own_evidence",
        ..Default::default()
    };
    assert!(run(&s, &context, &bad)
        .await
        .unwrap_err()
        .contains("本批适用场缺少本场来源"));
    assert!(bad.accepted.lock().unwrap().is_empty());
    let parent = FoundationModel {
        mode: "variant_parent_change",
        ..Default::default()
    };
    let error = run(&s, &context, &parent).await.unwrap_err();
    assert!(error.contains("派生来源发生变化"));
    assert!(error.contains("基础"));
    assert!(parent.accepted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn foundation_accepts_provided_public_background_without_reassigning_it_to_an_episode() {
    let s = source();
    let before = serde_json::to_value(&s).unwrap();
    let background = s
        .rows
        .iter()
        .find(|row| row.kind == "context" && row.episode_id.is_none())
        .unwrap();
    let model = FoundationModel {
        mode: "public_context",
        ..Default::default()
    };
    let proposal = run(&s, &json!({}), &model).await.unwrap();
    validate_foundation(&s, &proposal).unwrap();
    assert!(proposal.episodes[0].source_refs.contains(&background.id));
    assert!(proposal.episodes[0].source_refs.iter().any(|id| s
        .rows
        .iter()
        .any(|row| &row.id == id && row.episode_id.as_ref() == Some(&s.episodes[0].id))));
    assert_eq!(proposal.episodes.len(), s.episodes.len());
    assert_eq!(model.accepted.lock().unwrap().len(), s.episodes.len());
    assert!(model.rejected.lock().unwrap().is_empty());
    let requests = model.requests.lock().unwrap();
    assert!(requests[0]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == background.id));
    assert!(requests[1]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["kind"] != "context"));
    assert_eq!(serde_json::to_value(&s).unwrap(), before);
}

#[test]
fn public_background_does_not_allow_foreign_episode_unknown_or_duplicate_evidence() {
    let s = source();
    let context = s.rows.iter().find(|row| row.kind == "context").unwrap();
    let body = s
        .rows
        .iter()
        .find(|row| row.kind == "body" && row.episode_id.as_ref() == Some(&s.episodes[0].id))
        .unwrap();
    for kind in ["body", "format"] {
        let foreign = s
            .rows
            .iter()
            .find(|row| row.kind == kind && row.episode_id.as_ref() == Some(&s.episodes[1].id))
            .unwrap();
        let proposal = episode_evidence_proposal(
            &s,
            vec![context.id.clone(), body.id.clone(), foreign.id.clone()],
        );
        let error = validate_foundation(&s, &proposal).unwrap_err();
        assert!(error.contains("分集资料引用跨入未声明的别集"));
        assert!(error.contains(&s.episodes[0].title));
        assert!(error.contains(&s.episodes[1].title));
        assert!(error.contains(&foreign.id));
        assert!(error.contains(&format!("第 {} 行", foreign.number)));
    }
    for refs in [
        vec![context.id.clone(), "not-in-source".into()],
        vec![context.id.clone(), context.id.clone(), body.id.clone()],
        vec![],
    ] {
        let proposal = episode_evidence_proposal(&s, refs);
        assert!(validate_foundation(&s, &proposal).is_err());
    }
}

#[test]
fn unassigned_body_and_format_rows_are_not_treated_as_public_background() {
    for (prefix, kind) in [("\n", "format"), ("未声明集数的一段正文。\n", "body")] {
        let s = prepare_source(&format!("{prefix}第一集\n场景：门口\n甲：走吧。\n")).unwrap();
        validate_source(&s).unwrap();
        let unassigned = &s.rows[0];
        assert_eq!(unassigned.kind, kind);
        assert!(unassigned.episode_id.is_none());
        let body = s
            .rows
            .iter()
            .find(|row| row.kind == "body" && row.episode_id.is_some())
            .unwrap();
        let proposal = episode_evidence_proposal(&s, vec![unassigned.id.clone(), body.id.clone()]);
        let error = validate_foundation(&s, &proposal).unwrap_err();
        assert!(error.contains("未定位且非公共背景"));
        assert!(error.contains(&unassigned.id));
    }
}

#[test]
#[ignore = "requires an external read-only response snapshot; validation only, no generation"]
fn actual_saved_foundation_result_accepts_locked_public_background() {
    let path = std::env::var("STAGE1_REPLAY_RESULT").expect("external response fixture path");
    let fixture: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let s: LockedSource = serde_json::from_value(fixture["source"].clone()).unwrap();
    let proposal: FoundationProposal = serde_json::from_value(fixture["result"].clone()).unwrap();
    let source_before = serde_json::to_value(&s).unwrap();
    assert_eq!(fixture["error"], "分集资料引用跨入未声明的别集");
    assert!(proposal
        .episodes
        .iter()
        .any(|episode| episode.source_refs.iter().any(|id| s
            .rows
            .iter()
            .any(|row| &row.id == id && row.kind == "context" && row.episode_id.is_none()))));
    validate_foundation(&s, &proposal).unwrap();
    assert_eq!(serde_json::to_value(&s).unwrap(), source_before);
}

#[test]
fn spoken_and_performance_parts_keep_absolute_utf16_and_exact_original() {
    let s = source();
    validate_source(&s).unwrap();
    let d = s.rows.iter().find_map(|r| r.dialogue.as_ref()).unwrap();
    assert_eq!(d.quote, "（拉门）走吧😀（停顿），别回头。");
    assert_eq!(spoken_text(d), "走吧😀，别回头。");
    assert_eq!(
        d.performance_segments
            .iter()
            .map(|p| p.text.as_str())
            .collect::<Vec<_>>(),
        vec!["（低声）", "（拉门）", "（停顿）"]
    );
    for p in d.spoken_segments.iter().chain(&d.performance_segments) {
        assert_eq!(slice_utf16(&s.text, &p.range).unwrap(), p.text);
    }
    assert_eq!(
        s.rows.iter().map(|r| r.text.as_str()).collect::<String>(),
        s.text
    );
    assert_eq!(s.sha256, digest(&s.text));
}

#[test]
fn literal_quoted_parentheses_are_spoken_and_nested_direction_stays_complete() {
    let s =
        prepare_source("第一集\n场景：门口\n甲：他说“（原文）”（压低声音（但不改词））继续。\n")
            .unwrap();
    let d = s.rows[2].dialogue.as_ref().unwrap();
    assert_eq!(spoken_text(d), "他说“（原文）”继续。");
    assert_eq!(d.performance_segments[0].text, "（压低声音（但不改词））");
    validate_source(&s).unwrap();
}

#[test]
fn old_sources_are_reparsed_but_existing_forged_new_fields_are_rejected() {
    let canonical = source();
    let mut old = serde_json::to_value(&canonical).unwrap();
    for r in old["rows"].as_array_mut().unwrap() {
        if let Some(d) = r["dialogue"].as_object_mut() {
            d.remove("spokenSegments");
            d.remove("performanceSegments");
        }
    }
    let old: LockedSource = serde_json::from_value(old).unwrap();
    validate_source(&old).unwrap();
    let upgraded = upgrade_source_dialogues(&old).unwrap();
    assert_eq!(
        serde_json::to_value(&upgraded).unwrap(),
        serde_json::to_value(&canonical).unwrap()
    );
    let mut changed = upgraded;
    changed
        .rows
        .iter_mut()
        .find_map(|r| r.dialogue.as_mut())
        .unwrap()
        .spoken_segments[0]
        .text = "改词".into();
    assert!(validate_source(&changed).is_err());
    assert!(upgrade_source_dialogues(&changed).is_err());
}

#[tokio::test]
async fn first_run_reads_author_rows_once_materializes_quotes_and_accepts_only_valid_batches() {
    let s = source();
    let model = FoundationModel::default();
    let p = run(&s, &json!({}), &model).await.unwrap();
    assert_eq!(p.assets.len(), 1);
    assert_eq!(p.assets[0].variants.len(), 1);
    assert_eq!(p.assets[0].variants[0].scope.scenes.len(), 2);
    assert_eq!(
        p.updated_episode_ids,
        s.episodes.iter().map(|e| e.id.clone()).collect::<Vec<_>>()
    );
    let requests = model.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["kind"] == "context"));
    assert!(!requests[1]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["kind"] == "context"));
    let accepted = model.accepted.lock().unwrap();
    assert_eq!(accepted.len(), 2);
    assert!(model.rejected.lock().unwrap().is_empty());
    for v in accepted.iter() {
        let fact = &v["facts"][0];
        let row = s
            .rows
            .iter()
            .find(|r| r.id == fact["sourceRefs"][0])
            .unwrap();
        assert_eq!(fact["quotes"], json!([row.text]));
        assert!(v["assets"][0]["variants"][0]["assetRowId"].is_null());
    }
}

#[tokio::test]
async fn standalone_test_image_does_not_block_or_seed_source_foundation() {
    let s = source();
    let manual = json!({"id":"test-image-row","baseAssetId":"test-identity","variantId":"test-look","name":"林夏","kind":"character","prompt":"红发古装","sourceRefs":[],"version":3});
    let context = json!({"assets":[manual.clone()]});
    let model = FoundationModel::default();
    let p = run(&s, &context, &model).await.unwrap();
    assert_eq!(model.requests.lock().unwrap().len(), s.episodes.len());
    assert_eq!(model.requests.lock().unwrap()[0]["knownAssets"], json!([]));
    assert!(p
        .assets
        .iter()
        .all(|a| a.id != "test-identity" && a.name != "林夏"));
    assert_eq!(
        context["assets"][0], manual,
        "foundation must leave manual pictures untouched"
    );
    assert_eq!(model.accepted.lock().unwrap().len(), s.episodes.len());
}

#[tokio::test]
async fn source_bound_manual_types_are_normalized_without_changing_identity() {
    let s = source();
    let row = s.rows.iter().find(|r| r.kind == "body").unwrap();
    for (kind, canonical) in [
        ("character", "CH"),
        ("beast", "BEAST"),
        ("scene", "LOC"),
        ("prop", "PROP"),
        ("group", "GROUP"),
    ] {
        let model = FoundationModel::default();
        let context = json!({"assets":[{"id":"manual-row","baseAssetId":"explicit-owner","variantId":"explicit-look","name":"甲","kind":kind,"sourceRefs":[row.id]}],"selection":{"episodeIds":[s.episodes[0].id]}});
        let p = run(&s, &context, &model).await.unwrap();
        assert_eq!(p.assets[0].kind, canonical);
        assert_eq!(p.assets[0].id, "explicit-owner");
        assert_eq!(p.assets[0].variants[0].id, "explicit-look");
        assert_eq!(flatten_foundation_assets(&p)[0]["id"], "manual-row");
        assert_eq!(
            model.requests.lock().unwrap()[0]["knownAssets"][0]["kind"],
            canonical
        );
    }
}

#[tokio::test]
async fn source_bound_manual_evidence_stays_strict_and_errors_identify_the_asset() {
    let s = source();
    let row = s.rows.iter().find(|r| r.kind == "body").unwrap();
    for (kind, source_refs) in [
        ("unsupported", json!([row.id])),
        ("character", json!(["not-in-current-source"])),
        ("character", json!([row.id, row.id])),
    ] {
        let model = FoundationModel::default();
        let error = run(&s,&json!({"assets":[{"id":"manual-row","baseAssetId":"explicit-owner","variantId":"explicit-look","name":"有来源人物","kind":kind,"sourceRefs":source_refs}]}),&model).await.unwrap_err();
        assert!(error.contains("有来源人物"));
        if kind == "unsupported" {
            assert!(error.contains("有来源人物") && error.contains(kind));
        }
        assert!(
            model.requests.lock().unwrap().is_empty(),
            "invalid evidence must never be sent as registered source facts"
        );
    }
}

#[tokio::test]
async fn manual_assets_with_same_display_name_keep_distinct_registered_ids() {
    let s = source();
    let row = s.rows.iter().find(|r| r.kind == "body").unwrap();
    let rows:Vec<_>=["person-one","person-two"].iter().map(|id|json!({"id":format!("row-{id}"),"baseAssetId":id,"variantId":"base","name":"甲","kind":"character","sourceRefs":[row.id]})).collect();
    let model = FoundationModel::default();
    let p = run(
        &s,
        &json!({"assets":rows,"selection":{"episodeIds":[s.episodes[0].id]}}),
        &model,
    )
    .await
    .unwrap();
    assert_eq!(p.assets.len(), 2);
    assert_ne!(p.assets[0].id, p.assets[1].id);
    assert_eq!(
        model.requests.lock().unwrap()[0]["knownAssets"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let flat = flatten_foundation_assets(&p);
    assert_eq!(flat[0]["id"], "row-person-one");
    assert_eq!(flat[1]["id"], "row-person-two");
}

#[tokio::test]
async fn deleted_manual_rows_do_not_reenter_the_source_registry() {
    let s = source();
    let row = s.rows.iter().find(|r| r.kind == "body").unwrap();
    let model = FoundationModel::default();
    let p = run(&s,&json!({"assets":[{"id":"deleted-row","baseAssetId":"deleted-owner","variantId":"base","name":"删掉的人物","kind":"character","sourceRefs":[row.id],"deletedAt":"2026-10-04T00:00:00Z"}]}),&model).await.unwrap();
    assert_eq!(model.requests.lock().unwrap()[0]["knownAssets"], json!([]));
    assert!(p.assets.iter().all(|a| a.id != "deleted-owner"));
}

#[tokio::test]
async fn rebuilding_saved_foundation_after_asset_deletion_keeps_deleted_projection_inactive() {
    use director_core::{store::Store, workflow::guard_from_input};
    let temporary = tempfile::tempdir().unwrap();
    let store = Store::open(temporary.path().join("project")).unwrap();
    store.create("删除后的基础续跑", "offline").unwrap();
    let s = source();
    store
        .save_source(serde_json::to_value(&s).unwrap())
        .unwrap();
    let mut first = run(&s, &json!({}), &FoundationModel::default())
        .await
        .unwrap();
    first.assets[0].variants[0].asset_row_id = Some("existing-image-row".into());
    let input = json!({"source":store.source().unwrap(),"foundation":store.foundation().unwrap(),"assets":store.values("assets").unwrap(),"existingUnits":[],"selection":{"episodeIds":s.episodes.iter().map(|e|e.id.clone()).collect::<Vec<_>>()}});
    store
        .publish_foundation(
            &guard_from_input(&input),
            serde_json::to_value(&first).unwrap(),
            flatten_foundation_assets(&first),
            None,
        )
        .unwrap();
    let current = store.get("assets", "existing-image-row").unwrap();
    let removed = store
        .set_asset_deleted(
            "existing-image-row",
            current["version"].as_i64().unwrap(),
            true,
        )
        .unwrap();
    let input = json!({"source":store.source().unwrap(),"foundation":store.foundation().unwrap(),"assets":store.values("assets").unwrap(),"existingUnits":[],"selection":{"episodeIds":s.episodes.iter().map(|e|e.id.clone()).collect::<Vec<_>>()}});
    assert!(input["assets"].as_array().unwrap().is_empty());
    let model = FoundationModel::default();
    let next = run(&s, &input, &model).await.unwrap();
    let rows = flatten_foundation_assets(&next);
    assert_eq!(
        rows[0]["id"], "existing-image-row",
        "source identity keeps its program-owned row mapping"
    );
    store
        .publish_foundation(
            &guard_from_input(&input),
            serde_json::to_value(next).unwrap(),
            rows,
            None,
        )
        .unwrap();
    assert_eq!(store.get("assets", "existing-image-row").unwrap(), removed);
    assert!(store.values("assets").unwrap().is_empty());
    assert_eq!(model.requests.lock().unwrap().len(), s.episodes.len());
    assert_eq!(store.source().unwrap(), input["source"]);
}

#[tokio::test]
#[ignore = "requires an external read-only snapshot; mock executor only, no live generation"]
async fn actual_failed_source_snapshot_reaches_all_foundation_batches() {
    let path = std::env::var("STAGE1_REPLAY_INPUT").expect("external diagnostic fixture path");
    let input: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let source: LockedSource = serde_json::from_value(input["source"].clone()).unwrap();
    let source_before = serde_json::to_value(&source).unwrap();
    let assets_before = input["assets"].clone();
    let model = FoundationModel::default();
    let p = run(&source, &input, &model).await.unwrap();
    assert_eq!(p.episodes.len(), source.episodes.len());
    assert_eq!(model.requests.lock().unwrap().len(), source.episodes.len());
    assert_eq!(model.requests.lock().unwrap()[0]["knownAssets"], json!([]));
    assert_eq!(model.accepted.lock().unwrap().len(), source.episodes.len());
    assert_eq!(input["assets"], assets_before);
    assert_eq!(serde_json::to_value(&source).unwrap(), source_before);
}

#[tokio::test]
async fn local_rerun_keeps_other_episode_stable_identity_asset_row_and_confirmed_direction() {
    let s = source();
    let original = run(&s, &json!({}), &FoundationModel::default())
        .await
        .unwrap();
    let first = serde_json::to_value(&original.episodes[0]).unwrap();
    let mut rows = flatten_foundation_assets(&original);
    rows[0]["id"] = json!("existing-designed-asset-row");
    rows[0]["prompt"] = json!("已确认图片设计");
    let model = FoundationModel::default();
    let context = json!({"foundation":original,"assets":rows,"selection":{"episodeIds":[s.episodes[1].id]},"settings":{"confirmedDirection":"已确认的克制真人方向"}});
    let next = run(&s, &context, &model).await.unwrap();
    assert_eq!(next.direction, "已确认的克制真人方向");
    assert_eq!(next.updated_episode_ids, vec![s.episodes[1].id.clone()]);
    assert_eq!(
        serde_json::to_value(
            next.episodes
                .iter()
                .find(|e| e.episode_id == s.episodes[0].id)
                .unwrap()
        )
        .unwrap(),
        first
    );
    assert_eq!(next.assets[0].id, "person");
    assert_eq!(next.assets[0].variants[0].id, "base");
    assert_eq!(next.assets[0].variants[0].scope.scenes.len(), 2);
    let flat = flatten_foundation_assets(&next);
    assert_eq!(flat[0]["id"], "existing-designed-asset-row");
    assert_eq!(flat[0]["identityId"], "person");
    assert!(flat[0].get("prompt").is_none());
    assert_eq!(model.requests.lock().unwrap().len(), 1);
    assert_eq!(
        model.requests.lock().unwrap()[0]["confirmedDirection"],
        "已确认的克制真人方向"
    );
}

#[tokio::test]
async fn unresolved_shape_is_preserved_and_unbound_state_is_local_issue_not_broadcast_fact() {
    let s = source();
    let selected = json!({"selection":{"episodeIds":[s.episodes[0].id]}});
    let p = run(
        &s,
        &selected,
        &FoundationModel {
            mode: "unresolved",
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        flatten_foundation_assets(&p)[0]["scope"]["kind"],
        "UNRESOLVED"
    );
    let model = FoundationModel {
        mode: "unbound_state",
        ..Default::default()
    };
    let p = run(&s, &selected, &model).await.unwrap();
    assert!(p.facts.is_empty());
    assert_eq!(p.issues.len(), 1);
    assert!(p.issues[0].blocking);
    assert_eq!(p.issues[0].asset_id.as_deref(), Some("person"));
    assert_eq!(p.issues[0].episode_ids, vec![s.episodes[0].id.clone()]);
    assert_eq!(
        p.issues[0].details.as_ref().unwrap()["unresolvedFact"]["scope"],
        "STATE"
    );
    assert_eq!(model.accepted.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn invalid_scope_reference_identity_and_selection_never_receive_acceptance() {
    let s = source();
    let selected = json!({"selection":{"episodeIds":[s.episodes[0].id]}});
    for mode in ["global_without_evidence", "unknown_reference"] {
        let model = FoundationModel {
            mode,
            ..Default::default()
        };
        assert!(run(&s, &selected, &model).await.is_err());
        assert!(model.accepted.lock().unwrap().is_empty());
        assert_eq!(model.rejected.lock().unwrap().len(), 1);
    }
    let original = run(&s, &selected, &FoundationModel::default())
        .await
        .unwrap();
    let model = FoundationModel {
        mode: "identity_change",
        ..Default::default()
    };
    assert!(run(
        &s,
        &json!({"foundation":original,"selection":selected["selection"]}),
        &model
    )
    .await
    .is_err());
    assert!(model.accepted.lock().unwrap().is_empty());
    assert_eq!(model.rejected.lock().unwrap().len(), 1);
    for selection in [
        json!([]),
        json!(["missing"]),
        json!([s.episodes[0].id, s.episodes[0].id]),
    ] {
        let model = FoundationModel::default();
        assert!(
            run(&s, &json!({"selection":{"episodeIds":selection}}), &model)
                .await
                .is_err()
        );
        assert!(model.requests.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn same_base_variant_label_in_different_identities_is_not_an_identity_collision() {
    let s = source();
    let mut p = run(
        &s,
        &json!({"selection":{"episodeIds":[s.episodes[0].id]}}),
        &FoundationModel::default(),
    )
    .await
    .unwrap();
    let mut other = p.assets[0].clone();
    other.id = "different-person".into();
    other.name = "同名甲".into();
    p.assets.push(other);
    validate_foundation(&s, &p).unwrap();
    let rows = flatten_foundation_assets(&p);
    assert_ne!(rows[0]["id"], rows[1]["id"]);
    assert_eq!(rows[0]["variantId"], rows[1]["variantId"]);
}
