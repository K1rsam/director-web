//! Offline account recovery contracts. No CLI, OAuth, network, or generation is run.
use director_core::{
    providers::{
        Capabilities, DownloadReceipt, GenerationRequest, PreparedRequest, ProviderConfig,
        ProviderError, ProviderResult, QueryResult, SubmitReceipt,
    },
    store::{s, Store},
    tasks::{self, Channels},
    Engine,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tempfile::TempDir;

#[derive(Default)]
struct QueryOnly {
    prepares: AtomicUsize,
    submits: AtomicUsize,
    queries: Mutex<Vec<String>>,
}
impl Channels for QueryOnly {
    fn capabilities(&self, _: &ProviderConfig) -> ProviderResult<Capabilities> {
        Err(ProviderError::new("OFFLINE", "catalog must not be called"))
    }
    fn prepare(
        &self,
        _: &ProviderConfig,
        _: &GenerationRequest,
    ) -> ProviderResult<PreparedRequest> {
        self.prepares.fetch_add(1, Ordering::SeqCst);
        Err(ProviderError::new("OFFLINE", "recovery must not prepare"))
    }
    fn submit(&self, _: &ProviderConfig, _: &PreparedRequest) -> ProviderResult<SubmitReceipt> {
        self.submits.fetch_add(1, Ordering::SeqCst);
        Err(ProviderError::new("OFFLINE", "recovery must not submit"))
    }
    fn query(&self, _: &ProviderConfig, task: &str) -> ProviderResult<QueryResult> {
        self.queries.lock().unwrap().push(task.into());
        Ok(QueryResult {
            task_id: task.into(),
            status: "processing".into(),
            result_urls: vec![],
            error: None,
            actual_cost: None,
            raw: json!({"offline":true}),
        })
    }
    fn download(&self, _: &ProviderConfig, _: &str, _: &Path) -> ProviderResult<DownloadReceipt> {
        Err(ProviderError::new(
            "OFFLINE",
            "processing task has no download",
        ))
    }
    fn reconcile(&self, _: &ProviderConfig, _: &str) -> ProviderResult<QueryResult> {
        Err(ProviderError::new(
            "OFFLINE",
            "unknown submit must remain blocked",
        ))
    }
}
fn setup() -> (TempDir, Store, Arc<Engine>, Arc<QueryOnly>) {
    let temporary = TempDir::new().unwrap();
    let store = Store::open(temporary.path().join("project")).unwrap();
    store.create("offline account recovery", "project").unwrap();
    let channel = Arc::new(QueryOnly::default());
    let engine = Engine::with_channels(temporary.path().join("home"), channel.clone()).unwrap();
    (temporary, store, engine, channel)
}
fn account(key: &str) -> Value {
    json!({"ready":true,"identityVerified":true,"accountKey":key})
}
fn job(store: &Store, entity: &str, provider: &str, key: &str, state: &str) -> String {
    store
        .add_job(
            "video",
            entity,
            provider,
            key,
            &json!({"requestId":entity,"prompt":"frozen prompt","rules":{"sha256":"frozen"},"autoSubmit":true}),
            state,
        )
        .unwrap()
}
fn known(store: &Store, entity: &str, provider: &str, key: &str) -> String {
    let id = job(store, entity, provider, key, "auth_required");
    store
        .update_job(
            &id,
            "auth_required",
            &json!({"providerTaskId":format!("remote:{entity}"),"receipt":{"taskId":format!("remote:{entity}"),"raw":{"persisted":true}},"error":"expired login"}),
        )
        .unwrap();
    id
}
fn config() -> ProviderConfig {
    serde_json::from_value(json!({"kind":"dreamina"})).unwrap()
}

#[test]
fn verified_same_account_recovers_saved_id_by_query_only() {
    let (_temporary, store, engine, channel) = setup();
    let id = known(
        &store,
        "known-unit",
        "dreamina",
        "dreamina:verified-original",
    );
    let before = store.job(&id).unwrap();
    // This public Engine boundary only makes the original task eligible for querying.
    // The subsequent recovery uses the same injected mock as the Engine.
    engine
        .resume_authenticated_dreamina(&store, &account("dreamina:verified-original"))
        .unwrap();
    let ready = store.job(&id).unwrap();
    assert_eq!(ready["status"], "submitted");
    assert_eq!(ready["providerTaskId"], before["providerTaskId"]);
    assert_eq!(ready["snapshot"], before["snapshot"]);
    assert_eq!(ready["receipt"], before["receipt"]);
    tasks::resume_job(
        &store,
        &id,
        &config(),
        "dreamina:verified-original",
        engine.channels.as_ref(),
        true,
    )
    .unwrap();
    assert_eq!(store.job(&id).unwrap()["status"], "processing");
    assert_eq!(
        channel.queries.lock().unwrap().as_slice(),
        &["remote:known-unit"]
    );
    assert_eq!(channel.prepares.load(Ordering::SeqCst), 0);
    assert_eq!(channel.submits.load(Ordering::SeqCst), 0);
}

#[test]
fn unknown_submit_and_unsubmitted_auth_failure_never_reenter_generation() {
    let (_temporary, store, engine, channel) = setup();
    let unknown = job(
        &store,
        "unknown-unit",
        "dreamina",
        "account-original",
        "submission_unknown",
    );
    let unsent = job(
        &store,
        "unsent-unit",
        "dreamina",
        "account-original",
        "auth_required",
    );
    let original_unknown = store.job(&unknown).unwrap();
    for _ in 0..2 {
        engine
            .resume_authenticated_dreamina(&store, &account("account-original"))
            .unwrap();
        assert_eq!(store.job(&unknown).unwrap(), original_unknown);
        let unsubmitted = store.job(&unsent).unwrap();
        assert!(
            !["queued", "ready", "submitting", "submitted"].contains(&s(&unsubmitted, "status"))
        );
        assert!(s(&unsubmitted, "providerTaskId").is_empty());
    }
    assert_eq!(store.job(&unsent).unwrap()["status"], "stale");
    assert!(tasks::resume_job(
        &store,
        &unknown,
        &config(),
        "account-original",
        engine.channels.as_ref(),
        true
    )
    .is_err());
    assert!(tasks::resume_job(
        &store,
        &unsent,
        &config(),
        "account-original",
        engine.channels.as_ref(),
        true
    )
    .is_err());
    assert!(channel.queries.lock().unwrap().is_empty());
    assert_eq!(channel.prepares.load(Ordering::SeqCst), 0);
    assert_eq!(channel.submits.load(Ordering::SeqCst), 0);
}

#[test]
fn another_verified_account_cannot_release_the_original_cloud_task() {
    let (_temporary, store, engine, channel) = setup();
    let id = known(&store, "original-unit", "dreamina", "account-original");
    let before = store.job(&id).unwrap();
    engine
        .resume_authenticated_dreamina(&store, &account("account-other"))
        .unwrap();
    assert_eq!(store.job(&id).unwrap(), before);
    assert!(tasks::resume_job(
        &store,
        &id,
        &config(),
        "account-other",
        engine.channels.as_ref(),
        true
    )
    .is_err());
    assert_eq!(store.job(&id).unwrap()["status"], "auth_required");
    assert!(channel.queries.lock().unwrap().is_empty());
    assert_eq!(channel.submits.load(Ordering::SeqCst), 0);
}

#[test]
fn readiness_identity_and_provider_all_gate_recovery() {
    let (_temporary, store, engine, channel) = setup();
    let id = known(&store, "dreamina-unit", "dreamina", "account-original");
    let bh = known(&store, "bh-unit", "bh", "account-original");
    let before = store.job(&id).unwrap();
    let before_bh = store.job(&bh).unwrap();
    for unverified in [
        json!({"ready":false,"identityVerified":true,"accountKey":"account-original"}),
        json!({"ready":true,"identityVerified":false,"accountKey":"account-original"}),
        json!({"ready":true,"identityVerified":true,"accountKey":""}),
    ] {
        // Rejecting malformed/unverified projections and retaining the block is safe.
        let _ = engine.resume_authenticated_dreamina(&store, &unverified);
        assert_eq!(store.job(&id).unwrap(), before);
        assert_eq!(store.job(&bh).unwrap(), before_bh);
    }
    engine
        .resume_authenticated_dreamina(&store, &account("account-original"))
        .unwrap();
    assert_eq!(store.job(&id).unwrap()["status"], "submitted");
    assert_eq!(store.job(&bh).unwrap(), before_bh);
    assert!(channel.queries.lock().unwrap().is_empty());
    assert_eq!(channel.submits.load(Ordering::SeqCst), 0);
}
