use super::*;
use crate::providers::*;
use std::sync::atomic::AtomicUsize;

struct OfflineChannels {
    calls: AtomicUsize,
    submitting: AtomicBool,
    delay: Duration,
}
impl OfflineChannels {
    fn new(delay: Duration) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            submitting: AtomicBool::new(false),
            delay,
        }
    }
}
impl Channels for OfflineChannels {
    fn capabilities(&self, _: &ProviderConfig) -> ProviderResult<Capabilities> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(ProviderError::new(
            "OFFLINE",
            "No live capacity query is allowed",
        ))
    }
    fn prepare(
        &self,
        _: &ProviderConfig,
        request: &GenerationRequest,
    ) -> ProviderResult<PreparedRequest> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(PreparedRequest {
            provider: "offline".into(),
            request: request.clone(),
            capability_version: "offline/v1".into(),
            upload_receipts: vec![],
            wire: json!({"offline":true}),
            estimated_cost: None,
            prepared_at: now(),
        })
    }
    fn submit(&self, _: &ProviderConfig, _: &PreparedRequest) -> ProviderResult<SubmitReceipt> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.submitting.store(true, Ordering::SeqCst);
        std::thread::sleep(self.delay);
        Ok(SubmitReceipt {
            task_id: "offline-durable-original-id".into(),
            status: "processing".into(),
            result_urls: vec![],
            raw: json!({"fixture":true}),
        })
    }
    fn query(&self, _: &ProviderConfig, _: &str) -> ProviderResult<QueryResult> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(ProviderError::new("OFFLINE", "No query is expected"))
    }
    fn download(&self, _: &ProviderConfig, _: &str, _: &Path) -> ProviderResult<DownloadReceipt> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(ProviderError::new("OFFLINE", "No download is expected"))
    }
    fn reconcile(&self, _: &ProviderConfig, _: &str) -> ProviderResult<QueryResult> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(ProviderError::new(
            "OFFLINE",
            "No reconciliation is expected",
        ))
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    engine: Arc<Engine>,
    store: Store,
    project_id: String,
    channels: Arc<OfflineChannels>,
}

#[test]
fn startup_channel_contention_defers_catalog_without_marking_a_refresh_attempt() {
    let f = Fixture::new(Duration::ZERO);
    f.store
        .save_settings(&json!({"chromeEndpoint":"http://offline.test"}))
        .unwrap();
    let guard = f
        .engine
        .acquire_keys(vec![
            "channel:dreamina".into(),
            "channel:bh".into(),
            "channel:chrome".into(),
        ])
        .unwrap();
    f.engine.refresh_due_catalogs(&f.store).unwrap();
    let count: i64 = f
        .store
        .conn()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM metadata WHERE key='catalog_attempt:chrome'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        count, 0,
        "a worker that did not acquire the channel must remain due"
    );
    let error = match f.engine.acquire_keys(vec!["channel:dreamina".into()]) {
        Err(error) => error,
        Ok(_) => panic!("same channel cannot execute twice"),
    };
    assert!(error.contains("即梦渠道"));
    assert!(!error.contains("相关任务正在执行"));
    drop(guard);
    f.engine.refresh_due_catalogs(&f.store).unwrap();
    assert!(f.engine.await_worker_shutdown(2));
    let count: i64 = f
        .store
        .conn()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM metadata WHERE key='catalog_attempt:chrome'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "next scheduler tick must make the real attempt");
    assert!(f.channels.calls.load(Ordering::SeqCst) > 0);
    assert!(
        f.store.jobs().unwrap().is_empty(),
        "catalog checks do not create generation jobs"
    );
}

