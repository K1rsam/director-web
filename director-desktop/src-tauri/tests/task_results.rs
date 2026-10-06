//! Offline recovery through the real task/store pipeline. No CLI, HTTP or generation.
//! Video fixtures deliberately have unverified metadata; these tests certify task
//! identity, durable files and links, not playable video or generated picture quality.
use director_core::{
    providers::*,
    store::{hash_file, s, Store},
    tasks::{self, Channels},
    Engine,
};
use serde_json::{json, Value};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tempfile::TempDir;

const TASK: &str = "original-cloud-task";
const ACCOUNT: &str = "offline-account";

struct RecoveryChannel {
    expected_task: String,
    responses: Mutex<VecDeque<ProviderResult<QueryResult>>>,
    query_ids: Mutex<Vec<String>>,
    query_kinds: Mutex<Vec<String>>,
    download_urls: Mutex<Vec<String>>,
    fail_download_once: Mutex<HashSet<String>>,
    corrupt_once: Mutex<HashSet<String>>,
    prepares: AtomicUsize,
    submits: AtomicUsize,
}
impl RecoveryChannel {
    fn new(responses: Vec<ProviderResult<QueryResult>>) -> Self {
        Self::for_task(TASK, responses)
    }
    fn for_task(task: &str, responses: Vec<ProviderResult<QueryResult>>) -> Self {
        Self {
            expected_task: task.into(),
            responses: Mutex::new(responses.into()),
            query_ids: Mutex::new(vec![]),
            query_kinds: Mutex::new(vec![]),
            download_urls: Mutex::new(vec![]),
            fail_download_once: Mutex::new(HashSet::new()),
            corrupt_once: Mutex::new(HashSet::new()),
            prepares: AtomicUsize::new(0),
            submits: AtomicUsize::new(0),
        }
    }
    fn assert_no_generation(&self) {
        assert_eq!(self.prepares.load(Ordering::SeqCst), 0);
        assert_eq!(self.submits.load(Ordering::SeqCst), 0);
        assert!(self
            .query_ids
            .lock()
            .unwrap()
            .iter()
            .all(|id| id == &self.expected_task));
    }
}
impl Channels for RecoveryChannel {
    fn capabilities(&self, _: &ProviderConfig) -> ProviderResult<Capabilities> {
        panic!("recovery must not need a new generation capability check")
    }
    fn prepare(
        &self,
        _: &ProviderConfig,
        _: &GenerationRequest,
    ) -> ProviderResult<PreparedRequest> {
        self.prepares.fetch_add(1, Ordering::SeqCst);
        Err(ProviderError::new("FORBIDDEN", "recovery entered prepare"))
    }
    fn submit(&self, _: &ProviderConfig, _: &PreparedRequest) -> ProviderResult<SubmitReceipt> {
        self.submits.fetch_add(1, Ordering::SeqCst);
        Err(ProviderError::uncertain("recovery entered submit"))
    }
    fn query(&self, _: &ProviderConfig, id: &str) -> ProviderResult<QueryResult> {
        self.query_ids.lock().unwrap().push(id.into());
        assert_eq!(
            id, self.expected_task,
            "recovery must query only the persisted cloud ID"
        );
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected additional query")
    }
    fn query_for_kind(
        &self,
        config: &ProviderConfig,
        id: &str,
        kind: &str,
    ) -> ProviderResult<QueryResult> {
        self.query_kinds.lock().unwrap().push(kind.into());
        self.query(config, id)
    }
    fn download(
        &self,
        _: &ProviderConfig,
        url: &str,
        path: &Path,
    ) -> ProviderResult<DownloadReceipt> {
        self.download_urls.lock().unwrap().push(url.into());
        if self.fail_download_once.lock().unwrap().remove(url) {
            return Err(ProviderError::new(
                "URL_EXPIRED",
                "signed download URL expired",
            ));
        }
        if self.corrupt_once.lock().unwrap().remove(url) {
            fs::write(path, b"not-an-image").unwrap();
        } else if path.extension().unwrap() == "png" {
            // The logical content stays stable when only signed URL parameters change.
            let logical = url.split('?').next().unwrap();
            let tone = logical.bytes().fold(0_u8, u8::wrapping_add);
            image::RgbImage::from_pixel(2, 2, image::Rgb([tone, 40, 90]))
                .save(path)
                .unwrap();
        } else {
            let logical = url.split('?').next().unwrap();
            fs::write(path, format!("offline-unverified-video-fixture:{logical}")).unwrap();
        }
        let (sha256, bytes) = hash_file(path).unwrap();
        Ok(DownloadReceipt {
            path: path.into(),
            sha256,
            bytes,
            mime: Some(if path.extension().unwrap() == "png" {
                "image/png".into()
            } else {
                "video/mp4".into()
            }),
        })
    }
    fn reconcile(&self, _: &ProviderConfig, _: &str) -> ProviderResult<QueryResult> {
        panic!("known cloud ID recovery must not reconcile a new submission")
    }
}

