use crate::{
    pipeline,
    store::{s, Store},
    workflow::guard_from_input,
};
use serde_json::{json, Value};

fn project() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().to_owned()).unwrap();
    store.create("制作流程验收", "test").unwrap();
    let source = pipeline::prepare_source(
        "第1集\n场景：门口\n小王：别动。\n第2集\n场景：门口\n小王：我知道。\n",
    )
    .unwrap();
    store
        .save_source(serde_json::to_value(source).unwrap())
        .unwrap();
    (dir, store)
}
fn input(store: &Store) -> Value {
    json!({"source":store.source().unwrap(),"foundation":store.foundation().unwrap(),"assets":store.values("assets").unwrap(),"existingUnits":store.values("units").unwrap(),"selection":{"episodeIds":store.source().unwrap()["episodes"].as_array().unwrap().iter().map(|e|e["id"].clone()).collect::<Vec<_>>()},"capabilities":{"version":"test"}})
}
fn unit(store: &Store, id: &str, episode: usize) -> Value {
    json!({"id":id,"episodeId":store.source().unwrap()["episodes"][episode]["id"],"title":id,"prompt":"原话与完整演出","duration":4,"assetRefs":[],"exitState":"站在门口"})
}

#[test]
fn partial_episode_drafts_do_not_retire_or_replace_the_existing_complete_episode() {
    let (_dir,store)=project();
    let old=store.save_unit(unit(&store,"old-complete",0)).unwrap();
    let frozen=input(&store);let guard=guard_from_input(&frozen);
    let draft=unit(&store,"new-first-batch",0);
    let output=json!({"scope":"episodes","status":"partially_blocked","updatedEpisodeIds":[],"units":[draft],"blocked":[{"reason":"后批失败"}]});
    store.publish_storyboard(&guard,&output,&frozen,None).unwrap();
    assert_eq!(store.values("units").unwrap(),vec![old]);
}

#[test]
fn completed_episode_can_publish_while_the_failed_episode_keeps_old_units() {
    let (_dir,store)=project();
    store.save_unit(unit(&store,"old-first",0)).unwrap();
    let failed=store.save_unit(unit(&store,"old-second",1)).unwrap();
    let frozen=input(&store);let guard=guard_from_input(&frozen);
    let ready=unit(&store,"new-first",0);let incomplete=unit(&store,"new-second-part",1);
    let output=json!({"scope":"episodes","status":"partially_blocked","updatedEpisodeIds":[ready["episodeId"]],"units":[ready,incomplete]});
    store.publish_storyboard(&guard,&output,&frozen,None).unwrap();
    assert_eq!(store.get("units","old-second").unwrap(),failed);
    assert!(store.get("units","new-second-part").is_err());
    assert_eq!(store.get("units","old-first").unwrap()["retired"],true);
    assert_eq!(store.get("units","new-first").unwrap()["title"],"new-first");
}