#[test]
fn missing_source_blocks_text_design_but_manual_image_prompt_can_queue_without_text_cli() {
    let temp = tempfile::tempdir().unwrap();
    let channels = Arc::new(OfflineChannels::new(Duration::ZERO));
    let engine = Engine::with_channels(temp.path().join("home"), channels.clone()).unwrap();
    let project = engine
        .dispatch(json!({"action":"projects.create","title":"仅有图片资产"}))
        .unwrap();
    let pid = s(&project, "id");
    let store = engine.store(pid).unwrap();
    store
        .save_settings(&json!({"trialApproved":true,"codexPath":"Z:/absent-codex.exe"}))
        .unwrap();
    store.save_asset(json!({"id":"manual","variantId":"base","name":"手写形象","kind":"character","prompt":"完整的手写图片提示词","sourceRefs":[],"applicability":{"episodes":[],"scenes":[]}})).unwrap();
    let error = engine
        .dispatch(json!({"action":"images.design","projectId":pid}))
        .unwrap_err();
    assert!(error.contains("尚未导入剧本原文"));
    assert!(store.jobs().unwrap().is_empty());
    engine.dispatch(json!({"action":"images.produce","projectId":pid,"provider":"offline","model":"offline-image","assetIds":["manual"]})).unwrap();
    assert!(engine.await_worker_shutdown(2));
    let jobs = store.jobs().unwrap();
    assert_eq!(
        jobs.iter().filter(|job| s(job, "kind") == "text").count(),
        0
    );
    assert_eq!(
        jobs.iter().filter(|job| s(job, "kind") == "image").count(),
        1
    );
    assert_eq!(
        jobs.iter()
            .find(|job| s(job, "kind") == "workflow")
            .unwrap()["status"],
        "completed"
    );
    assert_eq!(
        channels.calls.load(Ordering::SeqCst),
        0,
        "queueing must not submit to the channel"
    );
}

#[test]
fn offline_startup_text_cli_status_never_reads_a_real_account_or_logs_in() {
    let f = Fixture::new(Duration::ZERO);
    let state = f.engine.dispatch(json!({"action":"textCli.status","projectId":f.project_id,"settings":{"codexPath":"Z:/absent-codex.exe"}})).unwrap();
    assert_eq!(state["diagnostic"], true);
    assert_eq!(state["generationRequestsSent"], 0);
    assert!(f
        .engine
        .dispatch(json!({"action":"textCli.login","projectId":f.project_id}))
        .is_err());
    assert!(f.store.jobs().unwrap().is_empty());
}
impl Fixture {
    fn new(delay: Duration) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let channels = Arc::new(OfflineChannels::new(delay));
        let engine = Engine::with_channels(temp.path().join("home"), channels.clone()).unwrap();
        let project = engine
            .dispatch(json!({"action":"projects.create","title":"offline repair acceptance"}))
            .unwrap();
        let project_id = s(&project, "id").to_owned();
        let store = engine.store(&project_id).unwrap();
        store.save_settings(&json!({"trialApproved":true,"textProvider":"api","textEndpoint":"","textModel":"offline-text","videoModel":""})).unwrap();
        let source = pipeline::prepare_source(
            "第1集\n场景：门口\n甲：走吧。\n第2集\n场景：院子\n甲：回来了。\n",
        )
        .unwrap();
        store
            .save_source(serde_json::to_value(source).unwrap())
            .unwrap();
        Self {
            _temp: temp,
            engine,
            store,
            project_id,
            channels,
        }
    }
    fn asset(&self, id: &str) {
        self.store.save_asset(json!({"id":id,"variantId":"base","baseAssetId":id,"name":id,"kind":"character","prompt":"offline complete asset design","sourceRefs":[],"applicability":{"episodes":[],"scenes":[]}})).unwrap();
    }
    fn image_action(&self, ids: Value) -> Value {
        json!({"action":"images.run","projectId":self.project_id,"provider":"offline","model":"offline-image","assetIds":ids,"trial":true})
    }
}