struct Fixture {
    _tmp: TempDir,
    store: Store,
    key: String,
    snapshot: Value,
    receipt: Value,
}
impl Fixture {
    fn new(kind: &str, state: &str) -> Self {
        let tmp = TempDir::new().unwrap();
        let store = Store::open(tmp.path().join("project")).unwrap();
        store.create("offline recovery", "test-project").unwrap();
        store
            .save_asset(
                json!({"id":"asset","variantId":"base","name":"fixture","prompt":"offline"}),
            )
            .unwrap();
        // Do not start a real metadata tool for deliberately synthetic video bytes.
        store
            .save_settings(&json!({"ffprobePath":tmp.path().join("absent-ffprobe.exe")}))
            .unwrap();
        let snapshot = json!({"requestId":"original-request","kind":kind,"assetId":"asset","assetVersion":1,"variantId":"base","prompt":"immutable offline prompt","references":[{"mediaId":"original-reference","order":0}],"autoSubmit":true,"rules":{"version":"frozen-v1"}});
        let receipt = json!({"taskId":TASK,"status":"processing","resultUrls":[],"raw":{"task_id":TASK,"gen_status":"querying","receiptEvidence":"original"}});
        let key = store
            .add_job(kind, "asset", "mock", ACCOUNT, &snapshot, state)
            .unwrap();
        store
            .update_job(
                &key,
                state,
                &json!({"providerTaskId":TASK,"receipt":receipt}),
            )
            .unwrap();
        Self {
            _tmp: tmp,
            store,
            key,
            snapshot,
            receipt,
        }
    }
    fn resume(&self, channel: &RecoveryChannel, download: bool) {
        tasks::resume_job(
            &self.store,
            &self.key,
            &config(),
            ACCOUNT,
            channel,
            download,
        )
        .unwrap();
    }
    fn restart(&mut self) {
        self.store = Store::open(self.store.root.clone()).unwrap();
        self.store.recover_interrupted().unwrap();
    }
    fn job(&self) -> Value {
        self.store.job(&self.key).unwrap()
    }
    fn assert_original(&self) {
        let job = self.job();
        assert_eq!(job["providerTaskId"], TASK);
        assert_eq!(job["snapshot"], self.snapshot);
        assert_eq!(job["receipt"], self.receipt);
        assert_eq!(job["submissionUnknown"], false);
    }
    fn assert_media(&self, count: usize, kind: &str) {
        let job = self.job();
        let ids = job["resultMediaIds"].as_array().unwrap();
        assert_eq!(ids.len(), count);
        if job["result"].is_object() || count > 0 {
            assert_eq!(job["result"]["mediaIds"], json!(ids));
        }
        for id in ids {
            let media = self.store.get("media", id.as_str().unwrap()).unwrap();
            assert_eq!(media["kind"], kind);
            assert!(self.store.verify_media(&media).unwrap().is_file());
            assert_eq!(media["metadataVerified"], kind == "image");
        }
    }
}
fn config() -> ProviderConfig {
    serde_json::from_value(json!({"kind":"mock"})).unwrap()
}
fn prepared(kind: &str) -> PreparedRequest {
    PreparedRequest {
        provider: "mock".into(),
        request: GenerationRequest {
            request_id: "original-request".into(),
            kind: kind.into(),
            model: "offline-model".into(),
            prompt: "immutable offline prompt".into(),
            duration: if kind == "video" { Some(5) } else { None },
            ratio: "16:9".into(),
            resolution: "2k".into(),
            references: vec![],
            options: json!({}),
        },
        capability_version: "frozen-v1".into(),
        upload_receipts: vec![],
        wire: json!({"fixture":"saved-preparation"}),
        estimated_cost: Some(2.5),
        prepared_at: "offline-time".into(),
    }
}
fn response(kind: &str, status: &str, urls: &[&str]) -> QueryResult {
    // The image shape is observed official JSON. Video intentionally uses only the
    // normalized provider contract; no unverified official container shape is invented.
    let raw = if kind == "image" && status == "succeeded" {
        json!({"task_id":TASK,"gen_status":"success","result_json":{"images":[{"image_url":"https://offline.test/image-a?fresh"}]}})
    } else {
        json!({"fixture":"normalized-provider-query","kind":kind,"status":status})
    };
    QueryResult {
        task_id: TASK.into(),
        status: status.into(),
        result_urls: urls.iter().map(|v| (*v).into()).collect(),
        error: None,
        actual_cost: Some(2.5),
        raw,
    }
}

fn success_missing_addresses_recovers(kind: &str) {
    let mut fixture = Fixture::new(kind, "submitted");
    let missing = response(kind, "succeeded", &[]);
    let channel = RecoveryChannel::new(vec![
        Ok(missing.clone()),
        Ok(response(
            kind,
            "succeeded",
            &["https://offline.test/result-a?fresh"],
        )),
    ]);
    fixture.resume(&channel, true);
    let job = fixture.job();
    assert_eq!(job["status"], "query_failed");
    assert!(s(&job, "error").contains("生成完成"));
    assert!(s(&job, "error").contains("不会重新提交"));
    assert_eq!(job["result"]["raw"], missing.raw);
    assert_eq!(job["queryAttempts"], 1);
    assert_eq!(job["downloadAttempts"], 0);
    assert!(job["nextAttemptAt"].as_i64().unwrap() > chrono::Utc::now().timestamp());
    assert!(fixture
        .store
        .pending_jobs()
        .unwrap()
        .iter()
        .any(|j| j["id"] == fixture.key));
    assert!(channel.download_urls.lock().unwrap().is_empty());
    fixture.assert_original();
    fixture.restart();
    // A scheduler accidentally routing a recoverable task to generation remains harmless.
    tasks::run_generation(&fixture.store, &fixture.key, &config(), ACCOUNT, &channel).unwrap();
    fixture.resume(&channel, true);
    assert_eq!(fixture.job()["status"], "downloaded");
    fixture.assert_media(1, kind);
    fixture.assert_original();
    assert_eq!(channel.query_ids.lock().unwrap().len(), 2);
    channel.assert_no_generation();
}
#[test]
fn image_success_without_parsed_url_is_recoverable_after_restart() {
    success_missing_addresses_recovers("image");
}
#[test]
fn video_success_without_parsed_url_is_recoverable_after_restart() {
    success_missing_addresses_recovers("video");
}

#[test]
fn old_misclassified_expired_images_and_videos_query_the_original_id() {
    for kind in ["image", "video"] {
        let mut fixture = Fixture::new(kind, "result_expired");
        fixture
            .store
            .update_job(
                &fixture.key,
                "result_expired",
                &json!({"error":"原任务没有可获取的结果地址"}),
            )
            .unwrap();
        let channel = RecoveryChannel::new(vec![Ok(response(
            kind,
            "succeeded",
            &["https://offline.test/result-a"],
        ))]);
        fixture.restart();
        tasks::run_generation(&fixture.store, &fixture.key, &config(), ACCOUNT, &channel).unwrap();
        fixture.resume(&channel, true);
        assert_eq!(fixture.job()["status"], "downloaded");
        fixture.assert_media(1, kind);
        fixture.assert_original();
        channel.assert_no_generation();
    }
}

