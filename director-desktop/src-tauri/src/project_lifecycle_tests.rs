//! Project lifecycle acceptance uses isolated directories and injected channels only.
use super::*;
use crate::providers::*;
use std::sync::{atomic::AtomicUsize, Barrier, Condvar};

type CatalogGate = Arc<(Mutex<(bool, bool)>, Condvar)>;

#[derive(Default)]
struct Channel {
    submissions: AtomicUsize,
    capabilities: AtomicUsize,
    queries: Mutex<Vec<String>>,
    slow_catalog: Mutex<Option<CatalogGate>>,
}
impl Channels for Channel {
    fn capabilities(&self, _: &ProviderConfig) -> ProviderResult<Capabilities> {
        self.capabilities.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = self.slow_catalog.lock().unwrap().clone() {
            let (state, wake) = &*gate;
            let mut state = state.lock().unwrap();
            state.0 = true;
            wake.notify_all();
            while !state.1 {
                state = wake.wait(state).unwrap();
            }
        }
        Err(ProviderError::new("OFFLINE", "no live channel"))
    }
    fn prepare(
        &self,
        _: &ProviderConfig,
        _: &GenerationRequest,
    ) -> ProviderResult<PreparedRequest> {
        Err(ProviderError::new("OFFLINE", "no generation allowed"))
    }
    fn submit(&self, _: &ProviderConfig, _: &PreparedRequest) -> ProviderResult<SubmitReceipt> {
        self.submissions.fetch_add(1, Ordering::SeqCst);
        Err(ProviderError::new("OFFLINE", "no generation allowed"))
    }
    fn query(&self, _: &ProviderConfig, task: &str) -> ProviderResult<QueryResult> {
        self.queries.lock().unwrap().push(task.into());
        Ok(QueryResult {
            task_id: task.into(),
            status: "processing".into(),
            result_urls: vec![],
            error: None,
            actual_cost: None,
            raw: json!({"fixture":true}),
        })
    }
    fn download(&self, _: &ProviderConfig, _: &str, _: &Path) -> ProviderResult<DownloadReceipt> {
        Err(ProviderError::new("OFFLINE", "no download allowed"))
    }
    fn reconcile(&self, _: &ProviderConfig, _: &str) -> ProviderResult<QueryResult> {
        Err(ProviderError::new("OFFLINE", "unknown submission retained"))
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    engine: Arc<Engine>,
    channels: Arc<Channel>,
    store: Store,
    pid: String,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let channels = Arc::new(Channel::default());
        let engine = Engine::with_channels(temp.path().join("home"), channels.clone()).unwrap();
        let project = engine.dispatch(json!({"action":"projects.create","title":"归档测试","rootPath":temp.path().join("external-projects")})).unwrap();
        let pid = s(&project, "id").to_owned();
        let store = engine.store(&pid).unwrap();
        Self {
            _temp: temp,
            engine,
            channels,
            store,
            pid,
        }
    }
    fn action(&self, action: &str, version: u64) -> Result<Value> {
        self.engine
            .dispatch(json!({"action":action,"projectId":self.pid,"expectedVersion":version}))
    }
    fn job(&self, entity: &str, state: &str, remote: Option<&str>) -> String {
        let (_, account) = self.engine.config(&self.store, "mock").unwrap();
        let id = self.store.add_job("video",entity,"mock",&account,&json!({"requestId":entity,"prompt":"immutable","autoSubmit":true,"rules":{"version":"frozen/v1"}}),state).unwrap();
        if let Some(remote) = remote {
            self.store.update_job(&id,state,&json!({"providerTaskId":remote,"receipt":{"taskId":remote,"raw":{"persisted":true}}})).unwrap();
        }
        id
    }
}

