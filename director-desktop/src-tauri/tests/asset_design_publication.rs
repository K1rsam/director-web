//! Design and visual-fact checkpoints publish atomically with optimistic versions.
use director_core::{pipeline, store::Store};
use serde_json::{json, Value};
fn fixture() -> (tempfile::TempDir, Store, Value, Value) {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::open(temp.path().join("isolated")).unwrap();
    store.create("设计发布验收", "design-test").unwrap();
    let source = pipeline::prepare_source("第一集\n场景：门口\n△甲穿白衣。\n").unwrap();
    let source = store.save_source(json!(source)).unwrap();
    let asset=store.save_asset(json!({"id":"a","baseAssetId":"person","variantId":"v","name":"甲","kind":"CH","sourceRefs":[source["rows"][2]["id"]],"prompt":"旧文字"})).unwrap();
    (temp, store, source, asset)
}
fn output(source: &Value, asset: &Value) -> Value {
    let mut design = asset.clone();
    design["prompt"] = json!("新设计文字");
    design["promptOrigin"] = json!("AI");
    json!({"assets":[design],"facts":[{"id":"fact","assetId":"person","variantId":"v","attribute":"服装","value":"白衣","scope":"STATE","claim":"SOURCE","sourceRefs":[source["rows"][2]["id"]],"quotes":["不可信的模型引文"]}],
      "visualFactBatches":[{"status":"accepted","sourceSha256":source["sha256"],"inputFingerprint":"hash","ruleSha256":"rule","facts":[]}]})
}
#[test]
fn accepted_design_and_facts_publish_with_program_copied_quotes() {
    let (_temp, store, source, asset) = fixture();
    let result = output(&source, &asset);
    store.publish_asset_design(1, 0, &result).unwrap();
    assert_eq!(store.get("assets", "a").unwrap()["prompt"], "新设计文字");
    let foundation = store.foundation().unwrap();
    assert_eq!(
        foundation["facts"][0]["quotes"][0],
        source["rows"][2]["text"]
    );
    assert_eq!(foundation["visualFactBatches"][0]["status"], "accepted");
    assert_eq!(foundation["sourceVersion"], 1);
}
#[test]
fn invalid_cache_or_concurrent_edit_cannot_partially_replace_design() {
    let (_temp, store, source, asset) = fixture();
    let mut result = output(&source, &asset);
    result["visualFactBatches"][0]["sourceSha256"] = json!("other");
    assert!(store.publish_asset_design(1, 0, &result).is_err());
    assert_eq!(store.get("assets", "a").unwrap()["prompt"], "旧文字");
    assert!(store.foundation().unwrap().is_null());
    let result = output(&source, &asset);
    let mut newer = asset.clone();
    newer["prompt"] = json!("用户编辑");
    store.save_asset(newer).unwrap();
    assert!(store.publish_asset_design(1, 0, &result).is_err());
    assert_eq!(store.get("assets", "a").unwrap()["prompt"], "用户编辑");
    assert!(store.foundation().unwrap().is_null());
}