#[test]
fn processing_unknown_failed_and_explicit_expiry_are_distinct() {
    for kind in ["image", "video"] {
        for (remote, expected) in [
            ("processing", "processing"),
            ("pending", "processing"),
            ("unknown", "query_failed"),
            ("future-unrecognized-state", "query_failed"),
            ("failed", "failed"),
            ("expired", "result_expired"),
            ("result_expired", "result_expired"),
        ] {
            let fixture = Fixture::new(kind, "submitted");
            let mut result = response(kind, remote, &["https://offline.test/must-not-download"]);
            result.error = Some("upstream failed: an unrelated upload token expired".into());
            let channel = RecoveryChannel::new(vec![Ok(result.clone())]);
            fixture.resume(&channel, true);
            assert_eq!(fixture.job()["status"], expected, "{kind}:{remote}");
            assert_eq!(fixture.job()["result"]["raw"], result.raw);
            assert!(channel.download_urls.lock().unwrap().is_empty());
            fixture.assert_original();
            channel.assert_no_generation();
        }
    }
}

fn independent_query_and_download_recovery(kind: &str) {
    let mut fixture = Fixture::new(kind, "submitted");
    let stale_url = "https://offline.test/result-a?expired";
    let fresh_url = "https://offline.test/result-a?fresh";
    let channel = RecoveryChannel::new(vec![
        Err(ProviderError::new(
            "QUERY_TIMEOUT",
            "query transport timeout",
        )),
        Ok(response(kind, "succeeded", &[stale_url])),
        Ok(response(kind, "succeeded", &[fresh_url])),
    ]);
    channel
        .fail_download_once
        .lock()
        .unwrap()
        .insert(stale_url.into());
    fixture.resume(&channel, true);
    assert_eq!(fixture.job()["status"], "query_failed");
    assert_eq!(fixture.job()["queryAttempts"], 1);
    assert_eq!(fixture.job()["downloadAttempts"], 0);
    fixture.restart();
    fixture.resume(&channel, true);
    assert_eq!(fixture.job()["status"], "download_failed");
    assert_eq!(fixture.job()["queryAttempts"], 0);
    assert_eq!(fixture.job()["downloadAttempts"], 1);
    assert!(!fixture.job()["result"]["raw"].is_null());
    fixture.assert_original();
    fixture.restart();
    fixture.resume(&channel, true);
    assert_eq!(fixture.job()["status"], "downloaded");
    assert_eq!(fixture.job()["downloadAttempts"], 0);
    assert_eq!(
        *channel.download_urls.lock().unwrap(),
        vec![stale_url, fresh_url]
    );
    assert_eq!(channel.query_ids.lock().unwrap().len(), 3);
    fixture.assert_media(1, kind);
    fixture.assert_original();
    channel.assert_no_generation();
}
#[test]
fn image_query_failure_and_stale_download_url_recover_independently() {
    independent_query_and_download_recovery("image");
}
#[test]
fn video_query_failure_and_stale_download_url_recover_independently() {
    independent_query_and_download_recovery("video");
}

fn assert_recovery_paused(fixture: &Fixture, operation: &str) {
    let job = fixture.job();
    assert_eq!(job["status"], "recovery_paused");
    assert_eq!(job["nextAttemptAt"], 0);
    assert!(s(&job, "error").contains("连续失败5次"));
    assert!(
        fixture
            .store
            .pending_jobs()
            .unwrap()
            .iter()
            .all(|j| j["id"] != fixture.key),
        "a paused task must not be automatically scheduled even with nextAttemptAt=0"
    );
    let raw: String = fixture.store.conn().unwrap().query_row(
        "SELECT data FROM events WHERE job_id=?1 AND type='retry_budget_exhausted' ORDER BY rowid DESC LIMIT 1",
        [&fixture.key], |row| row.get(0),
    ).unwrap();
    let event: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(event["operation"], operation);
    assert_eq!(event["attempts"], 5);
    fixture.assert_original();
}

fn query_budget_pauses_and_manual_recovery_queries_original_id(kind: &str) {
    let mut fixture = Fixture::new(kind, "submitted");
    let mut responses = (0..5)
        .map(|_| {
            Err(ProviderError::new(
                "QUERY_TIMEOUT",
                "original task query timed out",
            ))
        })
        .collect::<Vec<_>>();
    // First manual recovery performs query only; downloading remains a separate action.
    responses.push(Ok(response(kind, "processing", &[])));
    responses.push(Ok(response(
        kind,
        "succeeded",
        &["https://offline.test/query-budget-result?fresh"],
    )));
    let channel = RecoveryChannel::new(responses);
    for attempt in 1..=5 {
        let started = chrono::Utc::now().timestamp();
        fixture.resume(&channel, true);
        let job = fixture.job();
        assert_eq!(job["queryAttempts"], attempt);
        assert_eq!(job["downloadAttempts"], 0);
        assert_eq!(channel.query_ids.lock().unwrap().len(), attempt as usize);
        assert!(channel.download_urls.lock().unwrap().is_empty());
        if attempt < 5 {
            assert_eq!(job["status"], "query_failed");
            let delay = 5_i64 * (1_i64 << (attempt - 1));
            assert!(job["nextAttemptAt"].as_i64().unwrap() >= started + delay);
            assert!(fixture
                .store
                .pending_jobs()
                .unwrap()
                .iter()
                .any(|j| j["id"] == fixture.key));
        } else {
            assert_recovery_paused(&fixture, "query");
        }
        fixture.assert_original();
    }
    fixture.restart();
    assert_recovery_paused(&fixture, "query");
    // Even an erroneous generation routing cannot prepare or submit a paused task.
    tasks::run_generation(&fixture.store, &fixture.key, &config(), ACCOUNT, &channel).unwrap();
    assert_eq!(channel.query_ids.lock().unwrap().len(), 5);
    fixture.resume(&channel, false);
    assert_eq!(fixture.job()["status"], "processing");
    assert_eq!(fixture.job()["queryAttempts"], 0);
    assert_eq!(fixture.job()["downloadAttempts"], 0);
    assert!(channel.download_urls.lock().unwrap().is_empty());
    fixture.assert_original();
    fixture.resume(&channel, true);
    assert_eq!(fixture.job()["status"], "downloaded");
    assert_eq!(channel.query_ids.lock().unwrap().len(), 7);
    assert_eq!(channel.download_urls.lock().unwrap().len(), 1);
    fixture.assert_media(1, kind);
    fixture.assert_original();
    channel.assert_no_generation();
}

