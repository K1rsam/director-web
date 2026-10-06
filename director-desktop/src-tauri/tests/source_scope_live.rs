//! Explicit readback check with a private source snapshot, never a live project.
//! The normal suite skips this environment-dependent regression.
use director_core::{pipeline, tasks::RealChannels, Engine};
use serde_json::{json, Value};
use std::{fs, sync::Arc};

#[test]
#[ignore = "requires DIRECTOR_TEST_SOURCE_SNAPSHOT; reads only a private source snapshot"]
fn imported_source_structure_can_be_reparsed_in_isolation_without_text_changes() {
    let path = std::env::var("DIRECTOR_TEST_SOURCE_SNAPSHOT").expect("private snapshot path");
    let saved: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let locked = serde_json::from_value(saved.clone()).unwrap();
    pipeline::validate_source(&locked).expect("old saved classifications remain valid");
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::with_channels(dir.path().to_owned(), Arc::new(RealChannels)).unwrap();
    let project = engine
        .dispatch(json!({"action":"projects.create","title":"来源结构隔离核验"}))
        .unwrap();
    let id = project["id"].as_str().unwrap();
    let store = engine.store(id).unwrap();
    let imported = store.save_source(saved.clone()).unwrap();
    let actual = engine.dispatch(json!({"action":"source.reparse","projectId":id,"expectedSourceVersion":imported["version"]})).unwrap();
    let source = &actual["source"];
    assert_eq!(source["text"], saved["text"]);
    assert_eq!(source["sha256"], saved["sha256"]);
    assert_eq!(source["episodes"], saved["episodes"]);
    assert_eq!(source["scenes"], saved["scenes"]);
    assert_eq!(source["rows"].as_array().unwrap().len(), 461);
    assert_eq!(source["episodes"].as_array().unwrap().len(), 10);
    assert_eq!(source["scenes"].as_array().unwrap().len(), 21);
    assert!(source["diagnostics"].as_array().unwrap().is_empty());
    let rows = source["rows"].as_array().unwrap();
    assert!(rows
        .iter()
        .filter(|r| r["number"].as_u64().unwrap() <= 24)
        .all(|r| r["kind"] == "context" || r["kind"] == "format"));
    assert!(rows
        .iter()
        .take(24)
        .all(|r| r["episodeId"].is_null() && r["sceneId"].is_null() && r["dialogue"].is_null()));
    assert_eq!(
        rows.iter()
            .map(|r| r["text"].as_str().unwrap())
            .collect::<String>(),
        saved["text"].as_str().unwrap()
    );
    pipeline::validate_source(&serde_json::from_value(source.clone()).unwrap()).unwrap();
    let repeated = engine.dispatch(json!({"action":"source.reparse","projectId":id,"expectedSourceVersion":source["version"]})).unwrap();
    assert_eq!(repeated["source"]["version"], source["version"]);
    assert!(actual["jobs"].as_array().unwrap().is_empty());
    assert!(actual["assets"].as_array().unwrap().is_empty());
    assert!(actual["units"].as_array().unwrap().is_empty());
    let report = json!({"ok":true,"rows":461,"episodes":10,"scenes":21,"backgroundRange":{"firstLine":1,"lastLine":24},"remainingBlockingIssues":0,"textAndSha256Unchanged":true,"episodeSceneIdentitiesAndMembershipUnchanged":true,"repeatedReparseCreatesVersion":false,"generationRequestsSent":0,"productionDatabaseWritten":false,"sourceSnapshotRead":true,"isolation":"temporary Engine project"});
    if let Ok(output) = std::env::var("DIRECTOR_TEST_SOURCE_REPORT") {
        fs::write(output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
    println!("{report}");
}
