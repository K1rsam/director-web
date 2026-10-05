//! Opt-in official account read. The scheduler is deliberately never started.
use director_core::{store::s, Engine};
use serde_json::json;

#[test]
#[ignore = "official read-only user_credit in an isolated project; never runs generation"]
fn existing_account_enables_image_queue_without_a_manual_label_or_submit() {
    let cli = std::env::var("DIRECTOR_TEST_DREAMINA_PATH").expect("explicit official CLI path");
    let temp = tempfile::tempdir().unwrap();
    let engine = Engine::new(temp.path().join("home")).unwrap();
    let project = engine
        .dispatch(json!({"action":"projects.create","title":"账户只读验证"}))
        .unwrap();
    let project_id = s(&project, "id");
    let store = engine.store(project_id).unwrap();
    store.save_settings(&json!({"dreaminaPath":cli,"imageProvider":"dreamina","imageModel":"5.0","imageResolution":"1080p","ratio":"16:9"})).unwrap();
    let workspace = engine
        .dispatch(json!({"action":"dreamina.status","projectId":project_id}))
        .unwrap();
    let account = &workspace["dreaminaAccount"];
    assert_eq!(account["status"], "authenticated");
    assert_eq!(account["ready"], true);
    assert_eq!(account["identityVerified"], true);
    assert!(account["credits"]["total"]
        .as_f64()
        .is_some_and(|c| c >= 0.));
    let (_, identity) = engine.config(&store, "dreamina").unwrap();
    assert_eq!(identity, s(account, "accountKey"));
    assert!(identity.starts_with("dreamina:official:user:"));
    assert!(store.settings().unwrap()["dreaminaAccountId"]
        .as_str()
        .unwrap_or("")
        .is_empty());
    assert!(account.get("user_id").is_none());
    assert!(account.get("access_token").is_none());
    let asset=store.save_asset(json!({"id":"readonly-asset","variantId":"base","name":"只读账户测试","kind":"character","prompt":"账户队列验证；此测试不启动调度器"})).unwrap();
    engine.dispatch(json!({"action":"images.run","projectId":project_id,"assetIds":[asset["id"]],"provider":"dreamina","model":"5.0","trial":true})).unwrap();
    let jobs = store.job_summaries().unwrap();
    assert_eq!(jobs.len(), 1);
    let job = store.job(s(&jobs[0], "id")).unwrap();
    assert_eq!(job["status"], "queued");
    assert_eq!(job["snapshot"]["resolution"], "1080p");
    assert_eq!(job["accountId"], identity);
    assert!(job["providerTaskId"].is_null());
    assert!(job["prepared"].is_null());
    assert!(job["receipt"].is_null());
    let started = std::time::Instant::now();
    let view = engine.workspace(&store, None).unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    assert_eq!(view["dreaminaAccount"], *account);
    // No Engine::start/tick, channels.prepare or submit is invoked in this test.
}