#[test]
fn image_fifth_query_failure_pauses_automatic_recovery_but_manual_resume_keeps_original_id() {
    query_budget_pauses_and_manual_recovery_queries_original_id("image");
}

#[test]
fn video_fifth_query_failure_pauses_automatic_recovery_but_manual_resume_keeps_original_id() {
    query_budget_pauses_and_manual_recovery_queries_original_id("video");
}

fn download_budget_is_independent_and_manual_recovery_refreshes_original_result(kind: &str) {
    let mut fixture = Fixture::new(kind, "submitted");
    let urls = (1..=5)
        .map(|n| format!("https://offline.test/download-budget-result?expired-{n}"))
        .collect::<Vec<_>>();
    let mut responses = (0..4)
        .map(|_| {
            Err(ProviderError::new(
                "QUERY_TIMEOUT",
                "query budget has not yet been exhausted",
            ))
        })
        .collect::<Vec<_>>();
    responses.extend(
        urls.iter()
            .map(|url| Ok(response(kind, "succeeded", &[url]))),
    );
    let fresh = "https://offline.test/download-budget-result?fresh";
    responses.push(Ok(response(kind, "succeeded", &[fresh])));
    let channel = RecoveryChannel::new(responses);
    for attempt in 1..=4 {
        fixture.resume(&channel, true);
        assert_eq!(fixture.job()["status"], "query_failed");
        assert_eq!(fixture.job()["queryAttempts"], attempt);
        assert_eq!(fixture.job()["downloadAttempts"], 0);
    }
    // Four query failures must not consume any of the independent download budget.
    for (index, url) in urls.iter().enumerate() {
        channel
            .fail_download_once
            .lock()
            .unwrap()
            .insert(url.clone());
        let started = chrono::Utc::now().timestamp();
        fixture.resume(&channel, true);
        let attempt = index + 1;
        let job = fixture.job();
        assert_eq!(
            job["queryAttempts"], 0,
            "a successful original-ID query resets only its own budget"
        );
        assert_eq!(job["downloadAttempts"], attempt);
        assert_eq!(channel.download_urls.lock().unwrap().len(), attempt);
        fixture.assert_media(0, kind);
        if attempt < 5 {
            assert_eq!(
                job["status"], "download_failed",
                "prior query errors must not prematurely pause downloading"
            );
            let delay = 10_i64 * (1_i64 << (attempt - 1));
            assert!(job["nextAttemptAt"].as_i64().unwrap() >= started + delay);
            assert!(fixture
                .store
                .pending_jobs()
                .unwrap()
                .iter()
                .any(|j| j["id"] == fixture.key));
        } else {
            assert_recovery_paused(&fixture, "download");
        }
        fixture.assert_original();
    }
    fixture.restart();
    assert_recovery_paused(&fixture, "download");
    let before = fixture.job()["result"].clone();
    tasks::run_generation(&fixture.store, &fixture.key, &config(), ACCOUNT, &channel).unwrap();
    assert_eq!(fixture.job()["result"], before);
    assert_eq!(channel.query_ids.lock().unwrap().len(), 9);
    // Explicit recovery queries the same task for a new URL before retrying download.
    fixture.resume(&channel, true);
    assert_eq!(fixture.job()["status"], "downloaded");
    assert_eq!(fixture.job()["queryAttempts"], 0);
    assert_eq!(fixture.job()["downloadAttempts"], 0);
    assert_eq!(channel.query_ids.lock().unwrap().len(), 10);
    assert_eq!(channel.download_urls.lock().unwrap().last().unwrap(), fresh);
    assert_eq!(channel.download_urls.lock().unwrap().len(), 6);
    fixture.assert_media(1, kind);
    fixture.assert_original();
    channel.assert_no_generation();
}

#[test]
fn image_fifth_download_failure_pauses_with_independent_budget_and_query_only_regeneration_guard() {
    download_budget_is_independent_and_manual_recovery_refreshes_original_result("image");
}

#[test]
fn video_fifth_download_failure_pauses_with_independent_budget_and_query_only_regeneration_guard() {
    download_budget_is_independent_and_manual_recovery_refreshes_original_result("video");
}

fn multiple_results_survive_partial_download_and_restart(kind: &str) {
    let mut fixture = Fixture::new(kind, "submitted");
    let urls = [
        "https://offline.test/result-a?old",
        "https://offline.test/result-b?old",
    ];
    let fresh = [
        "https://offline.test/result-a?fresh",
        "https://offline.test/result-b?fresh",
    ];
    let channel = RecoveryChannel::new(vec![
        Ok(response(kind, "succeeded", &urls)),
        Ok(response(kind, "succeeded", &fresh)),
    ]);
    channel
        .fail_download_once
        .lock()
        .unwrap()
        .insert(urls[1].into());
    fixture.resume(&channel, true);
    assert_eq!(fixture.job()["status"], "download_failed");
    fixture.assert_media(1, kind);
    let first_media = fixture.job()["resultMediaIds"][0].clone();
    fixture.restart();
    fixture.resume(&channel, true);
    assert_eq!(fixture.job()["status"], "downloaded");
    fixture.assert_media(2, kind);
    assert_eq!(fixture.job()["resultMediaIds"][0], first_media);
    assert_eq!(fixture.store.values("media").unwrap().len(), 2);
    fixture.assert_original();
    channel.assert_no_generation();
}
#[test]
fn image_multi_result_media_links_survive_partial_download_and_restart() {
    multiple_results_survive_partial_download_and_restart("image");
}
#[test]
fn video_multi_result_media_links_survive_partial_download_and_restart() {
    multiple_results_survive_partial_download_and_restart("video");
}

