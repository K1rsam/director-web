//! Engine preflight boundaries only: no CLI, credentials, paid calls or production databases.
//! Provider prepare/submit retain their own independent capability validation.
use director_core::{
    pipeline,
    providers::*,
    store::{now, s, Store},
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

struct MockChannel {
    capability: Mutex<Value>,
    fail: Mutex<bool>,
    change_during_read: Mutex<Option<Store>>,
    capabilities: AtomicUsize,
    prepares: AtomicUsize,
    submits: AtomicUsize,
    queries: AtomicUsize,
}
impl MockChannel {
    fn new() -> Self {
        Self {
            capability: Mutex::new(
                json!({"provider":"offline","version":"offline/v1","source":"offline fixture","checkedAt":now(),"models":[{"id":"video","kind":"video","adapted":true,"minDuration":4,"maxDuration":15,"allowedDurations":[],"ratios":["16:9","9:16"],"resolutions":["720p","1080p"],"images":9,"videos":3,"audios":3,"totalReferences":12,"requiredImages":0,"raw":{}}],"canCancel":false,"canReconcileUnknown":false,"raw":{}}),
            ),
            fail: Mutex::new(false),
            change_during_read: Mutex::new(None),
            capabilities: AtomicUsize::new(0),
            prepares: AtomicUsize::new(0),
            submits: AtomicUsize::new(0),
            queries: AtomicUsize::new(0),
        }
    }
    fn assert_no_submission(&self) {
        assert_eq!(self.submits.load(Ordering::SeqCst), 0);
    }
}
impl Channels for MockChannel {
    fn capabilities(&self, _: &ProviderConfig) -> ProviderResult<Capabilities> {
        self.capabilities.fetch_add(1, Ordering::SeqCst);
        if let Some(store) = self.change_during_read.lock().unwrap().take() {
            store
                .save_settings(&json!({"adaptedModels":["changed-during-capability-request"]}))
                .unwrap();
        }
        if *self.fail.lock().unwrap() {
            return Err(ProviderError::new("OFFLINE", "能力刷新失败"));
        }
        let mut value = self.capability.lock().unwrap().clone();
        value["checkedAt"] = json!(now());
        Ok(serde_json::from_value(value).unwrap())
    }
    fn prepare(
        &self,
        _: &ProviderConfig,
        request: &GenerationRequest,
    ) -> ProviderResult<PreparedRequest> {
        self.prepares.fetch_add(1, Ordering::SeqCst);
        Ok(PreparedRequest {
            provider: "offline".into(),
            request: request.clone(),
            capability_version: s(&self.capability.lock().unwrap(), "version").into(),
            upload_receipts: vec![],
            wire: json!({"offline":true}),
            estimated_cost: None,
            prepared_at: now(),
        })
    }
    fn submit(&self, _: &ProviderConfig, _: &PreparedRequest) -> ProviderResult<SubmitReceipt> {
        self.submits.fetch_add(1, Ordering::SeqCst);
        Ok(SubmitReceipt {
            task_id: "original-task".into(),
            status: "processing".into(),
            result_urls: vec![],
            raw: json!({"fixture":true}),
        })
    }
    fn query(&self, _: &ProviderConfig, id: &str) -> ProviderResult<QueryResult> {
        assert_eq!(id, "original-task");
        self.queries.fetch_add(1, Ordering::SeqCst);
        Ok(QueryResult {
            task_id: id.into(),
            status: "processing".into(),
            result_urls: vec![],
            error: None,
            actual_cost: None,
            raw: json!({"fixture":true}),
        })
    }
    fn download(&self, _: &ProviderConfig, _: &str, _: &Path) -> ProviderResult<DownloadReceipt> {
        panic!("this preflight test must not download")
    }
    fn reconcile(&self, _: &ProviderConfig, _: &str) -> ProviderResult<QueryResult> {
        panic!("unknown submissions must not be reconciled by preflight")
    }
}
struct Fixture {
    _temp: TempDir,
    engine: Arc<Engine>,
    store: Store,
    id: String,
    channel: Arc<MockChannel>,
}
impl Fixture {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        let channel = Arc::new(MockChannel::new());
        let engine = Engine::with_channels(temp.path().join("home"), channel.clone()).unwrap();
        let p = engine
            .dispatch(json!({"action":"projects.create","title":"视频前检离线回归"}))
            .unwrap();
        let id = s(&p, "id").to_owned();
        let store = engine.store(&id).unwrap();
        store.save_settings(&json!({"offlineAccountId":"original","videoProvider":"offline","videoModel":"video","ratio":"16:9","videoResolution":"720p","textProvider":"api","textEndpoint":""})).unwrap();
        let source = serde_json::to_value(
            pipeline::prepare_source("第1集\n场景：门口\n甲：走吧。\n").unwrap(),
        )
        .unwrap();
        store.save_source(source.clone()).unwrap();
        let row = source["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| s(r, "kind") == "body")
            .unwrap();
        store.save_asset(json!({"id":"reference","variantId":"base","name":"甲","kind":"CH","prompt":"完整人物设计","sourceRefs":[row["id"]]})).unwrap();
        let path = temp.path().join("reference.png");
        image::RgbImage::from_pixel(4, 3, image::Rgb([10, 20, 30]))
            .save(&path)
            .unwrap();
        let media = store
            .import_media(&path, "image", Some("reference"), Some("base"))
            .unwrap();
        store.adopt("reference", "base", s(&media, "id")).unwrap();
        for uid in ["u1", "u2"] {
            store.save_unit(json!({"id":uid,"episodeId":source["episodes"][0]["id"],"sceneId":source["scenes"][0]["id"],"sourceRefs":[row["id"]],"duration":5,"prompt":"{{asset:reference:base}} 甲在门口抬头，说走吧。","assetRefs":[{"assetId":"reference","variantId":"base","order":0}]})).unwrap();
        }
        Self {
            _temp: temp,
            engine,
            store,
            id,
            channel,
        }
    }
    fn bootstrap(&self) -> Result<Value, String> {
        self.engine
            .dispatch(json!({"action":"videos.preflight","projectId":self.id,"provider":"offline"}))
    }
    fn request(
        &self,
        action: &str,
        units: Value,
        ratio: &str,
        resolution: &str,
    ) -> Result<Value, String> {
        self.engine.dispatch(json!({"action":action,"projectId":self.id,"unitIds":units,"provider":"offline","model":"video","ratio":ratio,"resolution":resolution}))
    }
    fn prepare_ready(&self) -> String {
        let result = self
            .request("videos.prepare", json!(["u1"]), "16:9", "720p")
            .unwrap();
        let job = s(&result["videoQueueReport"]["queued"][0], "jobId").to_owned();
        self.run(&job);
        assert_eq!(self.store.job(&job).unwrap()["status"], "ready");
        job
    }
    fn run(&self, job: &str) {
        let (config, account) = self.engine.config(&self.store, "offline").unwrap();
        tasks::run_generation(&self.store, job, &config, &account, self.channel.as_ref()).unwrap();
    }
    fn expire(&self) {
        self.store
            .conn()
            .unwrap()
            .execute("UPDATE catalogs SET fetched_at='2000-01-01T00:00:00Z'", [])
            .unwrap();
    }
}

#[test]
fn successful_current_cache_is_reused_without_extra_engine_capability_requests() {
    let f = Fixture::new();
    assert_eq!(
        f.bootstrap().unwrap()["videoPreflight"]["source"],
        "refreshed"
    );
    assert_eq!(f.bootstrap().unwrap()["videoPreflight"]["source"], "cache");
    let job = f.prepare_ready();
    assert_eq!(f.channel.capabilities.load(Ordering::SeqCst), 1);
    f.channel.assert_no_submission();
    let snapshot = f.store.job(&job).unwrap()["snapshot"].clone();
    assert_eq!(snapshot["capabilityVersion"], "offline/v1");
    assert_eq!(snapshot["references"].as_array().unwrap().len(), 1);
    let result = f
        .request("videos.submit", json!(["u1"]), "16:9", "720p")
        .unwrap();
    assert_eq!(result["videoQueueReport"]["queuedCount"], 1);
    f.run(&job);
    assert_eq!(f.channel.submits.load(Ordering::SeqCst), 1);
    assert_eq!(f.channel.capabilities.load(Ordering::SeqCst), 1);
    let submitted = f.store.job(&job).unwrap();
    assert_eq!(submitted["providerTaskId"], "original-task");
    assert_eq!(submitted["snapshot"]["references"], snapshot["references"]);
}

#[test]
fn read_only_bootstrap_never_saves_video_parameters_or_prepares_jobs() {
    let f = Fixture::new();
    let settings = f.store.settings().unwrap();
    f.bootstrap().unwrap();
    assert_eq!(f.store.settings().unwrap(), settings);
    assert!(f.store.job_summaries().unwrap().is_empty());
    assert_eq!(f.channel.prepares.load(Ordering::SeqCst), 0);
    f.channel.assert_no_submission();
}

#[test]
fn manual_refresh_seeds_same_bound_cache() {
    let f = Fixture::new();
    f.engine
        .dispatch(json!({"action":"providers.refresh","projectId":f.id,"provider":"offline"}))
        .unwrap();
    assert_eq!(f.bootstrap().unwrap()["videoPreflight"]["source"], "cache");
    assert_eq!(f.channel.capabilities.load(Ordering::SeqCst), 1);
    f.channel.assert_no_submission();
}

#[test]
fn missing_binding_expiry_and_configuration_changes_force_refresh() {
    let f = Fixture::new();
    f.bootstrap().unwrap();
    f.expire();
    assert_eq!(
        f.bootstrap().unwrap()["videoPreflight"]["source"],
        "refreshed"
    );
    f.store
        .conn()
        .unwrap()
        .execute(
            "DELETE FROM metadata WHERE key='capability_binding:offline'",
            [],
        )
        .unwrap();
    f.bootstrap().unwrap();
    f.store
        .save_settings(&json!({"adaptedModels":["new-registry"]}))
        .unwrap();
    f.bootstrap().unwrap();
    assert_eq!(f.channel.capabilities.load(Ordering::SeqCst), 4);
    f.channel.assert_no_submission();
}

#[test]
fn unavailable_refresh_rejects_generation_and_keeps_existing_frozen_materials() {
    let f = Fixture::new();
    let job = f.prepare_ready();
    let before = f.store.job(&job).unwrap();
    f.expire();
    *f.channel.fail.lock().unwrap() = true;
    assert!(f
        .request("videos.submit", json!(["u1"]), "16:9", "720p")
        .unwrap_err()
        .contains("能力刷新失败"));
    let after = f.store.job(&job).unwrap();
    assert_eq!(after["snapshot"], before["snapshot"]);
    assert_eq!(after["prepared"], before["prepared"]);
    assert_eq!(after["status"], "ready");
    f.channel.assert_no_submission();
}

#[test]
fn unadapted_wrong_kind_unknown_models_and_illegal_dimensions_fail_before_saving() {
    for (field, value) in [
        ("kind", json!("image")),
        ("adapted", json!(false)),
        ("id", json!("different-model")),
    ] {
        let f = Fixture::new();
        let old = f.store.settings().unwrap();
        f.channel.capability.lock().unwrap()["models"][0][field] = value;
        assert!(f
            .request("videos.prepare", json!(["u1"]), "16:9", "720p")
            .is_err());
        assert_eq!(f.store.settings().unwrap(), old);
        assert!(f.store.job_summaries().unwrap().is_empty());
        f.channel.assert_no_submission();
    }
    for (ratio, size) in [("4:3", "720p"), ("16:9", "4k")] {
        let f = Fixture::new();
        let old = f.store.settings().unwrap();
        assert!(f
            .request("videos.prepare", json!(["u1"]), ratio, size)
            .is_err());
        assert_eq!(f.store.settings().unwrap(), old);
        assert!(f.store.job_summaries().unwrap().is_empty());
        f.channel.assert_no_submission();
    }
}

#[test]
fn account_hint_or_frozen_account_mismatch_never_enables_submission() {
    let f = Fixture::new();
    assert!(f.engine.dispatch(json!({"action":"videos.preflight","projectId":f.id,"provider":"offline","expectedAccountKey":"other-account"})).is_err());
    assert_eq!(f.channel.capabilities.load(Ordering::SeqCst), 0);
    let job = f.prepare_ready();
    f.store
        .conn()
        .unwrap()
        .execute(
            "UPDATE jobs SET account_id='other-account' WHERE id=?1",
            [&job],
        )
        .unwrap();
    assert!(f
        .request("videos.submit", json!(["u1"]), "16:9", "720p")
        .unwrap_err()
        .contains("其他账户"));
    assert_eq!(f.store.job(&job).unwrap()["snapshot"]["autoSubmit"], false);
    f.channel.assert_no_submission();
}

#[test]
fn changed_parameters_require_new_frozen_package_and_preserve_original_cloud_tasks() {
    let f = Fixture::new();
    let old = f.prepare_ready();
    let known = f
        .store
        .add_job(
            "video",
            "known",
            "offline",
            "account",
            &json!({"model":"video","ratio":"16:9","resolution":"720p"}),
            "processing",
        )
        .unwrap();
    f.store.update_job(&known,"processing",&json!({"providerTaskId":"original-task","receipt":{"taskId":"original-task","raw":{"original":true}}})).unwrap();
    let before = f.store.job(&known).unwrap();
    assert!(f
        .request("videos.submit", json!(["u1"]), "9:16", "1080p")
        .is_err());
    let result = f
        .request("videos.prepare", json!(["u1"]), "9:16", "1080P")
        .unwrap();
    assert_eq!(result["settings"]["videoResolution"], "1080p");
    assert_eq!(f.store.job(&old).unwrap()["status"], "stale");
    let after = f.store.job(&known).unwrap();
    assert_eq!(after["snapshot"], before["snapshot"]);
    assert_eq!(after["receipt"], before["receipt"]);
    assert_eq!(after["providerTaskId"], before["providerTaskId"]);
    assert_eq!(after["status"], "processing");
    f.channel.assert_no_submission();
}

#[test]
fn saving_parameters_and_staling_is_atomic_and_targets_images_only_for_shared_ratio() {
    let f = Fixture::new();
    f.prepare_ready();
    let image = f
        .store
        .add_job(
            "image",
            "img",
            "offline",
            "account",
            &json!({"ratio":"16:9"}),
            "queued",
        )
        .unwrap();
    let unknown = f
        .store
        .add_job(
            "video",
            "unknown",
            "offline",
            "account",
            &json!({"ratio":"16:9"}),
            "submission_unknown",
        )
        .unwrap();
    f.request("videos.prepare", json!(["u2"]), "16:9", "1080p")
        .unwrap();
    assert_eq!(f.store.job(&image).unwrap()["status"], "queued");
    let settings = f.store.settings().unwrap();
    let changed: String = f
        .store
        .conn()
        .unwrap()
        .query_row(
            "SELECT value FROM metadata WHERE key='changed_at'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    f.store.conn().unwrap().execute_batch("CREATE TRIGGER reject_stale BEFORE UPDATE OF state ON jobs WHEN NEW.state='stale' BEGIN SELECT RAISE(ABORT,'fixture stale failure'); END;").unwrap();
    assert!(f
        .request("videos.prepare", json!(["u1"]), "9:16", "720p")
        .is_err());
    assert_eq!(f.store.settings().unwrap(), settings);
    assert_eq!(
        f.store
            .conn()
            .unwrap()
            .query_row::<String, _, _>(
                "SELECT value FROM metadata WHERE key='changed_at'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
        changed
    );
    assert_eq!(f.store.job(&image).unwrap()["status"], "queued");
    f.store
        .conn()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_stale")
        .unwrap();
    f.request("videos.prepare", json!(["u1"]), "9:16", "720p")
        .unwrap();
    assert_eq!(f.store.job(&image).unwrap()["status"], "stale");
    assert_eq!(
        f.store.job(&unknown).unwrap()["status"],
        "submission_unknown"
    );
    f.channel.assert_no_submission();
}

#[test]
fn refreshed_capability_version_stales_unsubmitted_package_and_keeps_snapshot() {
    let f = Fixture::new();
    let job = f.prepare_ready();
    let before = f.store.job(&job).unwrap()["snapshot"].clone();
    f.expire();
    f.channel.capability.lock().unwrap()["version"] = json!("offline/v2");
    assert!(f
        .request("videos.submit", json!(["u1"]), "16:9", "720p")
        .is_err());
    let after = f.store.job(&job).unwrap();
    assert_eq!(after["status"], "stale");
    assert_eq!(after["snapshot"], before);
    assert_eq!(after["prepared"]["capabilityVersion"], "offline/v1");
    f.channel.assert_no_submission();
}

#[test]
fn partial_submit_only_enables_ready_units_and_never_creates_missing_packages() {
    let f = Fixture::new();
    let job = f.prepare_ready();
    let report = f
        .request("videos.submit", json!(["u1", "u2"]), "16:9", "720p")
        .unwrap()["videoQueueReport"]
        .clone();
    assert_eq!(report["queuedCount"], 1);
    assert_eq!(report["blockedCount"], 1);
    assert_eq!(report["blocked"][0]["unitId"], "u2");
    assert_eq!(f.store.job_summaries().unwrap().len(), 1);
    assert_eq!(f.store.job(&job).unwrap()["snapshot"]["autoSubmit"], true);
    f.channel.assert_no_submission();
}

#[test]
fn known_cloud_id_recovery_ignores_missing_catalog_and_unknown_is_not_resubmitted() {
    let f = Fixture::new();
    let job = f.prepare_ready();
    f.store.update_job(&job,"processing",&json!({"providerTaskId":"original-task","receipt":{"taskId":"original-task","raw":{"original":true}}})).unwrap();
    f.store
        .conn()
        .unwrap()
        .execute("DELETE FROM catalogs", [])
        .unwrap();
    *f.channel.fail.lock().unwrap() = true;
    let caps = f.channel.capabilities.load(Ordering::SeqCst);
    f.engine
        .dispatch(json!({"action":"jobs.query","projectId":f.id,"jobId":job}))
        .unwrap();
    assert!(f.engine.await_channel_shutdown(3));
    assert_eq!(f.channel.queries.load(Ordering::SeqCst), 1);
    assert_eq!(f.channel.capabilities.load(Ordering::SeqCst), caps);
    let unknown = f
        .store
        .add_job(
            "video",
            "u2",
            "offline",
            "account",
            &json!({"originalUnknown":true}),
            "submission_unknown",
        )
        .unwrap();
    *f.channel.fail.lock().unwrap() = false;
    assert!(f
        .request("videos.prepare", json!(["u2"]), "16:9", "720p")
        .is_err());
    assert_eq!(
        f.store.job(&unknown).unwrap()["status"],
        "submission_unknown"
    );
    f.channel.assert_no_submission();
}

#[test]
fn configuration_changed_during_request_cannot_stamp_old_response_as_fresh() {
    for action in ["videos.preflight", "providers.refresh"] {
        let f = Fixture::new();
        *f.channel.change_during_read.lock().unwrap() = Some(f.store.clone());
        assert!(f
            .engine
            .dispatch(json!({"action":action,"projectId":f.id,"provider":"offline"}))
            .unwrap_err()
            .contains("核实时发生变化"));
        assert_eq!(
            f.store
                .conn()
                .unwrap()
                .query_row::<i64, _, _>("SELECT count(*) FROM catalogs", [], |r| r.get(0))
                .unwrap(),
            0
        );
        assert_eq!(
            f.store
                .conn()
                .unwrap()
                .query_row::<i64, _, _>(
                    "SELECT count(*) FROM metadata WHERE key='capability_binding:offline'",
                    [],
                    |r| r.get(0)
                )
                .unwrap(),
            0
        );
        f.channel.assert_no_submission();
    }
}
