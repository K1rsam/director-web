//! Public-entry and concurrency acceptance using offline fixtures only.
use director_core::{
    binding, pipeline,
    providers::*,
    store::{hash_file, s, Store},
    tasks::{self, Channels},
    Engine,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier,
    },
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

struct OfflineChannels {
    prepares: AtomicUsize,
    submits: AtomicUsize,
    queries: AtomicUsize,
    downloads: AtomicUsize,
    delay: Duration,
}
impl OfflineChannels {
    fn new(delay: Duration) -> Self {
        Self {
            prepares: AtomicUsize::new(0),
            submits: AtomicUsize::new(0),
            queries: AtomicUsize::new(0),
            downloads: AtomicUsize::new(0),
            delay,
        }
    }
    fn calls(&self) -> usize {
        self.prepares.load(Ordering::SeqCst)
            + self.submits.load(Ordering::SeqCst)
            + self.queries.load(Ordering::SeqCst)
            + self.downloads.load(Ordering::SeqCst)
    }
}
impl Channels for OfflineChannels {
    fn capabilities(&self, _: &ProviderConfig) -> ProviderResult<Capabilities> {
        Ok(serde_json::from_value(json!({"provider":"offline","version":"offline/v1","source":"test-fixture","checkedAt":"2026-10-04T00:00:00Z","models":[],"canCancel":false,"canReconcileUnknown":false,"raw":{}})).unwrap())
    }
    fn prepare(
        &self,
        _: &ProviderConfig,
        request: &GenerationRequest,
    ) -> ProviderResult<PreparedRequest> {
        self.prepares.fetch_add(1, Ordering::SeqCst);
        thread::sleep(self.delay);
        Ok(PreparedRequest {
            provider: "offline".into(),
            request: request.clone(),
            capability_version: "offline/v1".into(),
            upload_receipts: vec![],
            wire: json!({"offline":true,"orderedReferenceIds":request.references.iter().map(|r|&r.media_id).collect::<Vec<_>>()}),
            estimated_cost: None,
            prepared_at: "2026-10-04T00:00:00Z".into(),
        })
    }
    fn submit(
        &self,
        _: &ProviderConfig,
        prepared: &PreparedRequest,
    ) -> ProviderResult<SubmitReceipt> {
        assert!(
            !prepared.request.prompt.is_empty(),
            "A complete prepared request must precede submission"
        );
        assert_eq!(prepared.capability_version, "offline/v1");
        self.submits.fetch_add(1, Ordering::SeqCst);
        Ok(SubmitReceipt {
            task_id: "offline-original-task".into(),
            status: "processing".into(),
            result_urls: vec![],
            raw: json!({"fixture":true}),
        })
    }
    fn query(&self, _: &ProviderConfig, id: &str) -> ProviderResult<QueryResult> {
        assert_eq!(
            id, "offline-original-task",
            "Resume queries must use the original cloud task identity"
        );
        self.queries.fetch_add(1, Ordering::SeqCst);
        Ok(QueryResult {
            task_id: id.into(),
            status: "succeeded".into(),
            result_urls: vec!["https://offline.invalid/fixture.mp4".into()],
            error: None,
            actual_cost: None,
            raw: json!({"fixture":true}),
        })
    }
    fn download(
        &self,
        _: &ProviderConfig,
        _: &str,
        path: &Path,
    ) -> ProviderResult<DownloadReceipt> {
        self.downloads.fetch_add(1, Ordering::SeqCst);
        // Image production needs a valid container; video fixture bytes only test
        // persistence and never claim playback or visual quality.
        let is_image = path.extension().is_some_and(|ext| ext == "png");
        if is_image {
            image::RgbImage::from_pixel(4, 3, image::Rgb([42, 73, 104]))
                .save(path)
                .unwrap();
        } else {
            fs::write(path, b"offline-video-result-fixture").unwrap();
        }
        let (hash, bytes) = hash_file(path).unwrap();
        Ok(DownloadReceipt {
            path: path.to_path_buf(),
            sha256: hash,
            bytes,
            mime: Some(if is_image { "image/png" } else { "video/mp4" }.into()),
        })
    }
    fn reconcile(&self, _: &ProviderConfig, _: &str) -> ProviderResult<QueryResult> {
        Err(ProviderError::new(
            "OFFLINE_UNSUPPORTED",
            "No unknown submission is created by this fixture",
        ))
    }
}
struct Fixture {
    temporary: TempDir,
    engine: Arc<Engine>,
    store: Store,
    project_id: String,
    fake: Arc<OfflineChannels>,
}
impl Fixture {
    fn new(delay: Duration, episodes: usize) -> Self {
        let temporary = TempDir::new().unwrap();
        let fake = Arc::new(OfflineChannels::new(delay));
        let engine = Engine::with_channels(temporary.path().join("home"), fake.clone()).unwrap();
        let project = engine
            .dispatch(json!({"action":"projects.create","title":"离线验收"}))
            .unwrap();
        let project_id = s(&project, "id").to_owned();
        let store = engine.store(&project_id).unwrap();
        // A missing text endpoint fails before credential access if a regression accidentally invokes text production.
        store.save_settings(&json!({"trialApproved":true,"textProvider":"api","textEndpoint":"","ffprobePath":temporary.path().join("intentionally-unavailable-ffprobe.exe")})).unwrap();
        let text = (1..=episodes)
            .map(|n| format!("第{n}集\n场景：门口\n甲：第{n}集走吧。\n"))
            .collect::<String>();
        let source = pipeline::prepare_source(&text).unwrap();
        pipeline::validate_source(&source).unwrap();
        store
            .save_source(serde_json::to_value(source).unwrap())
            .unwrap();
        Self {
            temporary,
            engine,
            store,
            project_id,
            fake,
        }
    }
    fn source(&self) -> Value {
        self.store.source().unwrap()
    }
    fn asset(&self, id: &str, parents: &[&str]) {
        let source = self.source();
        let row = source["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| s(r, "kind") == "body")
            .unwrap();
        self.store.save_asset(json!({"id":id,"baseAssetId":id,"variantId":"base","name":id,"kind":"CH","prompt":format!("{id}完整已保存图片设计"),"sourceRefs":[row["id"]],"designStatus":"candidate","design":{"referenceAssetIds":parents},"applicability":{"episodes":[],"scenes":[]}})).unwrap();
    }
    fn video_job(&self) -> String {
        self.asset("reference", &[]);
        let file = self.temporary.path().join("immutable-reference.png");
        image::RgbImage::from_pixel(4, 3, image::Rgb([42, 73, 104]))
            .save(&file)
            .unwrap();
        let media = self
            .store
            .import_media(&file, "image", Some("reference"), Some("base"))
            .unwrap();
        self.store
            .adopt("reference", "base", s(&media, "id"))
            .unwrap();
        let source = self.source();
        let episode = &source["episodes"][0];
        let scene = &source["scenes"][0];
        let row = source["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| s(r, "kind") == "body")
            .unwrap();
        let unit=self.store.save_unit(json!({"id":"video-unit","episodeId":episode["id"],"sceneId":scene["id"],"sourceRefs":[row["id"]],"duration":5,"prompt":"{{asset:reference:base}} 甲在门口抬头，说第1集走吧。","assetRefs":[{"assetId":"reference","variantId":"base","order":0}]})).unwrap();
        let mut snapshot = binding::bind(&self.store, &unit, "offline", "offline-video").unwrap();
        assert!(snapshot["problems"].as_array().unwrap().is_empty());
        snapshot["autoSubmit"] = json!(true);
        self.store
            .add_job(
                "video",
                "video-unit",
                "offline",
                "offline-account",
                &snapshot,
                "queued",
            )
            .unwrap()
    }
}
fn config() -> ProviderConfig {
    serde_json::from_value(json!({"kind":"offline"})).unwrap()
}
fn await_workflow(store: &Store) -> Value {
    let started = Instant::now();
    loop {
        if let Some(job) = store.jobs().unwrap().into_iter().find(|j| {
            s(j, "kind") == "workflow" && ["completed", "failed"].contains(&s(j, "status"))
        }) {
            assert_eq!(job["status"], "completed", "{job}");
            return job;
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "Public images.produce did not settle"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn public_images_produce_expands_dependencies_and_uses_completed_parent_images() {
    let fixture = Fixture::new(Duration::ZERO, 1);
    for id in ["parent-one", "parent-two", "unselected-independent"] {
        fixture.asset(id, &[]);
    }
    fixture.asset("child", &["parent-one", "parent-two"]);
    fixture.engine.dispatch(json!({"action":"images.produce","projectId":fixture.project_id,"provider":"offline","model":"offline-image","assetIds":["child"]})).unwrap();
    let workflow = await_workflow(&fixture.store);
    assert_eq!(workflow["result"]["status"], "queuedForGeneration");
    let jobs = fixture.store.jobs().unwrap();
    let images: Vec<&Value> = jobs.iter().filter(|j| s(j, "kind") == "image").collect();
    assert_eq!(
        images
            .iter()
            .map(|j| s(j, "entityId"))
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["parent-one", "parent-two", "child"])
    );
    for parent in ["parent-one", "parent-two"] {
        assert_eq!(
            images.iter().find(|j| s(j, "entityId") == parent).unwrap()["status"],
            "queued"
        );
    }
    let child = images.iter().find(|j| s(j, "entityId") == "child").unwrap();
    assert_eq!(child["status"], "waiting_dependency");
    assert_eq!(child["snapshot"]["references"], json!([]));
    for id in ["parent-one", "parent-two", "child"] {
        assert!(fixture.store.adopted(id, "base").unwrap().is_none());
    }
    assert!(
        !jobs.iter().any(|j| s(j, "kind") == "text"),
        "Pre-designed closure must not invoke TextExecutor"
    );
    assert_eq!(
        fixture.fake.calls(),
        0,
        "Queue acceptance must not tick or call a generation channel"
    );
    let started = Instant::now();
    loop {
        fixture.engine.tick().unwrap();
        let jobs = fixture.store.jobs().unwrap();
        if jobs
            .iter()
            .filter(|job| s(job, "kind") == "image" && s(job, "status") == "downloaded")
            .count()
            == 3
        {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "Automatically selected parent images must release only their child dependency"
        );
        thread::sleep(Duration::from_millis(10));
    }
    let child = fixture
        .store
        .jobs()
        .unwrap()
        .into_iter()
        .find(|job| s(job, "kind") == "image" && s(job, "entityId") == "child")
        .unwrap();
    assert_eq!(child["snapshot"]["references"].as_array().unwrap().len(), 2);
    for id in ["parent-one", "parent-two", "child"] {
        let job = fixture
            .store
            .jobs()
            .unwrap()
            .into_iter()
            .find(|job| s(job, "kind") == "image" && s(job, "entityId") == id)
            .unwrap();
        assert_eq!(
            fixture.store.adopted(id, "base").unwrap().as_deref(),
            job["resultMediaIds"][0].as_str()
        );
    }
    assert!(!fixture
        .store
        .jobs()
        .unwrap()
        .iter()
        .any(|job| s(job, "entityId") == "unselected-independent"));
}

#[test]
fn public_images_produce_keeps_a_good_dependency_branch_when_another_is_invalid() {
    let fixture = Fixture::new(Duration::ZERO, 1);
    for id in ["parent-one", "parent-two"] {
        fixture.asset(id, &[]);
    }
    fixture.asset("good-child", &["parent-one", "parent-two"]);
    fixture.asset("bad-child", &["nonexistent-parent"]);
    fixture.engine.dispatch(json!({"action":"images.produce","projectId":fixture.project_id,"provider":"offline","model":"offline-image","assetIds":["bad-child","good-child"]})).unwrap();
    let workflow = await_workflow(&fixture.store);
    assert!(workflow["result"]["blocked"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["assetId"] == "bad-child"));
    let jobs = fixture.store.jobs().unwrap();
    let images: Vec<&Value> = jobs.iter().filter(|j| s(j, "kind") == "image").collect();
    assert_eq!(images.len(), 3);
    assert!(!images.iter().any(|j| s(j, "entityId") == "bad-child"));
    assert_eq!(
        images
            .iter()
            .find(|j| s(j, "entityId") == "good-child")
            .unwrap()["status"],
        "waiting_dependency"
    );
    assert!(images
        .iter()
        .filter(|j| s(j, "entityId").starts_with("parent-"))
        .all(|j| j["status"] == "queued"));
    assert_eq!(fixture.fake.calls(), 0);
    assert!(!jobs.iter().any(|j| s(j, "kind") == "text"));
    assert!(fixture
        .store
        .adopted("good-child", "base")
        .unwrap()
        .is_none());
}

#[test]
fn two_threads_claim_the_same_video_prepare_and_submit_only_once() {
    let fixture = Fixture::new(Duration::from_millis(40), 1);
    let job = fixture.video_job();
    let barrier = Arc::new(Barrier::new(3));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let store = fixture.store.clone();
            let fake = fixture.fake.clone();
            let barrier = barrier.clone();
            let job = job.clone();
            thread::spawn(move || {
                barrier.wait();
                tasks::run_generation(&store, &job, &config(), "offline-account", fake.as_ref())
            })
        })
        .collect();
    barrier.wait();
    for worker in workers {
        worker.join().unwrap().unwrap();
    }
    assert_eq!(fixture.fake.prepares.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.fake.submits.load(Ordering::SeqCst), 1);
    let persisted = fixture.store.job(&job).unwrap();
    assert_eq!(persisted["status"], "submitted");
    assert_eq!(persisted["providerTaskId"], "offline-original-task");
    assert!(!persisted["prepared"].is_null());
    let prepared: PreparedRequest = serde_json::from_value(persisted["prepared"].clone()).unwrap();
    assert_eq!(prepared.request.references.len(), 1);
    assert_eq!(
        prepared.request.references[0].sha256,
        persisted["snapshot"]["references"][0]["sha256"]
            .as_str()
            .unwrap()
    );
}

#[test]
fn querying_a_downloaded_video_keeps_media_identity_adoption_and_preview_paths() {
    let fixture = Fixture::new(Duration::ZERO, 1);
    let job = fixture.video_job();
    tasks::run_generation(
        &fixture.store,
        &job,
        &config(),
        "offline-account",
        fixture.fake.as_ref(),
    )
    .unwrap();
    tasks::resume_job(
        &fixture.store,
        &job,
        &config(),
        "offline-account",
        fixture.fake.as_ref(),
        true,
    )
    .unwrap();
    let downloaded = fixture.store.job(&job).unwrap();
    assert_eq!(downloaded["status"], "downloaded");
    let media_id = downloaded["resultMediaIds"][0].as_str().unwrap().to_owned();
    let adopt = json!({"action":"videos.adopt","projectId":fixture.project_id,"unitId":"video-unit","mediaId":media_id});
    assert!(
        fixture.engine.dispatch(adopt.clone()).is_err(),
        "Unverified fixture bytes must not pass the real adoption gate"
    );
    // This test then mocks the trusted metadata boundary solely to exercise adoption/preview identity persistence.
    // It does not claim these fixture bytes are a playable video or have passed visual review.
    let mut trusted = fixture.store.get("media", &media_id).unwrap();
    trusted["metadataVerified"] = json!(true);
    trusted["metadataSource"] = json!("offline-mock-trust-domain");
    trusted["durationSeconds"] = json!(5);
    trusted["width"] = json!(320);
    trusted["height"] = json!(180);
    trusted["streams"] = json!([{"kind":"video","attachedPicture":false,"width":320,"height":180,"durationSeconds":5}]);
    trusted.as_object_mut().unwrap().remove("metadataError");
    fixture
        .store
        .conn()
        .unwrap()
        .execute(
            "UPDATE media SET data=?1 WHERE id=?2",
            rusqlite::params![trusted.to_string(), media_id],
        )
        .unwrap();
    fixture.engine.dispatch(adopt).unwrap();
    let before = fixture
        .engine
        .dispatch(json!({"action":"workspace.get","projectId":fixture.project_id}))
        .unwrap();
    tasks::resume_job(
        &fixture.store,
        &job,
        &config(),
        "offline-account",
        fixture.fake.as_ref(),
        false,
    )
    .unwrap();
    let after = fixture
        .engine
        .dispatch(json!({"action":"workspace.get","projectId":fixture.project_id}))
        .unwrap();
    let queried = fixture.store.job(&job).unwrap();
    assert_eq!(queried["status"], "downloaded");
    assert_eq!(queried["resultMediaIds"], downloaded["resultMediaIds"]);
    assert_eq!(queried["result"]["mediaIds"], downloaded["resultMediaIds"]);
    assert_eq!(after["units"][0]["adoptedMediaId"], media_id);
    assert_eq!(
        after["units"][0]["resultMediaIds"],
        before["units"][0]["resultMediaIds"]
    );
    let media = after["media"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == media_id)
        .unwrap();
    let original = before["media"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == media_id)
        .unwrap();
    assert_eq!(media["path"], original["path"]);
    assert!(Path::new(s(media, "path")).is_file());
    assert_eq!(
        hash_file(Path::new(s(media, "path"))).unwrap().0,
        s(media, "sha256")
    );
    assert_eq!(fixture.fake.submits.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.fake.downloads.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.fake.queries.load(Ordering::SeqCst), 2);

    // The same content hash may be returned for a later unit version. It must not silently
    // promote the earlier human adoption to that version.
    let adopted_version = after["units"][0]["adoptedVideoVersion"].clone();
    let mut revision = fixture.store.get("units", "video-unit").unwrap();
    revision["prompt"] = json!("{{asset:reference:base}} 甲在门口停下，抬头说第1集走吧。");
    let revision = fixture.store.save_unit(revision).unwrap();
    assert_ne!(revision["version"], adopted_version);
    let new_snapshot =
        binding::bind(&fixture.store, &revision, "offline", "offline-video").unwrap();
    let later_job = fixture
        .store
        .add_job(
            "video",
            "video-unit",
            "offline",
            "offline-account",
            &new_snapshot,
            "downloaded",
        )
        .unwrap();
    fixture
        .store
        .conn()
        .unwrap()
        .execute(
            "INSERT INTO job_media(job_id,media_id) VALUES(?1,?2)",
            rusqlite::params![later_job, media_id],
        )
        .unwrap();
    let reused = fixture
        .engine
        .dispatch(json!({"action":"workspace.get","projectId":fixture.project_id}))
        .unwrap();
    assert_eq!(reused["units"][0]["adoptedMediaId"], media_id);
    assert_eq!(reused["units"][0]["adoptedVideoVersion"], adopted_version);
}

#[test]
#[ignore = "Local 80-episode metadata benchmark; report the 1s target, do not impose this machine-specific threshold on CI"]
fn local_workspace_metadata_benchmark_eighty_locked_episodes() {
    let fixture = Fixture::new(Duration::ZERO, 80);
    let source: pipeline::LockedSource = serde_json::from_value(fixture.source()).unwrap();
    pipeline::validate_source(&source).unwrap();
    assert_eq!(source.episodes.len(), 80);
    let file = fixture
        .temporary
        .path()
        .join("shared-immutable-reference.png");
    image::RgbImage::from_pixel(160, 90, image::Rgb([13, 81, 121]))
        .save(&file)
        .unwrap();
    let media = fixture
        .store
        .import_media(&file, "image", None, None)
        .unwrap();
    let rules = serde_json::to_value(pipeline::rule_snapshots()).unwrap();
    let rule_bytes = serde_json::to_vec(&rules).unwrap().len();
    assert!(rule_bytes > 1024);
    let raw = "large-history-evidence-line\n".repeat(262144 / 28 + 1);
    let raw_bytes = raw.len();
    for (index, episode) in source.episodes.iter().enumerate() {
        let asset = format!("asset-{index}");
        let unit = format!("unit-{index}");
        let row = source
            .rows
            .iter()
            .find(|r| r.episode_id.as_ref() == Some(&episode.id) && r.kind == "body")
            .unwrap();
        fixture.store.save_asset(json!({"id":asset,"variantId":"base","name":format!("第{}集测试形象",index+1),"kind":"CH","prompt":"完整保存的形象设计提示词","applicability":{"episodes":[episode.id]}})).unwrap();
        fixture
            .store
            .link_media(s(&media, "id"), &asset, "base")
            .unwrap();
        fixture
            .store
            .adopt(&asset, "base", s(&media, "id"))
            .unwrap();
        fixture.store.save_unit(json!({"id":unit,"episodeId":episode.id,"sceneId":episode.scene_ids[0],"sourceRefs":[row.id],"duration":5,"prompt":format!("第{}集门口人物动作和完整台词的独立分镜提示词",index+1),"assetRefs":[{"assetId":asset,"variantId":"base","order":0}],"shots":[{"picture":"门口人物看向门内","duration":5,"sourceRefs":[row.id]}],"ruleSnapshots":rules})).unwrap();
        let job=fixture.store.add_job("video",&unit,"offline","offline-account",&json!({"unitId":unit,"model":"offline-video","episodeId":episode.id,"ruleSnapshot":rules,"references":[{"mediaId":media["id"],"sha256":media["sha256"],"path":media["path"]}],"problems":[]}),"completed").unwrap();
        fixture.store.update_job(&job,"completed",&json!({"receipt":{"historical":true,"raw":raw},"result":{"raw":raw,"ruleSnapshots":rules,"historical":true}})).unwrap();
    }
    assert_eq!(fixture.store.values("assets").unwrap().len(), 80);
    assert_eq!(fixture.store.values("units").unwrap().len(), 80);
    assert_eq!(fixture.store.jobs().unwrap().len(), 80);
    assert_eq!(fixture.store.values("media").unwrap().len(), 1);
    fn measure(fixture: &Fixture, episode: Option<&str>) -> Value {
        let mut samples = Vec::new();
        for _ in 0..5 {
            let started = Instant::now();
            let request = if let Some(episode) = episode {
                json!({"action":"workspace.get","projectId":fixture.project_id,"episodeId":episode})
            } else {
                json!({"action":"workspace.get","projectId":fixture.project_id})
            };
            let payload = fixture.engine.dispatch(request).unwrap();
            let dispatch_ms = started.elapsed().as_secs_f64() * 1000.0;
            let bytes = serde_json::to_vec(&payload).unwrap().len();
            let total_ms = started.elapsed().as_secs_f64() * 1000.0;
            let units = payload["units"].as_array().unwrap().len();
            assert_eq!(units, if episode.is_some() { 1 } else { 80 });
            samples.push(json!({"dispatchMs":dispatch_ms,"serializeMs":total_ms-dispatch_ms,"totalMs":total_ms,"payloadBytes":bytes,"units":units}));
        }
        let mut elapsed: Vec<f64> = samples
            .iter()
            .map(|v| v["totalMs"].as_f64().unwrap())
            .collect();
        elapsed.sort_by(f64::total_cmp);
        let p95 = elapsed[((elapsed.len() as f64 * 0.95).ceil() as usize) - 1];
        json!({"runs":5,"p95Ms":p95,"p95Estimator":"nearest-rank; five samples make p95 the observed maximum","targetMs":1000,"targetMet":p95<=1000.0,"samples":samples})
    }
    let whole = measure(&fixture, None);
    let episode = measure(&fixture, Some(&source.episodes[39].id));
    assert_eq!(fixture.fake.calls(), 0);
    println!(
        "METADATA_BENCHMARK {}",
        json!({"platform":std::env::consts::OS,"buildMode":if cfg!(debug_assertions){"debug"}else{"release"},"dataset":{"lockedEpisodes":80,"assets":80,"units":80,"historicalJobs":80,"immutablePngMedia":1,"rawBytesPerHistory":raw_bytes,"ruleSnapshotBytesPerHistory":rule_bytes},"measurement":"public Engine.dispatch(workspace.get) plus JSON serialization; excludes network, model latency and UI rendering","wholeProject":whole,"episodeFiltered":episode})
    );
}