#[test]
fn invalid_downloaded_image_is_download_failure_and_queries_fresh_address() {
    let mut fixture = Fixture::new("image", "submitted");
    let bad = "https://offline.test/result-a?corrupt";
    let good = "https://offline.test/result-a?fresh";
    let channel = RecoveryChannel::new(vec![
        Ok(response("image", "succeeded", &[bad])),
        Ok(response("image", "succeeded", &[good])),
    ]);
    channel.corrupt_once.lock().unwrap().insert(bad.into());
    fixture.resume(&channel, true);
    assert_eq!(fixture.job()["status"], "download_failed");
    assert!(s(&fixture.job(), "error").contains("尚未可靠导入"));
    fixture.assert_media(0, "image");
    fixture.restart();
    fixture.resume(&channel, true);
    assert_eq!(fixture.job()["status"], "downloaded");
    fixture.assert_media(1, "image");
    fixture.assert_original();
    channel.assert_no_generation();
}

#[test]
fn mismatched_query_identity_never_imports_or_replaces_original_task() {
    for kind in ["image", "video"] {
        let fixture = Fixture::new(kind, "submitted");
        let mut result = response(
            kind,
            "succeeded",
            &["https://offline.test/wrong-task-result"],
        );
        result.task_id = "different-cloud-task".into();
        let channel = RecoveryChannel::new(vec![Ok(result)]);
        fixture.resume(&channel, true);
        assert_eq!(fixture.job()["status"], "query_failed");
        assert!(channel.download_urls.lock().unwrap().is_empty());
        fixture.assert_media(0, kind);
        fixture.assert_original();
        channel.assert_no_generation();
    }
}

#[test]
fn prepared_and_unprepared_recovery_query_the_original_media_kind() {
    for kind in ["image", "video"] {
        for has_prepared in [false, true] {
            let fixture = Fixture::new(kind, "submitted");
            if has_prepared {
                fixture
                    .store
                    .update_job(
                        &fixture.key,
                        "submitted",
                        &json!({"prepared":prepared(kind)}),
                    )
                    .unwrap();
            }
            let channel = RecoveryChannel::new(vec![Ok(response(
                kind,
                "succeeded",
                &["https://offline.test/result-a"],
            ))]);
            fixture.resume(&channel, true);
            assert_eq!(fixture.job()["status"], "downloaded");
            assert_eq!(*channel.query_kinds.lock().unwrap(), vec![kind]);
            fixture.assert_media(1, kind);
            fixture.assert_original();
            channel.assert_no_generation();
        }
    }
}

#[test]
fn mismatched_or_unreadable_preparation_never_queries_wrong_media_kind() {
    for kind in ["image", "video"] {
        let other = if kind == "image" { "video" } else { "image" };
        for saved in [
            serde_json::to_value(prepared(other)).unwrap(),
            json!({"request":{"kind":kind}}),
        ] {
            let mut fixture = Fixture::new(kind, "submitted");
            fixture
                .store
                .update_job(&fixture.key, "submitted", &json!({"prepared":saved}))
                .unwrap();
            fixture.restart();
            let channel = RecoveryChannel::new(vec![]);
            fixture.resume(&channel, true);
            let job = fixture.job();
            assert_eq!(job["status"], "query_failed");
            assert!(s(&job, "error").contains("准备记录"));
            assert_eq!(job["prepared"], saved);
            assert!(channel.query_ids.lock().unwrap().is_empty());
            assert!(channel.query_kinds.lock().unwrap().is_empty());
            assert!(channel.download_urls.lock().unwrap().is_empty());
            fixture.assert_original();
            channel.assert_no_generation();
        }
    }
}

#[test]
fn downloaded_results_keep_identity_when_followup_id_or_preparation_is_invalid() {
    for kind in ["image", "video"] {
        for issue in ["wrong-id", "wrong-kind", "unreadable-preparation"] {
            let fixture = Fixture::new(kind, "submitted");
            let success = response(kind, "succeeded", &["https://offline.test/result-a"]);
            let mut wrong = response(kind, "succeeded", &["https://offline.test/wrong-result"]);
            wrong.task_id = "different-cloud-task".into();
            let channel = RecoveryChannel::new(if issue == "wrong-id" {
                vec![Ok(success), Ok(wrong)]
            } else {
                vec![Ok(success)]
            });
            fixture.resume(&channel, true);
            assert_eq!(fixture.job()["status"], "downloaded");
            let completed = fixture.job();
            if issue != "wrong-id" {
                let saved = if issue == "wrong-kind" {
                    serde_json::to_value(prepared(if kind == "image" { "video" } else { "image" }))
                        .unwrap()
                } else {
                    json!({"request":{"kind":kind}})
                };
                fixture
                    .store
                    .update_job(&fixture.key, "downloaded", &json!({"prepared":saved}))
                    .unwrap();
            }
            fixture.resume(&channel, true);
            let after = fixture.job();
            assert_eq!(after["status"], "downloaded", "{kind}:{issue}");
            assert_eq!(after["resultMediaIds"], completed["resultMediaIds"]);
            assert_eq!(after["result"], completed["result"]);
            assert_eq!(after["queryAttempts"], 0);
            assert_eq!(channel.download_urls.lock().unwrap().len(), 1);
            assert_eq!(
                channel.query_ids.lock().unwrap().len(),
                if issue == "wrong-id" { 2 } else { 1 }
            );
            let errors: i64 = fixture
                .store
                .conn()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM events WHERE job_id=?1 AND type='query_error'",
                    [&fixture.key],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(errors, 1);
            fixture.assert_media(1, kind);
            fixture.assert_original();
            channel.assert_no_generation();
        }
    }
}

fn imported_current(fixture: &Fixture, tone: u8) -> Value {
    let path = fixture.store.root.join(format!("user-{tone}.png"));
    image::RgbImage::from_pixel(2, 2, image::Rgb([tone, 7, 20]))
        .save(&path)
        .unwrap();
    fixture
        .store
        .import_image_as_current(&path, "asset", Some("base"))
        .unwrap()
}

