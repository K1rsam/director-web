//! Rust executes Q1 scene declarations without rewriting source or another model.
use director_core::{pipeline::*, store::Store, workflow::guard_from_input};
use serde_json::{json, Value};

fn fixture() -> (LockedSource, FoundationProposal) {
    let source =
        prepare_source("第一集\r\n场景：门口\r\n甲：别动😀。\r\n△甲走入室内。\r\n甲：回来。\r\n")
            .unwrap();
    let scene = &source.scenes[0];
    let episode = &source.episodes[0];
    let proposal=serde_json::from_value(json!({
        "schemaVersion":"foundation/v1","sourceSha256":source.sha256,"overview":"","direction":"","episodes":[],"facts":[],
        "updatedEpisodeIds":[episode.id],
        "assets":[{"id":"a","name":"甲","kind":"CH","sourceRefs":[source.rows[2].id],"aliases":[],"description":"人物","variants":[
            {"id":"v","name":"基础","description":"人物","sourceRefs":[source.rows[2].id,source.rows[3].id],"sourceVariantId":null,
            "scope":{"kind":"SCENES","scenes":[{"episodeId":episode.id,"sceneId":scene.id}],"reason":null},"applicability":[{"episodeId":episode.id,"sceneId":scene.id}]}]}],
        "issues":[{"problem":"程序拆场","coordinate":"scene","blocking":false,"sourceRefs":[source.rows[3].id],"episodeIds":[episode.id],
          "details":{"owner":"PROGRAM","planKind":"sceneSplit","plan":{"episodeId":episode.id,"sceneId":scene.id,"cuts":[{"rowId":source.rows[3].id,"anchor":"△甲走入室内。"}]}}}]
    })).unwrap();
    (source, proposal)
}

#[test]
fn q1_split_preserves_original_coordinates_and_reprojects_variant_scope() {
    let (source, mut p) = fixture();
    let out = execute_foundation_scene_edits(&source, &mut p)
        .unwrap()
        .unwrap();
    assert_eq!(out.text, source.text);
    assert_eq!(out.sha256, source.sha256);
    assert_eq!(out.scenes.len(), 2);
    assert_eq!(p.assets[0].variants[0].scope.scenes.len(), 2);
    for (old, new) in source.rows.iter().zip(&out.rows) {
        assert_eq!(old.text, new.text);
        assert_eq!(old.range, new.range);
        assert_eq!(
            serde_json::to_value(&old.dialogue).unwrap(),
            serde_json::to_value(&new.dialogue).unwrap()
        );
    }
    assert!(p.issues.is_empty());
    validate_source(&out).unwrap();
    validate_foundation(&out, &p).unwrap();
    assert!(execute_foundation_scene_edits(&out, &mut p)
        .unwrap()
        .is_none());
    let mut tampered = out.clone();
    tampered.scene_edits[0]["plan"]["cuts"][0]["anchor"] = json!("模型改词");
    assert!(validate_source(&tampered).is_err());
}

#[test]
fn bad_anchor_and_outside_scope_are_rejected_before_publication() {
    let (source, mut p) = fixture();
    p.issues[0].details.as_mut().unwrap()["plan"]["cuts"][0]["anchor"] = json!("△甲走进室内。");
    assert!(execute_foundation_scene_edits(&source, &mut p).is_err());
    let (_, mut p) = fixture();
    p.updated_episode_ids.clear();
    assert!(execute_foundation_scene_edits(&source, &mut p).is_err());
}

fn setup(store: &Store, source: &LockedSource) -> Value {
    store.create("隔离场次验收", "scene-test").unwrap();
    store
        .save_source(serde_json::to_value(source).unwrap())
        .unwrap();
    guard_from_input(
        &json!({"source":store.source().unwrap(),"foundation":store.foundation().unwrap(),"assets":[],"existingUnits":[],"selection":{"episodeIds":[source.episodes[0].id]}}),
    )
}

#[test]
fn source_and_foundation_publish_together_and_failure_rolls_back_both() {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::open(temp.path().join("project")).unwrap();
    let (source, mut p) = fixture();
    let guard = setup(&store, &source);
    let revised = execute_foundation_scene_edits(&source, &mut p)
        .unwrap()
        .unwrap();
    let assets = flatten_foundation_assets(&p);
    let mut invalid = assets.clone();
    invalid[0] = Value::Null;
    assert!(store
        .publish_foundation_with_source(&guard, json!(p), invalid, None, Some(json!(revised)))
        .is_err());
    assert_eq!(store.source().unwrap()["version"], 1);
    assert!(store.foundation().unwrap().is_null());
    let result = store
        .publish_foundation_with_source(&guard, json!(p), assets, None, Some(json!(revised)))
        .unwrap();
    assert_eq!(result["sourceVersion"], 2);
    assert_eq!(store.source().unwrap()["version"], 2);
    assert_eq!(store.source().unwrap()["sha256"], source.sha256);
    assert_eq!(store.values("assets").unwrap().len(), 1);
    assert!(store
        .publish_foundation_with_source(&guard, json!(p), vec![], None, None)
        .is_err());
    assert_eq!(store.source().unwrap()["version"], 2);
}