#[test]
fn project_summary_counts_only_active_units_and_preserves_retired_history() {
    let f = Fixture::new();
    let conn = f.store.conn().unwrap();
    for index in 0..29 {
        let id = format!("unit-{index}");
        let mut unit = json!({"id":id,"episodeId":"episode-1","version":1});
        if index >= 19 {
            unit["retired"] = json!(true);
        } else if index % 3 == 0 {
            unit["retired"] = json!(false);
        } else if index % 3 == 1 {
            unit["retired"] = Value::Null;
        }
        conn.execute(
            "INSERT INTO units(id,episode_id,version,data) VALUES(?1,'episode-1',1,?2)",
            rusqlite::params![id, unit.to_string()],
        )
        .unwrap();
    }
    let active_count = || {
        let list = f.engine.dispatch(json!({"action":"projects.list"})).unwrap();
        list.as_array()
            .unwrap()
            .iter()
            .find(|project| project["id"] == f.pid)
            .unwrap()["counts"]["units"]
            .as_u64()
            .unwrap()
    };
    assert_eq!(active_count(), 19);
    let workspace = f
        .engine
        .dispatch(json!({"action":"workspace.get","projectId":f.pid}))
        .unwrap();
    assert_eq!(workspace["units"].as_array().unwrap().len(), 19);
    assert_eq!(f.store.values("units").unwrap().len(), 19);
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM units", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        29,
        "the library count must not delete retired records"
    );
    assert_eq!(f.store.get("units", "unit-19").unwrap()["retired"], true);

    conn.execute(
        "UPDATE units SET data=json_set(data,'$.retired',json('true')) WHERE id='unit-0'",
        [],
    )
    .unwrap();
    assert_eq!(active_count(), 18);
    conn.execute(
        "UPDATE units SET data=json_set(data,'$.retired',json('false')) WHERE id='unit-19'",
        [],
    )
    .unwrap();
    assert_eq!(active_count(), 19);
    assert_eq!(f.channels.submissions.load(Ordering::SeqCst), 0);
}

#[test]
fn legacy_registry_defaults_to_active_and_archive_is_required_before_deletion() {
    let f = Fixture::new();
    let mut registry = f.engine.registry().unwrap();
    for key in ["lifecycleVersion", "archivedAt"] {
        registry[0].as_object_mut().unwrap().remove(key);
    }
    atomic_json(&f.engine.home.join("projects.json"), &registry).unwrap();
    let listed = f.engine.project_list().unwrap();
    assert_eq!(listed[0]["lifecycleVersion"], 0);
    assert!(listed[0]["archivedAt"].is_null());
    assert!(f
        .action("projects.delete", 0)
        .unwrap_err()
        .contains("先归档"));
    assert!(f
        .engine
        .dispatch(json!({"action":"projects.archive","projectId":f.pid}))
        .is_err());
    let archived = f.action("projects.archive", 0).unwrap();
    assert_eq!(archived["projectId"], f.pid);
    assert_eq!(archived["lifecycleVersion"], 1);
    assert!(!s(&archived, "archivedAt").is_empty());
    assert_eq!(archived["filesRetained"], true);
    assert!(f
        .engine
        .dispatch(json!({"action":"workspace.get","projectId":f.pid}))
        .unwrap_err()
        .contains("请先恢复"));
    assert!(f
        .engine
        .dispatch(json!({"action":"source.import","projectId":f.pid,"text":"不得写入"}))
        .is_err());
    assert!(f.store.source().unwrap().is_null());
    let restored = f.action("projects.restore", 1).unwrap();
    assert!(restored["archivedAt"].is_null());
    assert_eq!(restored["lifecycleVersion"], 2);
    assert!(f.engine.store(&f.pid).is_ok());
}

#[test]
fn concurrent_old_version_archive_and_restore_each_have_one_winner() {
    let f = Fixture::new();
    for (action, version) in [("projects.archive", 0), ("projects.restore", 1)] {
        let barrier = Arc::new(Barrier::new(3));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let engine = f.engine.clone();
                let pid = f.pid.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    engine.dispatch(
                        json!({"action":action,"projectId":pid,"expectedVersion":version}),
                    )
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert!(results
            .iter()
            .find_map(|r| r.as_ref().err())
            .unwrap()
            .contains("状态已变化"));
    }
    assert_eq!(f.engine.project_list().unwrap()[0]["lifecycleVersion"], 2);
}