#[test]
fn complete_image_and_regeneration_select_first_output_and_keep_manual_history_choice() {
    let mut fixture = Fixture::new("image", "submitted");
    let old = imported_current(&fixture, 230);
    let urls = [
        "https://offline.test/result-a",
        "https://offline.test/result-b",
    ];
    let channel = RecoveryChannel::new(vec![
        Ok(response("image", "succeeded", &urls)),
        Ok(response("image", "succeeded", &urls)),
    ]);
    fixture.resume(&channel, true);
    let generated = fixture.job()["resultMediaIds"].clone();
    assert_eq!(
        fixture.store.adopted("asset", "base").unwrap(),
        Some(generated[0].as_str().unwrap().into())
    );
    assert_eq!(fixture.store.values("media").unwrap().len(), 3);
    fixture.store.adopt("asset", "base", s(&old, "id")).unwrap();
    fixture.restart();
    fixture.resume(&channel, true);
    assert_eq!(
        fixture.store.adopted("asset", "base").unwrap(),
        Some(s(&old, "id").into())
    );
    assert_eq!(channel.download_urls.lock().unwrap().len(), 2);
    assert_eq!(
        fixture.store.ensure_current_images().unwrap()["selectedCount"],
        0
    );
    let mut snapshot = fixture.snapshot.clone();
    snapshot["requestId"] = json!("explicit-regeneration-request");
    let second = fixture
        .store
        .add_job("image", "asset", "mock", ACCOUNT, &snapshot, "submitted")
        .unwrap();
    fixture.store.update_job(&second,"submitted",&json!({"providerTaskId":"regenerated-cloud-task","receipt":{"taskId":"regenerated-cloud-task","status":"processing","resultUrls":[],"raw":{"fixture":"new-original-receipt"}}})).unwrap();
    let mut result = response("image", "succeeded", &["https://offline.test/result-c"]);
    result.task_id = "regenerated-cloud-task".into();
    result.raw["task_id"] = json!("regenerated-cloud-task");
    let regenerated = RecoveryChannel::for_task("regenerated-cloud-task", vec![Ok(result)]);
    tasks::resume_job(
        &fixture.store,
        &second,
        &config(),
        ACCOUNT,
        &regenerated,
        true,
    )
    .unwrap();
    let newest = fixture.store.job(&second).unwrap()["resultMediaIds"][0].clone();
    assert_eq!(
        fixture.store.adopted("asset", "base").unwrap(),
        Some(newest.as_str().unwrap().into())
    );
    assert_eq!(fixture.store.values("media").unwrap().len(), 4);
    assert!(fixture.store.verify_media(&old).is_ok());
    assert_eq!(fixture.job()["resultMediaIds"], generated);
    fixture.assert_original();
    channel.assert_no_generation();
    regenerated.assert_no_generation();
}

#[test]
fn failed_or_partial_image_download_preserves_current_and_cannot_backfill_partial_history() {
    for has_current in [false, true] {
        let fixture = Fixture::new("image", "submitted");
        let old = if has_current {
            Some(imported_current(&fixture, 210))
        } else {
            None
        };
        let urls = [
            "https://offline.test/result-a",
            "https://offline.test/result-b",
        ];
        let channel = RecoveryChannel::new(vec![Ok(response("image", "succeeded", &urls))]);
        channel
            .fail_download_once
            .lock()
            .unwrap()
            .insert(urls[1].into());
        fixture.resume(&channel, true);
        assert_eq!(fixture.job()["status"], "download_failed");
        assert_eq!(
            fixture.store.adopted("asset", "base").unwrap(),
            old.as_ref().map(|m| s(m, "id").into())
        );
        assert_eq!(
            fixture.store.ensure_current_images().unwrap()["selectedCount"],
            0
        );
        assert_eq!(
            fixture.store.adopted("asset", "base").unwrap(),
            old.as_ref().map(|m| s(m, "id").into())
        );
        let marked: i64 = fixture
            .store
            .conn()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM events WHERE job_id=?1 AND type='image_current_processed'",
                [&fixture.key],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(marked, 0);
        fixture.assert_original();
        channel.assert_no_generation();
    }
}

#[test]
fn old_or_mismatched_frozen_image_identity_is_history_only() {
    for case in [
        "prompt-version-changed",
        "variant-changed",
        "asset-id-mismatch",
        "version-missing",
    ] {
        let mut fixture = Fixture::new("image", "submitted");
        let old = imported_current(&fixture, 190);
        if case == "prompt-version-changed" || case == "variant-changed" {
            let mut asset = fixture.store.get("assets", "asset").unwrap();
            asset["prompt"] = json!("new design version");
            if case == "variant-changed" {
                asset["variantId"] = json!("new-appearance");
            }
            fixture.store.save_asset(asset).unwrap();
        } else {
            if case == "asset-id-mismatch" {
                fixture.snapshot["assetId"] = json!("different-asset");
            } else {
                fixture
                    .snapshot
                    .as_object_mut()
                    .unwrap()
                    .remove("assetVersion");
            }
            fixture
                .store
                .conn()
                .unwrap()
                .execute(
                    "UPDATE jobs SET snapshot=?1 WHERE id=?2",
                    rusqlite::params![fixture.snapshot.to_string(), fixture.key],
                )
                .unwrap();
        }
        let channel = RecoveryChannel::new(vec![Ok(response(
            "image",
            "succeeded",
            &["https://offline.test/result-a"],
        ))]);
        fixture.resume(&channel, true);
        assert_eq!(fixture.job()["status"], "downloaded");
        assert_eq!(
            fixture.store.adopted("asset", "base").unwrap(),
            Some(s(&old, "id").into())
        );
        assert_eq!(
            fixture.store.adopted("asset", "new-appearance").unwrap(),
            None
        );
        let raw: String = fixture
            .store
            .conn()
            .unwrap()
            .query_row(
                "SELECT data FROM events WHERE job_id=?1 AND type='image_current_processed'",
                [&fixture.key],
                |r| r.get(0),
            )
            .unwrap();
        let event: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(event["applied"], false, "{case}");
        fixture.assert_media(1, "image");
        fixture.assert_original();
        channel.assert_no_generation();
    }
}