#[test]
fn zero_unit_storyboard_selects_source_episodes_and_versioned_planning_profile() {
    let f = Fixture::new(Duration::ZERO);
    assert!(f.store.values("units").unwrap().is_empty());
    let source = f.store.source().unwrap();
    let first = source["episodes"][0]["id"].clone();
    let second = source["episodes"][1]["id"].clone();
    let input = storyboard_input(&f.store, &json!({"episodeIds":[second,first]})).unwrap();
    assert_eq!(input["selection"]["episodeIds"], json!([first, second]));
    assert_eq!(input["capabilities"]["planningOnly"], true);
    assert_eq!(
        input["capabilities"]["version"],
        "storyboard-planning/seedance2.5/v1"
    );
    assert_eq!(input["capabilities"]["minDuration"], 4);
    assert_eq!(input["capabilities"]["maxDuration"], 30);
    assert_eq!(input["capabilities"]["imageLimit"], 30);
    assert_eq!(input["capabilities"]["videoLimit"], 10);
    assert_eq!(input["capabilities"]["audioLimit"], 10);
    assert!(input["previousBoundary"].is_null());
    for selection in [
        json!([]),
        json!(["outside-source"]),
        json!([first, first]),
        json!([5]),
    ] {
        assert!(f
            .engine
            .dispatch(
                json!({"action":"storyboard.run","projectId":f.project_id,"episodeIds":selection})
            )
            .is_err());
    }
    assert!(
        f.store.jobs().unwrap().is_empty(),
        "invalid selection must not create a workflow"
    );
    f.engine
        .dispatch(json!({"action":"storyboard.run","projectId":f.project_id,"episodeIds":[second]}))
        .unwrap();
    assert!(f.engine.await_worker_shutdown(2));
    let jobs = f.store.jobs().unwrap();
    let workflow = jobs
        .iter()
        .find(|job| s(job, "kind") == "workflow")
        .unwrap();
    assert_eq!(
        workflow["snapshot"]["selection"]["episodeIds"],
        json!([second])
    );
    assert_eq!(workflow["snapshot"]["sourceVersion"], source["version"]);
    assert_eq!(
        workflow["snapshot"]["planningProfile"]["planningOnly"],
        true
    );
    assert_eq!(f.channels.calls.load(Ordering::SeqCst), 0);
    assert!(
        !s(workflow, "error").contains("视频"),
        "the offline text failure must not be caused by absent video configuration"
    );
}

#[test]
fn explicit_video_model_requires_real_cached_adaptation_and_prior_boundary_is_ordered() {
    let f = Fixture::new(Duration::ZERO);
    f.store
        .save_settings(&json!({"videoModel":"selected-video","videoProvider":"offline"}))
        .unwrap();
    assert!(self_capabilities(&f.store).is_err());
    let caps = json!({"version":"cached/v2","models":[{"id":"selected-video","kind":"video","adapted":false,"minDuration":4,"maxDuration":15,"images":9,"videos":3,"audios":3}]});
    f.store
        .conn()
        .unwrap()
        .execute(
            "INSERT INTO catalogs VALUES('offline',?1,?2)",
            rusqlite::params![caps.to_string(), now()],
        )
        .unwrap();
    assert!(self_capabilities(&f.store).is_err());
    let mut verified = caps.clone();
    verified["models"][0]["adapted"] = json!(true);
    f.store
        .conn()
        .unwrap()
        .execute(
            "UPDATE catalogs SET data=?1 WHERE provider='offline'",
            [verified.to_string()],
        )
        .unwrap();
    let profile = self_capabilities(&f.store).unwrap();
    assert_eq!(profile["maxDuration"], 15);
    assert_eq!(profile["planningOnly"], false);
    assert_eq!(profile["version"], "cached/v2");
    let source = f.store.source().unwrap();
    let first = source["episodes"][0]["id"].clone();
    let second = source["episodes"][1]["id"].clone();
    let rows = source["rows"].as_array().unwrap();
    let prior = rows
        .iter()
        .find(|row| row["episodeId"] == first && s(row, "kind") == "body")
        .unwrap();
    f.store.save_unit(json!({"id":"previous-unit","episodeId":first,"sourceRefs":[prior["id"]],"exitState":"prior continuity","assetRefs":[]})).unwrap();
    f.store.save_unit(json!({"id":"future-unit","episodeId":second,"sourceRefs":[],"exitState":"future state","assetRefs":[]})).unwrap();
    let input = storyboard_input(&f.store, &json!({"episodeIds":[second]})).unwrap();
    assert_eq!(input["previousBoundary"]["id"], "previous-unit");
    assert_eq!(input["previousBoundary"]["exitState"], "prior continuity");
    assert!(
        storyboard_input(&f.store, &json!({"episodeIds":[first]})).unwrap()["previousBoundary"]
            .is_null()
    );
}