#[test]
fn archived_scheduler_makes_zero_calls_and_restore_queries_original_id_without_submitting() {
    let f = Fixture::new();
    let known = f.job("known", "submitted", Some("cloud-original-id"));
    let unknown = f.job("unknown", "submission_unknown", None);
    let queued = f.job("queued", "queued", None);
    let before: Vec<_> = [&known, &unknown, &queued]
        .iter()
        .map(|id| f.store.job(id).unwrap())
        .collect();
    f.action("projects.archive", 0).unwrap();
    for _ in 0..3 {
        f.engine.tick().unwrap();
    }
    assert!(f.engine.await_worker_shutdown(1));
    assert_eq!(f.channels.capabilities.load(Ordering::SeqCst), 0);
    assert_eq!(f.channels.submissions.load(Ordering::SeqCst), 0);
    assert!(f.channels.queries.lock().unwrap().is_empty());
    let reopened = Engine::with_channels(f.engine.home.clone(), f.channels.clone()).unwrap();
    reopened.tick().unwrap();
    for (index, id) in [&known, &unknown, &queued].iter().enumerate() {
        assert_eq!(f.store.job(id).unwrap(), before[index]);
    }
    f.action("projects.restore", 1).unwrap();
    // Keep the queued generation explicit and out of the query recovery fixture.
    f.store.update_job(&queued, "stale", &json!({})).unwrap();
    f.engine.tick().unwrap();
    assert!(f.engine.await_worker_shutdown(2));
    assert_eq!(
        f.channels.queries.lock().unwrap().as_slice(),
        &["cloud-original-id"]
    );
    assert_eq!(f.channels.submissions.load(Ordering::SeqCst), 0);
    assert_eq!(
        f.store.job(&known).unwrap()["snapshot"],
        before[0]["snapshot"]
    );
    assert_eq!(
        f.store.job(&known).unwrap()["receipt"],
        before[0]["receipt"]
    );
    assert_eq!(f.store.job(&unknown).unwrap(), before[1]);
}

#[test]
fn project_owned_worker_blocks_archive_while_shared_channel_does_not_block_another_project() {
    let f = Fixture::new();
    let guard = f
        .engine
        .acquire_keys(
            project_worker_keys(
                &f.store,
                vec!["channel:dreamina".into(), "job:local-owned".into()],
            )
            .unwrap(),
        )
        .unwrap();
    assert!(f
        .action("projects.archive", 0)
        .unwrap_err()
        .contains("本地任务"));
    let other = f
        .engine
        .dispatch(json!({"action":"projects.create","title":"另一项目"}))
        .unwrap();
    let archive = f
        .engine
        .dispatch(json!({"action":"projects.archive","projectId":other["id"],"expectedVersion":0}))
        .unwrap();
    assert!(!s(&archive, "archivedAt").is_empty());
    drop(guard);
    f.action("projects.archive", 0).unwrap();
    let f2 = Fixture::new();
    let pipeline = f2
        .engine
        .acquire_keys(vec![
            format!("pipeline:{}", f2.pid),
            format!("project:{}:pipeline", f2.pid),
        ])
        .unwrap();
    assert!(f2.action("projects.archive", 0).is_err());
    drop(pipeline);
    f2.action("projects.archive", 0).unwrap();
}

#[test]
fn deletion_retains_external_files_and_receipts_and_restart_does_not_reregister() {
    let f = Fixture::new();
    let known = f.job("known", "submitted", Some("cloud-retained"));
    let file = f.store.root.join("media/original.png");
    fs::write(&file, b"original media fixture").unwrap();
    f.action("projects.archive", 0).unwrap();
    let database_before = fs::read(f.store.root.join("project.sqlite")).unwrap();
    let known_before = f.store.job(&known).unwrap();
    let result = f.action("projects.delete", 1).unwrap();
    assert_eq!(result["deleted"], true);
    assert_eq!(result["filesRetained"], true);
    assert_eq!(fs::read(&file).unwrap(), b"original media fixture");
    assert_eq!(
        fs::read(f.store.root.join("project.sqlite")).unwrap(),
        database_before
    );
    assert_eq!(f.store.job(&known).unwrap(), known_before);
    assert!(f.engine.store(&f.pid).is_err());
    let restarted = Engine::with_channels(f.engine.home.clone(), f.channels.clone()).unwrap();
    assert!(restarted.project_list().unwrap().is_empty());
    restarted.tick().unwrap();
    assert!(f.channels.queries.lock().unwrap().is_empty());
    assert_eq!(f.channels.submissions.load(Ordering::SeqCst), 0);
}