#[test]
fn switching_generated_current_image_invalidates_only_affected_unsubmitted_references() {
    let fixture = Fixture::new("image", "submitted");
    let old = imported_current(&fixture, 170);
    let reference = json!({"assetId":"asset","variantId":"base","mediaId":old["id"]});
    let affected = fixture
        .store
        .add_job(
            "video",
            "affected-unit",
            "mock",
            ACCOUNT,
            &json!({"references":[reference]}),
            "ready",
        )
        .unwrap();
    let child = fixture
        .store
        .add_job(
            "image",
            "dependent-child",
            "mock",
            ACCOUNT,
            &json!({"references":[reference]}),
            "queued",
        )
        .unwrap();
    let different = fixture
        .store
        .add_job(
            "video",
            "different-unit",
            "mock",
            ACCOUNT,
            &json!({"references":[{"assetId":"other","variantId":"base","mediaId":old["id"]}]}),
            "ready",
        )
        .unwrap();
    let variant = fixture
        .store
        .add_job(
            "video",
            "different-variant",
            "mock",
            ACCOUNT,
            &json!({"references":[{"assetId":"asset","variantId":"other","mediaId":old["id"]}]}),
            "ready",
        )
        .unwrap();
    let snapshot = json!({"references":[reference],"unitVersion":1});
    let submitted = fixture
        .store
        .add_job(
            "video",
            "submitted-unit",
            "mock",
            ACCOUNT,
            &snapshot,
            "submitted",
        )
        .unwrap();
    fixture
        .store
        .update_job(
            &submitted,
            "submitted",
            &json!({"providerTaskId":"frozen-video-id","receipt":{"taskId":"frozen-video-id"}}),
        )
        .unwrap();
    let before = fixture.store.job(&submitted).unwrap();
    let channel = RecoveryChannel::new(vec![Ok(response(
        "image",
        "succeeded",
        &["https://offline.test/result-a"],
    ))]);
    fixture.resume(&channel, true);
    assert_eq!(fixture.store.job(&affected).unwrap()["status"], "stale");
    assert_eq!(fixture.store.job(&child).unwrap()["status"], "stale");
    assert_eq!(fixture.store.job(&different).unwrap()["status"], "ready");
    assert_eq!(fixture.store.job(&variant).unwrap()["status"], "ready");
    assert_eq!(fixture.store.job(&submitted).unwrap(), before);
    fixture.assert_original();
    channel.assert_no_generation();
}

#[test]
fn downloaded_and_current_selection_rollback_together_and_recover_once() {
    let fixture = Fixture::new("image", "submitted");
    let old = imported_current(&fixture, 150);
    fixture.store.conn().unwrap().execute_batch("CREATE TRIGGER simulate_completion_failure BEFORE UPDATE ON jobs WHEN NEW.state='downloaded' BEGIN SELECT RAISE(ABORT,'offline transaction interruption'); END;").unwrap();
    let channel = RecoveryChannel::new(vec![
        Ok(response(
            "image",
            "succeeded",
            &["https://offline.test/result-a"],
        )),
        Ok(response(
            "image",
            "succeeded",
            &["https://offline.test/result-a"],
        )),
    ]);
    assert!(tasks::resume_job(
        &fixture.store,
        &fixture.key,
        &config(),
        ACCOUNT,
        &channel,
        true
    )
    .is_err());
    assert_eq!(fixture.job()["status"], "downloading");
    assert_eq!(
        fixture.store.adopted("asset", "base").unwrap(),
        Some(s(&old, "id").into())
    );
    let marks: i64 = fixture
        .store
        .conn()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM events WHERE job_id=?1 AND type='image_current_processed'",
            [&fixture.key],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(marks, 0);
    fixture
        .store
        .conn()
        .unwrap()
        .execute_batch("DROP TRIGGER simulate_completion_failure;")
        .unwrap();
    fixture.store.recover_interrupted().unwrap();
    fixture.resume(&channel, true);
    assert_eq!(fixture.job()["status"], "downloaded");
    assert_eq!(
        fixture.store.adopted("asset", "base").unwrap(),
        Some(fixture.job()["resultMediaIds"][0].as_str().unwrap().into())
    );
    fixture.assert_original();
    channel.assert_no_generation();
}

#[test]
fn missing_current_backfill_uses_complete_first_result_and_preserves_existing_choice_and_unknown() {
    let fixture = Fixture::new("image", "downloaded");
    let a = fixture.store.root.join("historical-first.png");
    let b = fixture.store.root.join("historical-second.png");
    image::RgbImage::from_pixel(2, 2, image::Rgb([31, 20, 10]))
        .save(&a)
        .unwrap();
    image::RgbImage::from_pixel(2, 2, image::Rgb([32, 20, 10]))
        .save(&b)
        .unwrap();
    let first = fixture
        .store
        .import_media(&a, "image", Some("asset"), Some("base"))
        .unwrap();
    let second = fixture
        .store
        .import_media(&b, "image", Some("asset"), Some("base"))
        .unwrap();
    fixture
        .store
        .attach_result(&fixture.key, s(&first, "id"))
        .unwrap();
    fixture
        .store
        .attach_result(&fixture.key, s(&second, "id"))
        .unwrap();
    fixture.store.update_job(&fixture.key,"downloaded",&json!({"result":{"taskId":TASK,"resultUrls":["offline-a","offline-b"],"mediaIds":[first["id"],second["id"]]}})).unwrap();
    let unknown=fixture.store.add_job("image","asset","mock",ACCOUNT,&json!({"assetId":"asset","assetVersion":1,"variantId":"base","requestId":"uncertain-original"}),"submission_unknown").unwrap();
    fixture
        .store
        .update_job(
            &unknown,
            "submission_unknown",
            &json!({"error":"original uncertain outcome","prepared":{"evidence":"must keep"}}),
        )
        .unwrap();
    let original_unknown = fixture.store.job(&unknown).unwrap();
    let report = fixture.store.ensure_current_images().unwrap();
    assert_eq!(report["selectedCount"], 1);
    assert_eq!(
        fixture.store.adopted("asset", "base").unwrap(),
        Some(s(&first, "id").into())
    );
    fixture
        .store
        .adopt("asset", "base", s(&second, "id"))
        .unwrap();
    assert_eq!(
        fixture.store.ensure_current_images().unwrap()["selectedCount"],
        0
    );
    assert_eq!(
        fixture.store.adopted("asset", "base").unwrap(),
        Some(s(&second, "id").into())
    );
    assert_eq!(fixture.store.job(&unknown).unwrap(), original_unknown);
    fixture.assert_original();
}