#[test]
fn unknown_closure_is_local_atomic_preserves_evidence_and_unlocks_new_explicit_work() {
    let f = Fixture::new(Duration::ZERO);
    f.asset("asset");
    let snapshot =
        json!({"requestId":"unknown-original","prompt":"unchanged original","assetVersion":1});
    let key = f
        .store
        .add_job(
            "image",
            "asset",
            "offline",
            "original-account",
            &snapshot,
            "submission_unknown",
        )
        .unwrap();
    f.store.update_job(&key,"submission_unknown",&json!({"prepared":{"wire":"original"},"receipt":{"opaque":"original"},"result":{"retained":true},"error":"original submission uncertainty"})).unwrap();
    let before = f.store.job(&key).unwrap();
    let action = json!({"action":"jobs.close_unknown","projectId":f.project_id,"jobId":key,"confirmedNotAccepted":true,"reason":"I checked the provider record and no task was accepted"});
    let mut invalid = action.clone();
    invalid["confirmedNotAccepted"] = json!(false);
    assert!(f.engine.dispatch(invalid).is_err());
    let mut invalid = action.clone();
    invalid["reason"] = json!("   ");
    assert!(f.engine.dispatch(invalid).is_err());
    assert!(
        f.engine.dispatch(f.image_action(json!(["asset"]))).is_err(),
        "unresolved submit must visibly block new generation"
    );
    let workspace = f.engine.dispatch(action.clone()).unwrap();
    let after = f.store.job(&key).unwrap();
    assert_eq!(after["status"], "closed_by_user");
    assert_eq!(after["submissionUnknown"], false);
    for field in ["snapshot", "prepared", "receipt", "result", "error"] {
        assert_eq!(
            after[field], before[field],
            "original {field} must be preserved"
        );
    }
    assert_eq!(workspace["jobs"][0]["submissionUnknown"], false);
    assert!(
        f.engine.dispatch(action).is_err(),
        "closing is a one-time CAS transition"
    );
    let record: String = f
        .store
        .conn()
        .unwrap()
        .query_row(
            "SELECT data FROM events WHERE job_id=?1 AND type='unknown_submission_closed_by_user'",
            [&key],
            |row| row.get(0),
        )
        .unwrap();
    let record: Value = serde_json::from_str(&record).unwrap();
    assert_eq!(record["confirmedNotAccepted"], true);
    assert_eq!(record["declaredBy"], "user");
    assert_eq!(record["channelOperationPerformed"], false);
    assert_eq!(f.channels.calls.load(Ordering::SeqCst), 0);
    let next = f.engine.dispatch(f.image_action(json!(["asset"]))).unwrap();
    assert_eq!(next["imageQueueReport"]["queuedCount"], 1);
    assert_eq!(f.store.jobs().unwrap().len(), 2);
    assert_eq!(
        f.channels.calls.load(Ordering::SeqCst),
        0,
        "local closure and explicit queueing must not invoke submit/query/download"
    );
    for (entity, state, remote) in [
        ("known", "submission_unknown", Some("known-cloud")),
        ("queued", "queued", None),
    ] {
        let key = f
            .store
            .add_job("image", entity, "offline", "a", &json!({}), state)
            .unwrap();
        if let Some(remote) = remote {
            f.store
                .update_job(&key, state, &json!({"providerTaskId":remote}))
                .unwrap();
        }
        assert!(f.engine.dispatch(json!({"action":"jobs.close_unknown","projectId":f.project_id,"jobId":key,"confirmedNotAccepted":true,"reason":"checked"})).is_err());
        assert_eq!(f.store.job(&key).unwrap()["status"], state);
    }
}