#[test]
fn absent_or_mismatched_roots_are_not_recreated_or_opened_by_list_and_restart() {
    let f = Fixture::new();
    let absent = f._temp.path().join("never-create-this-root");
    let mut registry = f.engine.registry().unwrap();
    registry
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"absent","title":"丢失路径","rootPath":absent}));
    atomic_json(&f.engine.home.join("projects.json"), &registry).unwrap();
    assert_eq!(f.engine.project_list().unwrap().len(), 2);
    assert!(!absent.exists());
    let restarted = Engine::with_channels(f.engine.home.clone(), f.channels.clone()).unwrap();
    restarted.tick().unwrap();
    assert!(!absent.exists());
    assert!(restarted.store("absent").is_err());
    let mut wrong = registry[0].clone();
    wrong["id"] = json!("different-id");
    assert!(registered_store(&wrong)
        .err()
        .unwrap()
        .contains("身份不一致"));
    f.engine
        .dispatch(json!({"action":"projects.archive","projectId":"absent","expectedVersion":0}))
        .unwrap();
    f.engine
        .dispatch(json!({"action":"projects.delete","projectId":"absent","expectedVersion":1}))
        .unwrap();
    assert!(!absent.exists());
}

#[test]
fn shared_authentication_callback_does_not_mutate_archived_project_jobs() {
    let f = Fixture::new();
    let job = f
        .store
        .add_job(
            "video",
            "auth-unit",
            "dreamina",
            "same-account",
            &json!({"prompt":"frozen"}),
            "auth_required",
        )
        .unwrap();
    f.store
        .update_job(
            &job,
            "auth_required",
            &json!({"providerTaskId":"auth-cloud-id"}),
        )
        .unwrap();
    let before = f.store.job(&job).unwrap();
    f.action("projects.archive", 0).unwrap();
    f.engine
        .resume_authenticated_dreamina(
            &f.store,
            &json!({"ready":true,"identityVerified":true,"accountKey":"same-account"}),
        )
        .unwrap();
    assert_eq!(f.store.job(&job).unwrap(), before);
}

#[test]
fn slow_catalog_check_rejects_same_project_archive_without_blocking_other_project_or_list() {
    let f = Fixture::new();
    let other = f
        .engine
        .dispatch(json!({"action":"projects.create","title":"独立项目"}))
        .unwrap();
    let gate = Arc::new((Mutex::new((false, false)), Condvar::new()));
    *f.channels.slow_catalog.lock().unwrap() = Some(gate.clone());
    let worker = {
        let engine = f.engine.clone();
        let pid = f.pid.clone();
        std::thread::spawn(move || {
            engine.dispatch(json!({"action":"providers.refresh","projectId":pid,"provider":"mock"}))
        })
    };
    let (state, wake) = &*gate;
    let started = std::time::Instant::now();
    let mut state = state.lock().unwrap();
    while !state.0 {
        let (new_state, timeout) = wake.wait_timeout(state, Duration::from_secs(2)).unwrap();
        state = new_state;
        assert!(!timeout.timed_out(), "fixture channel did not start");
    }
    drop(state);
    assert!(started.elapsed() < Duration::from_secs(2));
    let operation_started = std::time::Instant::now();
    assert!(f
        .action("projects.archive", 0)
        .unwrap_err()
        .contains("本地任务"));
    assert!(f
        .engine
        .dispatch(json!({"action":"projects.archive","projectId":other["id"],"expectedVersion":0}))
        .is_ok());
    assert_eq!(
        f.engine
            .dispatch(json!({"action":"projects.list"}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(
        operation_started.elapsed() < Duration::from_secs(1),
        "unrelated library operations waited for slow channel"
    );
    let mut state = gate.0.lock().unwrap();
    state.1 = true;
    gate.1.notify_all();
    drop(state);
    assert!(worker.join().unwrap().is_err());
    f.action("projects.archive", 0).unwrap();
}
