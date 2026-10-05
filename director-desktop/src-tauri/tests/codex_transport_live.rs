//! Explicit live text transport smoke. Uses a temporary project and no media generation.
use director_core::{
    pipeline::{TextExecutor, TextRequest},
    store::{s, Store},
    text_executor::SavedTextExecutor,
};
use serde_json::json;

#[tokio::test]
#[ignore = "one real Codex text request using existing login, never production data or media"]
async fn native_codex_returns_structured_text_and_reuses_the_accepted_result() {
    let temporary = tempfile::tempdir().unwrap();
    let store = Store::open(temporary.path().join("isolated-project")).unwrap();
    store
        .create("CLI 结构化文本验收", &uuid::Uuid::new_v4().to_string())
        .unwrap();
    let settings = json!({"textProvider":"codex","codexPath":std::env::var("DIRECTOR_TEST_CODEX_PATH").unwrap_or_default(),"textModel":std::env::var("DIRECTOR_TEST_CODEX_MODEL").unwrap_or("gpt-6.1-sol".into()),"reasoning":"medium"});
    let resolved = director_core::text_cli::resolve_settings(&settings)
        .await
        .unwrap();
    let executor = SavedTextExecutor {
        store: store.clone(),
        settings: resolved.clone(),
        workflow_id: None,
    };
    let request = TextRequest {
        stage: "cli-transport-smoke".into(),
        skill: "transport-check".into(),
        model: s(&resolved, "textModel").to_owned(),
        reasoning: s(&resolved, "reasoning").to_owned(),
        input: json!({"testSentence":"CLI 连接验收，仅返回固定结构。","expected":{"ok":true,"transport":"cli"}}),
        schema: json!({"type":"object","additionalProperties":false,"required":["ok","transport"],"properties":{"ok":{"type":"boolean","const":true},"transport":{"type":"string","enum":["cli"]}}}),
        rule_snapshot: json!({"version":"transport-check/v1","content":"仅返回输入 expected 的 JSON 对象，不读取任何资料或调用工具。"}),
    };
    let result = executor.execute(request.clone()).await.unwrap();
    assert_eq!(result, json!({"ok":true,"transport":"cli"}));
    let jobs = store.jobs().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["status"], "completed");
    let events: i64 = store
        .conn()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE job_id=?1 AND type='codex_event'",
            [s(&jobs[0], "id")],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        events > 0,
        "the native JSONL event stream must be persisted"
    );
    assert_eq!(executor.execute(request).await.unwrap(), result);
    assert_eq!(
        store.jobs().unwrap().len(),
        1,
        "accepted result must not generate a second request"
    );
    let evidence = json!({"ok":true,"model":resolved["textModel"],"reasoning":resolved["reasoning"],"cliVersion":resolved["textCliVersion"],"cliExecutable":resolved["textCliExecutable"],"nativeJsonlEvents":events,"structuredResult":result,"generationRequestsSent":1,"requestsSentAfterCacheReuse":0,"textJobs":1,"productionDatabaseAccess":false,"imageVideoGenerationRequestsSent":0});
    if let Ok(output) = std::env::var("DIRECTOR_TEST_CODEX_REPORT") {
        let path = std::path::PathBuf::from(output);
        assert!(path.is_absolute());
        director_core::store::atomic_json(&path, &evidence).unwrap();
    }
    println!("{}", evidence);
}
