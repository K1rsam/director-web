use director_core::{pipeline, providers::*, store::Store, tasks::Channels, Engine};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Barrier},
};
use tempfile::TempDir;

struct NoChannels;
impl Channels for NoChannels {
    fn capabilities(&self, _: &ProviderConfig) -> ProviderResult<Capabilities> {
        panic!("source recognition must not call a channel")
    }
    fn prepare(
        &self,
        _: &ProviderConfig,
        _: &GenerationRequest,
    ) -> ProviderResult<PreparedRequest> {
        panic!("source recognition must not prepare generation")
    }
    fn submit(&self, _: &ProviderConfig, _: &PreparedRequest) -> ProviderResult<SubmitReceipt> {
        panic!("source recognition must not submit generation")
    }
    fn query(&self, _: &ProviderConfig, _: &str) -> ProviderResult<QueryResult> {
        panic!("source recognition must not query generation")
    }
    fn download(&self, _: &ProviderConfig, _: &str, _: &Path) -> ProviderResult<DownloadReceipt> {
        panic!("source recognition must not download media")
    }
    fn reconcile(&self, _: &ProviderConfig, _: &str) -> ProviderResult<QueryResult> {
        panic!("source recognition must not reconcile generation")
    }
}

#[test]
fn source_actions_preserve_text_reject_stale_versions_and_do_not_duplicate_versions() {
    let temp = TempDir::new().unwrap();
    let engine = Engine::with_channels(temp.path().join("home"), Arc::new(NoChannels)).unwrap();
    let project = engine
        .dispatch(json!({"action":"projects.create","title":"匿名原文识别测试"}))
        .unwrap();
    let project_id = project["id"].as_str().unwrap();
    let text = "未标注用途的资料。\r\n【故事简介】\r\n背景😀。\r\n第一集\r\n场景：门口\r\n小王：走。\r\n第二集\r\n场景：大厅\r\n小王：到了。\r\n";
    let workspace = engine
        .dispatch(json!({"action":"source.import","projectId":project_id,"text":text}))
        .unwrap();
    let source = workspace["source"].clone();
    assert_eq!(source["version"], 1);
    assert_eq!(source["episodes"].as_array().unwrap().len(), 2);
    assert_eq!(source["diagnostics"].as_array().unwrap().len(), 1);
    let reparsed = engine
        .dispatch(
            json!({"action":"source.reparse","projectId":project_id,"expectedSourceVersion":1}),
        )
        .unwrap();
    assert_eq!(reparsed["source"], source);
    let decisions = json!([{"start":source["rows"][0]["range"]["start"],"end":source["rows"][0]["range"]["end"],"kind":"context","episodeNumber":null,"sceneTitle":null,"reason":"用户确认该段为背景资料"}]);
    let resolved = engine.dispatch(json!({"action":"source.resolve","projectId":project_id,"expectedSourceVersion":1,"decisions":decisions})).unwrap();
    assert_eq!(resolved["source"]["version"], 2);
    assert_eq!(resolved["source"]["text"], text);
    assert_eq!(resolved["source"]["sha256"], source["sha256"]);
    assert!(resolved["source"]["diagnostics"]
        .as_array()
        .unwrap()
        .is_empty());
    let repeat = engine.dispatch(json!({"action":"source.resolve","projectId":project_id,"expectedSourceVersion":2,"decisions":decisions})).unwrap();
    assert_eq!(repeat["source"], resolved["source"]);
    for action in ["source.resolve", "source.reparse"] {
        let error = engine.dispatch(json!({"action":action,"projectId":project_id,"expectedSourceVersion":1,"decisions":decisions})).unwrap_err();
        assert!(error.contains("已更新"));
        let error = engine
            .dispatch(json!({"action":action,"projectId":project_id,"decisions":decisions}))
            .unwrap_err();
        assert!(error.contains("版本"));
    }
    let recheck = engine
        .dispatch(
            json!({"action":"source.reparse","projectId":project_id,"expectedSourceVersion":2}),
        )
        .unwrap();
    assert_eq!(recheck["source"], resolved["source"]);
    let store = engine.store(project_id).unwrap();
    let conn = store.conn().unwrap();
    let versions: i64 = conn
        .query_row("SELECT COUNT(*) FROM sources", [], |row| row.get(0))
        .unwrap();
    let jobs: i64 = conn
        .query_row("SELECT COUNT(*) FROM jobs", [], |row| row.get(0))
        .unwrap();
    assert_eq!(versions, 2);
    assert_eq!(jobs, 0);
}

#[test]
fn source_compare_and_save_is_atomic_against_competing_updates() {
    let temp = TempDir::new().unwrap();
    let store = Store::open(temp.path().join("project")).unwrap();
    store.create("CAS测试", "test").unwrap();
    let source = pipeline::prepare_source("第一集\n场景：门口\n小王：走。\n").unwrap();
    store
        .save_source(serde_json::to_value(&source).unwrap())
        .unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let handles: Vec<_> = (1..=2)
        .map(|i| {
            let store = store.clone();
            let barrier = barrier.clone();
            let candidate: Value = serde_json::to_value(
                pipeline::prepare_source(&format!("第一集\n场景：门口\n小王：更新{i}。\n"))
                    .unwrap(),
            )
            .unwrap();
            std::thread::spawn(move || {
                barrier.wait();
                store.save_source_if_current(candidate, 1)
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| r.as_ref().is_err_and(|e| e.contains("已更新")))
            .count(),
        1
    );
    assert_eq!(store.source().unwrap()["version"], 2);
    let versions: i64 = store
        .conn()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM sources", [], |row| row.get(0))
        .unwrap();
    assert_eq!(versions, 2);
}