#[test]
fn foundation_publication_preserves_design_and_media_and_is_atomic() {
    let (_dir, store) = project();
    let asset = store
        .save_asset(
            json!({"id":"actor","variantId":"base","prompt":"已确认服装与形象","name":"小王"}),
        )
        .unwrap();
    let image = store.root.join("fixture.png");
    image::RgbImage::new(2, 2).save(&image).unwrap();
    let media = store
        .import_media(&image, "image", Some("actor"), Some("base"))
        .unwrap();
    store.adopt("actor", "base", s(&media, "id")).unwrap();
    let frozen = input(&store);
    let guard = guard_from_input(&frozen);
    let foundation = json!({"episodes":[],"assets":[],"facts":[],"direction":"方向"});
    store.publish_foundation(&guard,foundation.clone(),vec![json!({"id":"actor","variantId":"base","prompt":"","name":"小王","identityId":"person"})],None).unwrap();
    assert_eq!(
        store.get("assets", "actor").unwrap()["prompt"],
        asset["prompt"]
    );
    assert_eq!(
        store.adopted("actor", "base").unwrap().as_deref(),
        Some(s(&media, "id"))
    );
    let version = store.foundation().unwrap()["version"].clone();
    let frozen = input(&store);
    let guard = guard_from_input(&frozen);
    assert!(store
        .publish_foundation(
            &guard,
            json!({"direction":"坏批次"}),
            vec![json!("不是资产")],
            None
        )
        .is_err());
    assert_eq!(store.foundation().unwrap()["version"], version);
}
#[test]
fn changing_source_or_design_during_run_rejects_publication() {
    let (_dir, store) = project();
    store
        .save_asset(json!({"id":"actor","variantId":"base","prompt":"旧"}))
        .unwrap();
    let frozen = input(&store);
    let guard = guard_from_input(&frozen);
    let mut asset = store.get("assets", "actor").unwrap();
    asset["prompt"] = json!("新");
    store.save_asset(asset).unwrap();
    assert!(store
        .publish_foundation(&guard, json!({"direction":"不能覆盖"}), vec![], None)
        .is_err());
    assert!(store.foundation().unwrap().is_null());
    let frozen = input(&store);
    let guard = guard_from_input(&frozen);
    let mut source = store.source().unwrap();
    source["sha256"] = json!("新源");
    store.save_source(source).unwrap();
    assert!(store
        .publish_foundation(&guard, json!({}), vec![], None)
        .is_err());
}
#[test]
fn selected_episode_replacement_retires_old_units_but_keeps_history() {
    let (_dir, store) = project();
    store.save_unit(unit(&store, "old", 0)).unwrap();
    store.save_unit(unit(&store, "other", 1)).unwrap();
    let mut frozen = input(&store);
    frozen["selection"]["episodeIds"] = json!([store.source().unwrap()["episodes"][0]["id"]]);
    let guard = guard_from_input(&frozen);
    let output = json!({"units":[unit(&store,"new",0)],"scope":"episodes","status":"completed"});
    store
        .publish_storyboard(&guard, &output, &frozen, None)
        .unwrap();
    let ids: Vec<_> = store
        .values("units")
        .unwrap()
        .into_iter()
        .map(|u| s(&u, "id").to_owned())
        .collect();
    assert_eq!(ids, vec!["other", "new"]);
    assert_eq!(store.get("units", "old").unwrap()["retired"], true);
    assert_eq!(
        store.unit_versions("old").unwrap()["versions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn partial_unit_revision_does_not_retire_unselected_siblings() {
    let (_dir, store) = project();
    store.save_unit(unit(&store, "first", 0)).unwrap();
    store.save_unit(unit(&store, "second", 0)).unwrap();
    let mut frozen = input(&store);
    frozen["selection"]["unitIds"] = json!(["first"]);
    let guard = guard_from_input(&frozen);
    store.publish_storyboard(&guard,&json!({"units":[unit(&store,"replacement",0)],"scope":"units","replacedUnitIds":["first"]}),&frozen,None).unwrap();
    assert!(store
        .values("units")
        .unwrap()
        .iter()
        .any(|u| u["id"] == "second"));
}
#[test]
fn accepted_steps_survive_reopen_and_workflow_publication_guard_survives_partial_publish() {
    let (dir, store) = project();
    store.ensure_workflow_storage().unwrap();
    let frozen = input(&store);
    let guard = guard_from_input(&frozen);
    let run = store
        .add_job(
            "workflow",
            "storyboard.run",
            "local",
            "local",
            &json!({"runnerVersion":"desktop-runner/v1","input":frozen,"guard":guard}),
            "running",
        )
        .unwrap();
    store
        .checkpoint(
            &run,
            "plan:ep1",
            "storyboardPlan",
            "hash",
            "accepted",
            None,
            Some(&json!({"events":[]})),
            None,
        )
        .unwrap();
    let output = json!({"units":[unit(&store,"new",0)],"status":"waiting_decision","waitingDecision":{"episodeId":"next","candidates":[]}});
    store
        .publish_storyboard(&guard, &output, &frozen, Some(&run))
        .unwrap();
    drop(store);
    let reopened = Store::open(dir.path().to_owned()).unwrap();
    assert!(reopened.accepted_step(&run, "hash").unwrap().is_some());
    assert_eq!(reopened.job(&run).unwrap()["status"], "waiting_decision");
    let guard = reopened.job(&run).unwrap()["prepared"]["publicationGuard"].clone();
    assert_eq!(guard["units"]["new"], 1);
    let mut c = reopened.conn().unwrap();
    let tx = c.transaction().unwrap();
    crate::workflow::verify_guard(&tx, &guard).unwrap();
}
#[test]
fn user_changes_to_selected_units_prevent_late_publication_and_unchanged_saves_do_not_bump() {
    let (_dir, store) = project();
    let original = store.save_unit(unit(&store, "u", 0)).unwrap();
    assert_eq!(store.save_unit(original.clone()).unwrap()["version"], 1);
    let frozen = input(&store);
    let guard = guard_from_input(&frozen);
    let mut edited = original;
    edited["prompt"] = json!("用户手改");
    store.save_unit(edited).unwrap();
    assert!(store
        .publish_storyboard(
            &guard,
            &json!({"units":[unit(&store,"u",0)]}),
            &frozen,
            None
        )
        .is_err());
    assert_eq!(store.get("units", "u").unwrap()["prompt"], "用户手改");
}
#[test]
fn explicit_direction_is_versioned_and_rejects_stale_editor() {
    let (_dir, store) = project();
    let source_version = store.source().unwrap()["version"].as_i64().unwrap();
    store
        .save_production_direction("克制表演", source_version, Some(0))
        .unwrap();
    assert_eq!(
        store.foundation().unwrap()["productionDirection"],
        "克制表演"
    );
    assert!(store
        .save_production_direction("旧编辑器的方向", source_version, Some(0))
        .is_err());
}

#[test]
fn foundation_rebuild_retains_confirmed_direction() {
    let (_dir, store) = project();
    let sv = store.source().unwrap()["version"].as_i64().unwrap();
    store
        .save_production_direction("自然、克制", sv, Some(0))
        .unwrap();
    let frozen = input(&store);
    store
        .publish_foundation(
            &guard_from_input(&frozen),
            json!({"direction":"模型提案","assets":[],"episodes":[],"facts":[]}),
            vec![],
            None,
        )
        .unwrap();
    assert_eq!(
        store.foundation().unwrap()["productionDirection"],
        "自然、克制"
    );
    assert_eq!(store.foundation().unwrap()["directionConfirmed"], true);
}

#[test]
fn revision_expands_required_scope_and_versions_only_affected_continuity() {
    let (_dir, store) = project();
    let frozen = input(&store);
    store
        .publish_storyboard(
            &guard_from_input(&frozen),
            &json!({"units":[unit(&store,"a",0),unit(&store,"b",0),unit(&store,"c",1)]}),
            &frozen,
            None,
        )
        .unwrap();
    let mut frozen = input(&store);
    frozen["selection"]["unitIds"] = json!(["a"]);
    let mut replacement = unit(&store, "merged", 0);
    replacement["exitState"] = json!("已出门");
    store.publish_storyboard(&guard_from_input(&frozen),&json!({"units":[replacement],"scope":"units","replacedUnitIds":["a","b"],"continuityImpacts":[{"nextUnitId":"c"}]}),&frozen,None).unwrap();
    assert_eq!(store.get("units", "a").unwrap()["retired"], true);
    assert_eq!(store.get("units", "b").unwrap()["retired"], true);
    let c = store.get("units", "c").unwrap();
    assert_eq!(c["continuityStale"], true);
    assert_eq!(c["version"], 2);
    assert_eq!(c["prompt"], "原话与完整演出");
    store.invalidate_unit_dependents("merged").unwrap();
    assert_eq!(
        store.get("units", "c").unwrap()["version"],
        2,
        "already stale is a no-op"
    );
    let previous: String = store
        .conn()
        .unwrap()
        .query_row(
            "SELECT dependency_id FROM unit_dependencies WHERE unit_id='c'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(previous, "merged");
}

#[test]
fn incomplete_text_recovers_separately_from_unknown_media_submission() {
    let (_dir, store) = project();
    store.ensure_workflow_storage().unwrap();
    let run = store
        .add_job(
            "workflow",
            "storyboard.run",
            "local",
            "local",
            &json!({}),
            "running",
        )
        .unwrap();
    let text = store
        .add_job("text", "step", "codex", "local", &json!({}), "received")
        .unwrap();
    store
        .update_job(
            &text,
            "received",
            &json!({"result":{"raw":"保留待校验原回包"}}),
        )
        .unwrap();
    store
        .checkpoint(
            &run,
            "step",
            "storyboardCreate",
            "hash",
            "running",
            Some(&text),
            None,
            None,
        )
        .unwrap();
    let image = store
        .add_job(
            "image",
            "actor",
            "offline",
            "local",
            &json!({}),
            "submitting",
        )
        .unwrap();
    store.recover_interrupted().unwrap();
    assert_eq!(store.job(&run).unwrap()["status"], "interrupted");
    assert_eq!(store.job(&text).unwrap()["status"], "interrupted");
    assert_eq!(
        store.job(&text).unwrap()["result"]["raw"],
        "保留待校验原回包"
    );
    assert!(store.accepted_step(&run, "hash").unwrap().is_none());
    assert_eq!(store.job(&image).unwrap()["status"], "submission_unknown");
}

#[test]
fn adding_asset_during_creation_does_not_overwrite_the_new_catalog_entry() {
    let (_dir, store) = project();
    let frozen = input(&store);
    let guard = guard_from_input(&frozen);
    store
        .save_asset(json!({"id":"new-user-asset","variantId":"base","name":"用户新建"}))
        .unwrap();
    assert!(store
        .publish_foundation(
            &guard,
            json!({}),
            vec![json!({"id":"new-user-asset","variantId":"base","name":"旧模型回包"})],
            None
        )
        .is_err());
    assert_eq!(
        store.get("assets", "new-user-asset").unwrap()["name"],
        "用户新建"
    );
}

#[test]
fn foundation_publication_counts_active_assets_and_does_not_restore_deleted_rows() {
    let (_dir, store) = project();
    let original = store.save_asset(json!({"id":"removed","variantId":"base","name":"测试资产","prompt":"保留历史图片提示词"})).unwrap();
    let deleted = store
        .set_asset_deleted("removed", original["version"].as_i64().unwrap(), true)
        .unwrap();
    let mut frozen = input(&store);
    assert!(frozen["assets"].as_array().unwrap().is_empty());
    // Older frozen input can include a tombstone; the current guard counts only live rows.
    frozen["assets"] = json!([deleted]);
    let guard = guard_from_input(&frozen);
    assert_eq!(guard["assets"], json!({}));
    store
        .publish_foundation(
            &guard,
            json!({"assets":[{"id":"prior-source-identity"}],"episodes":[],"facts":[]}),
            vec![original],
            None,
        )
        .unwrap();
    let current = store.get("assets", "removed").unwrap();
    assert_eq!(
        current, deleted,
        "a stale foundation proposal must not change or restore a deleted asset"
    );
    assert!(store.values("assets").unwrap().is_empty());
    let versions: i64 = store
        .conn()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM asset_versions WHERE asset_id='removed'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(versions, 2);
}

#[test]
fn deleting_asset_during_creation_rejects_late_publication_without_changing_snapshot() {
    let (_dir, store) = project();
    let original = store
        .save_asset(json!({"id":"removed","variantId":"base","name":"测试资产"}))
        .unwrap();
    let frozen = input(&store);
    let guard = guard_from_input(&frozen);
    let deleted = store
        .set_asset_deleted("removed", original["version"].as_i64().unwrap(), true)
        .unwrap();
    let error = store
        .publish_foundation(
            &guard,
            json!({"direction":"过期模型输出"}),
            vec![original],
            None,
        )
        .unwrap_err();
    assert!(error.contains("已更新"));
    assert_eq!(store.get("assets", "removed").unwrap(), deleted);
    assert!(store.foundation().unwrap().is_null());
    assert_eq!(
        frozen["assets"][0]["version"], 1,
        "submitted frozen inputs remain immutable"
    );
}