#[test]
fn missing_current_backfill_rejects_wrong_or_missing_generated_version() {
    for issue in ["version-changed", "version-missing"] {
        let mut fixture = Fixture::new("image", "downloaded");
        let path = fixture.store.root.join("historical.png");
        image::RgbImage::from_pixel(2, 2, image::Rgb([44, 20, 10]))
            .save(&path)
            .unwrap();
        let media = fixture
            .store
            .import_media(&path, "image", Some("asset"), Some("base"))
            .unwrap();
        fixture
            .store
            .attach_result(&fixture.key, s(&media, "id"))
            .unwrap();
        if issue == "version-changed" {
            let mut asset = fixture.store.get("assets", "asset").unwrap();
            asset["prompt"] = json!("updated");
            fixture.store.save_asset(asset).unwrap();
        } else {
            fixture
                .snapshot
                .as_object_mut()
                .unwrap()
                .remove("assetVersion");
            fixture
                .store
                .conn()
                .unwrap()
                .execute(
                    "UPDATE jobs SET snapshot=?1 WHERE id=?2",
                    rusqlite::params![fixture.snapshot.to_string(), fixture.key],
                )
                .unwrap();
        }
        assert_eq!(
            fixture.store.ensure_current_images().unwrap()["selectedCount"],
            0
        );
        assert_eq!(fixture.store.adopted("asset", "base").unwrap(), None);
        assert!(fixture.store.verify_media(&media).is_ok());
        fixture.assert_original();
    }
}

#[test]
fn image_user_import_and_ordered_batch_select_last_success_without_running_channels() {
    let tmp = TempDir::new().unwrap();
    let channel = Arc::new(RecoveryChannel::new(vec![]));
    let engine = Engine::with_channels(tmp.path().join("home"), channel.clone()).unwrap();
    let project = engine
        .dispatch(json!({"action":"projects.create","title":"offline imports"}))
        .unwrap();
    let pid = s(&project, "id");
    engine.dispatch(json!({"action":"assets.save","projectId":pid,"asset":{"id":"asset","variantId":"base","name":"fixture","prompt":"design"}})).unwrap();
    let paths: [std::path::PathBuf; 3] = [
        tmp.path().join("first.png"),
        tmp.path().join("absent.png"),
        tmp.path().join("last.png"),
    ];
    for (path, tone) in [(&paths[0], 51), (&paths[2], 52)] {
        image::RgbImage::from_pixel(2, 2, image::Rgb([tone, 20, 10]))
            .save(path)
            .unwrap();
    }
    let imported=engine.dispatch(json!({"action":"media.import","projectId":pid,"kind":"image","assetId":"asset","variantId":"base","paths":paths})).unwrap();
    assert_eq!(imported["mediaImportReport"]["importedCount"], 2);
    assert_eq!(
        imported["mediaImportReport"]["failures"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        imported["assets"][0]["adoptedMediaId"],
        imported["mediaImportReport"]["mediaIds"][1]
    );
    assert_eq!(
        imported["assets"][0]["candidates"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let first = imported["mediaImportReport"]["mediaIds"][0].clone();
    engine.dispatch(json!({"action":"media.adopt","projectId":pid,"assetId":"asset","variantId":"base","mediaId":first})).unwrap();
    let init = engine
        .dispatch(json!({"action":"images.ensure_current","projectId":pid}))
        .unwrap();
    assert_eq!(init["currentImageInitialization"]["selectedCount"], 0);
    assert_eq!(init["assets"][0]["adoptedMediaId"], first);
    let reopened = Engine::with_channels(tmp.path().join("home"), channel.clone()).unwrap();
    let workspace = reopened
        .dispatch(json!({"action":"workspace.get","projectId":pid}))
        .unwrap();
    assert_eq!(workspace["assets"][0]["adoptedMediaId"], first);
    channel.assert_no_generation();
    assert!(channel.query_ids.lock().unwrap().is_empty());
}

#[test]
fn video_download_does_not_automatically_adopt_a_video_or_change_current_image() {
    let fixture = Fixture::new("video", "submitted");
    let current = imported_current(&fixture, 130);
    let channel = RecoveryChannel::new(vec![Ok(response(
        "video",
        "succeeded",
        &["https://offline.test/result-video"],
    ))]);
    fixture.resume(&channel, true);
    assert_eq!(fixture.job()["status"], "downloaded");
    assert_eq!(
        fixture.store.adopted("asset", "base").unwrap(),
        Some(s(&current, "id").into())
    );
    let videos: i64 = fixture
        .store
        .conn()
        .unwrap()
        .query_row("SELECT count(*) FROM video_adoptions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(videos, 0);
    channel.assert_no_generation();
}

#[test]
fn partial_generated_image_has_no_backfill_window_between_file_import_and_job_attachment() {
    let fixture = Fixture::new("image", "downloading");
    let path = fixture.store.root.join("pending-first-output.png");
    image::RgbImage::from_pixel(2, 2, image::Rgb([63, 20, 10]))
        .save(&path)
        .unwrap();
    let media = fixture
        .store
        .import_media(&path, "image", None, None)
        .unwrap();
    // The file exists, but generated history is not published before job ownership.
    assert_eq!(
        fixture.store.ensure_current_images().unwrap()["selectedCount"],
        0
    );
    fixture
        .store
        .attach_download_result(&fixture.key, s(&media, "id"))
        .unwrap();
    // Now the candidate and its incomplete job become visible in one commit.
    assert_eq!(
        fixture.store.ensure_current_images().unwrap()["selectedCount"],
        0
    );
    assert_eq!(fixture.store.adopted("asset", "base").unwrap(), None);
    fixture.store.complete_download(&fixture.key,&json!({"taskId":TASK,"resultUrls":["https://offline.test/result-a"],"mediaIds":[media["id"]]}),&[s(&media,"id").to_owned()]).unwrap();
    assert_eq!(
        fixture.store.adopted("asset", "base").unwrap(),
        Some(s(&media, "id").into())
    );
    fixture.assert_original();
}