#[test]
fn image_batch_partial_queue_reports_active_unknown_and_missing_branches() {
    let f = Fixture::new(Duration::ZERO);
    f.asset("blocked");
    f.asset("ready");
    f.store
        .add_job(
            "image",
            "blocked",
            "offline",
            "a",
            &json!({}),
            "submission_unknown",
        )
        .unwrap();
    let workspace = f
        .engine
        .dispatch(f.image_action(json!(["blocked", "ready", "missing"])))
        .unwrap();
    let report = &workspace["imageQueueReport"];
    assert_eq!(report["queuedCount"], 1);
    assert_eq!(report["blockedCount"], 2);
    assert_eq!(report["queued"][0]["assetId"], "ready");
    assert!(report["blocked"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["assetId"] == "blocked" && item["status"] == "submission_unknown"));
    assert!(f
        .engine
        .dispatch(f.image_action(json!(["blocked"])))
        .unwrap_err()
        .contains("未知"));
    assert!(f
        .engine
        .dispatch(f.image_action(json!(["ready"])))
        .unwrap_err()
        .contains("已有图片任务"));
    assert_eq!(f.store.jobs().unwrap().len(), 2);
    assert_eq!(f.channels.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn worker_drain_returns_after_receipt_commit_and_shutdown_rejects_new_guards() {
    let f = Fixture::new(Duration::from_millis(150));
    f.asset("asset");
    let workspace = f.engine.dispatch(f.image_action(json!(["asset"]))).unwrap();
    let key = workspace["imageQueueReport"]["queued"][0]["jobId"]
        .as_str()
        .unwrap()
        .to_owned();
    let (config, account) = f.engine.config(&f.store, "offline").unwrap();
    let pipeline_guard = f
        .engine
        .acquire_keys(vec!["pipeline:waiting-final-write".into()])
        .unwrap();
    let store = f.store.clone();
    let channels = f.channels.clone();
    let worker_key = key.clone();
    f.engine
        .spawn_exclusive_keys(
            vec![format!("job:{key}"), "channel:offline".into()],
            move || {
                tasks::run_generation(&store, &worker_key, &config, &account, channels.as_ref())
            },
        )
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !f.channels.submitting.load(Ordering::SeqCst) {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    f.engine.stop.store(true, Ordering::SeqCst);
    assert!(!f.engine.await_channel_shutdown(0));
    assert!(f
        .engine
        .acquire_keys(vec!["channel:rejected".into()])
        .is_err());
    assert!(f.engine.await_channel_shutdown(2));
    let job = f.store.job(&key).unwrap();
    assert_eq!(job["status"], "submitted");
    assert_eq!(job["providerTaskId"], "offline-durable-original-id");
    assert_eq!(job["receipt"]["taskId"], "offline-durable-original-id");
    assert!(
        !f.engine.await_worker_shutdown(0),
        "all-worker drain must include final pipeline writes"
    );
    f.store
        .event("", "pipeline_final_write", &json!({"persisted":true}))
        .unwrap();
    drop(pipeline_guard);
    assert!(f.engine.await_worker_shutdown(2));
    assert!(
        f.engine.await_worker_shutdown(0),
        "repeated drain calls are safe"
    );
    assert_eq!(f.channels.calls.load(Ordering::SeqCst), 2);
}

struct ScriptedStoryboard;
#[async_trait::async_trait]
impl pipeline::TextExecutor for ScriptedStoryboard {
    async fn execute(&self, request: pipeline::TextRequest) -> Result<Value> {
        assert_eq!(request.input["capabilities"]["planningOnly"], true);
        assert_eq!(request.input["capabilities"]["maxTotalReferences"], 50);
        let row = &request.input["sourceRows"][0];
        let episode = if request.stage == "storyboardPlan" {
            request.input["episode"]["id"].clone()
        } else {
            request.input["episodeId"].clone()
        };
        let emotion =
            json!({"subject":"甲","change":"决定行动","landing":"开口","retain":["原话"]});
        if request.stage == "storyboardPlan" {
            return Ok(
                json!({"schemaVersion":"storyboard-plan/v2","unitPackingPolicy":"event-first-v1","emotionArc":"决定行动","events":[{"id":"event","sceneId":row["sceneId"],"sourceRefs":[row["id"]],"boundaryBefore":{"kind":"episode_start","reason":"当前源集开始"},"emotionContract":{"subject":"甲","contextTone":"当前源情境","audienceEffect":"行动决定可读","change":"决定行动","landing":"开口","retain":["原话"]}}],"workPackages":[{"id":"package","eventId":"event","sourceRefs":[row["id"]],"contextRefs":[],"entryFactIds":[],"dependsOn":[],"scenarioKeys":[],"emotionContract":{"subject":"甲","contextTone":"当前源情境","audienceEffect":"行动决定可读","change":"决定行动","landing":"开口","retain":["原话"]}}],"provisionalUnits":[{"id":"provisional","packageId":"package","sourceRefs":[row["id"]],"secondsRange":[5,5]}],"entryFacts":[],"fantasyCandidates":[]}),
            );
        }
        if request.stage == "storyboardFinish" {
            let mut draft = request.input["draft"].clone();
            draft["schemaVersion"] = json!("storyboard-draft/v2");
            draft["revisionNotes"] = json!([]);
            draft["unresolved"] = json!([]);
            return Ok(draft);
        }
        let dialogue = &row["dialogue"];
        Ok(
            json!({"schemaVersion":"storyboard-draft/v2","units":[{"id":"unit","episodeId":episode,"eventId":"event","sceneId":row["sceneId"],"boundaryBefore":{"kind":"episode_start","reason":"当前源集开始"},"title":"甲开口","unitDirection":"甲抬头说话。","intent":emotion,"scene":"原文指定场景","participants":["甲"],"props":[],"lighting":"自然侧光","initialState":"甲站定。","exitState":"甲说完后看向门口。","sourceRefs":[row["id"]],"assetRefs":[],"shots":[{"id":"shot","duration":5.0,"camera":"近景","picture":"甲抬头开口。","lighting":"自然侧光","sound":"环境声与现场对白","dialogueParts":[{"lineId":dialogue["id"],"quoteStart":dialogue["spokenSegments"][0]["range"]["start"],"quoteEnd":dialogue["spokenSegments"][0]["range"]["end"],"presentation":"画内","delivery":"自然说话","voiceStart":0.0,"voiceEnd":2.0}],"transition":"切","sourceRefs":[row["id"]],"contextRefs":[]}]}],"fantasyRealization":[],"revisionNotes":[],"unresolved":[]}),
        )
    }
}

#[tokio::test]
async fn planning_profile_generates_all_selected_episodes_with_exact_dialogue_and_no_video_model() {
    let f = Fixture::new(Duration::ZERO);
    let source = f.store.source().unwrap();
    let first = source["episodes"][0]["id"].clone();
    let second = source["episodes"][1]["id"].clone();
    let input = storyboard_input(&f.store, &json!({"episodeIds":[second,first]})).unwrap();
    let output = pipeline::run_storyboard(&input, &ScriptedStoryboard, "offline", "medium")
        .await
        .unwrap();
    assert!(
        output["blocked"].as_array().unwrap().is_empty(),
        "{:?}",
        output["blocked"]
    );
    let units = output["units"].as_array().unwrap();
    assert_eq!(units.len(), 2);
    assert_eq!(units[0]["episodeId"], first);
    assert_eq!(units[1]["episodeId"], second);
    assert!(s(&units[0], "prompt").contains("走吧。"));
    assert!(s(&units[1], "prompt").contains("回来了。"));
    assert_eq!(
        units[0]["sourceCoverage"][0]["rowId"],
        source["rows"][2]["id"]
    );
    let input = storyboard_input(&f.store, &json!({"episodeIds":[second]})).unwrap();
    let filtered = pipeline::run_storyboard(&input, &ScriptedStoryboard, "offline", "medium")
        .await
        .unwrap();
    assert!(
        filtered["blocked"].as_array().unwrap().is_empty(),
        "{:?}",
        filtered["blocked"]
    );
    assert_eq!(filtered["units"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["units"][0]["episodeId"], second);
    assert_eq!(f.channels.calls.load(Ordering::SeqCst), 0);
}
