use director_core::{
    binding, portable,
    providers::*,
    store::{s, Store},
    tasks::{self, Channels},
    Engine,
};
use serde_json::json;
use std::{
    fs,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tempfile::TempDir;

struct Fake {
    submits: AtomicUsize,
    queries: AtomicUsize,
    mode: AtomicUsize,
}
impl Fake {
    fn new() -> Self {
        Self {
            submits: AtomicUsize::new(0),
            queries: AtomicUsize::new(0),
            mode: AtomicUsize::new(0),
        }
    }
}
impl Channels for Fake {
    fn capabilities(&self, _: &ProviderConfig) -> ProviderResult<Capabilities> {
        Ok(serde_json::from_value(json!({"provider":"mock","version":"1","source":"test","checkedAt":"now","models":[],"canCancel":false,"canReconcileUnknown":false,"raw":{}})).unwrap())
    }
    fn prepare(
        &self,
        _: &ProviderConfig,
        r: &GenerationRequest,
    ) -> ProviderResult<PreparedRequest> {
        Ok(PreparedRequest {
            provider: "mock".into(),
            request: r.clone(),
            capability_version: "1".into(),
            upload_receipts: vec![],
            wire: json!({}),
            estimated_cost: Some(1.0),
            prepared_at: "now".into(),
        })
    }
    fn submit(&self, _: &ProviderConfig, _: &PreparedRequest) -> ProviderResult<SubmitReceipt> {
        self.submits.fetch_add(1, Ordering::SeqCst);
        if self.mode.load(Ordering::SeqCst) == 1 {
            return Err(ProviderError::uncertain("connection lost"));
        }
        Ok(SubmitReceipt {
            task_id: "remote-1".into(),
            status: "processing".into(),
            result_urls: vec![],
            raw: json!({}),
        })
    }
    fn query(&self, _: &ProviderConfig, key: &str) -> ProviderResult<QueryResult> {
        self.queries.fetch_add(1, Ordering::SeqCst);
        if self.mode.load(Ordering::SeqCst) == 2 {
            return Err(ProviderError::auth());
        }
        Ok(QueryResult {
            task_id: key.into(),
            status: "succeeded".into(),
            result_urls: vec!["https://example.test/result.mp4".into()],
            error: None,
            actual_cost: Some(1.1),
            raw: json!({}),
        })
    }
    fn download(&self, _: &ProviderConfig, _: &str, p: &Path) -> ProviderResult<DownloadReceipt> {
        fs::write(p, b"mock-video-bytes").unwrap();
        let (h, size) = director_core::store::hash_file(p).unwrap();
        Ok(DownloadReceipt {
            path: p.into(),
            sha256: h,
            bytes: size,
            mime: Some("video/mp4".into()),
        })
    }
    fn reconcile(&self, _: &ProviderConfig, _: &str) -> ProviderResult<QueryResult> {
        Err(ProviderError::new("MANUAL", "manual"))
    }
}
fn config() -> ProviderConfig {
    serde_json::from_value(json!({"kind":"mock"})).unwrap()
}
fn setup() -> (TempDir, Store, String) {
    let tmp = TempDir::new().unwrap();
    let st = Store::open(tmp.path().join("project")).unwrap();
    st.create("test", "p").unwrap();
    let source =
        director_core::pipeline::prepare_source("第1集\n场景：门口\n小王：走。\n").unwrap();
    let episode = source.episodes[0].id.clone();
    let scene = source.scenes[0].id.clone();
    let row = source.rows[2].id.clone();
    st.save_source(serde_json::to_value(source).unwrap())
        .unwrap();
    st.save_asset(json!({"id":"a","variantId":"v","name":"小王","prompt":"portrait","applicability":{"episodes":[episode]}})).unwrap();
    let p = tmp.path().join("reference.png");
    image::RgbImage::new(2, 2).save(&p).unwrap();
    let m = st.import_media(&p, "image", Some("a"), Some("v")).unwrap();
    let mid = s(&m, "id").to_owned();
    st.adopt("a", "v", &mid).unwrap();
    st.save_unit(json!({"id":"u","episodeId":episode,"sceneId":scene,"sourceRefs":[row],"prompt":"{{asset:a:v}} 小王开门说走。","duration":5,"assetRefs":[{"assetId":"a","variantId":"v","order":0}]})).unwrap();
    (tmp, st, mid)
}
fn queued(st: &Store, auto: bool) -> String {
    let mut snap = binding::bind(st, &st.get("units", "u").unwrap(), "mock", "video").unwrap();
    snap["autoSubmit"] = json!(auto);
    st.add_job("video", "u", "mock", "account", &snap, "queued")
        .unwrap()
}

#[test]
fn frozen_reference_order_and_precise_staleness() {
    let (_tmp, st, mid) = setup();
    let snap = binding::bind(&st, &st.get("units", "u").unwrap(), "mock", "video").unwrap();
    assert!(s(&snap, "prompt").contains("@图片1"));
    assert_eq!(snap["references"][0]["mediaId"], mid);
    let key = queued(&st, false);
    tasks::run_generation(&st, &key, &config(), "account", &Fake::new()).unwrap();
    assert_eq!(s(&st.job(&key).unwrap(), "status"), "ready");
    let mut a = st.get("assets", "a").unwrap();
    a["name"] = json!("小王新外观");
    st.save_asset(a).unwrap();
    assert_eq!(s(&st.job(&key).unwrap(), "status"), "stale");
    assert!(binding::validate_snapshot(&st, &snap).is_err());
}
#[test]
fn submitted_snapshot_survives_adoption_change_and_restart_without_resubmit() {
    let (_tmp, st, _) = setup();
    let key = queued(&st, true);
    let fake = Fake::new();
    tasks::run_generation(&st, &key, &config(), "account", &fake).unwrap();
    let original = st.job(&key).unwrap()["snapshot"].clone();
    let p = st.root.join("new.png");
    image::RgbImage::from_pixel(2, 2, image::Rgb([255, 0, 0]))
        .save(&p)
        .unwrap();
    let m = st.import_media(&p, "image", Some("a"), Some("v")).unwrap();
    st.adopt("a", "v", s(&m, "id")).unwrap();
    st.recover_interrupted().unwrap();
    tasks::resume_job(&st, &key, &config(), "account", &fake, true).unwrap();
    assert_eq!(fake.submits.load(Ordering::SeqCst), 1);
    assert_eq!(st.job(&key).unwrap()["snapshot"], original);
    assert_eq!(s(&st.job(&key).unwrap(), "status"), "downloaded");
}
#[test]
fn unknown_submit_and_exit_intent_never_resubmit() {
    let (_tmp, st, _) = setup();
    let key = queued(&st, true);
    let fake = Fake::new();
    fake.mode.store(1, Ordering::SeqCst);
    tasks::run_generation(&st, &key, &config(), "account", &fake).unwrap();
    st.recover_interrupted().unwrap();
    tasks::run_generation(&st, &key, &config(), "account", &fake).unwrap();
    assert!(tasks::resume_job(&st, &key, &config(), "account", &fake, true).is_err());
    assert_eq!(fake.submits.load(Ordering::SeqCst), 1);
    assert_eq!(s(&st.job(&key).unwrap(), "status"), "submission_unknown");
}
#[test]
fn auth_expiry_pauses_and_same_account_query_recovers() {
    let (_tmp, st, _) = setup();
    let key = queued(&st, true);
    let fake = Fake::new();
    tasks::run_generation(&st, &key, &config(), "account", &fake).unwrap();
    fake.mode.store(2, Ordering::SeqCst);
    tasks::resume_job(&st, &key, &config(), "account", &fake, true).unwrap();
    assert_eq!(s(&st.job(&key).unwrap(), "status"), "auth_required");
    assert!(tasks::resume_job(&st, &key, &config(), "other-account", &fake, true).is_err());
    fake.mode.store(0, Ordering::SeqCst);
    tasks::resume_job(&st, &key, &config(), "account", &fake, true).unwrap();
    assert_eq!(fake.submits.load(Ordering::SeqCst), 1);
}
#[test]
fn upload_interruption_requeues_without_generation() {
    let (_tmp, st, _) = setup();
    let key = queued(&st, false);
    st.update_job(&key, "preparing", &json!({})).unwrap();
    st.recover_interrupted().unwrap();
    let f = Fake::new();
    tasks::run_generation(&st, &key, &config(), "account", &f).unwrap();
    assert_eq!(f.submits.load(Ordering::SeqCst), 0);
    assert_eq!(s(&st.job(&key).unwrap(), "status"), "ready");
}
#[test]
fn media_hash_and_portable_export_relocation() {
    let (tmp, st, _) = setup();
    let zip = tmp.path().join("project.director.zip");
    portable::export(&st, &zip).unwrap();
    let imported = portable::import(&zip, &tmp.path().join("other-machine")).unwrap();
    for m in imported.values("media").unwrap() {
        assert!(imported
            .verify_media(&m)
            .unwrap()
            .starts_with(tmp.path().join("other-machine")));
    }
    let m = imported.values("media").unwrap()[0].clone();
    fs::write(imported.absolute_media(&m).unwrap(), b"corrupt").unwrap();
    assert!(imported.verify_media(&m).is_err());
}
#[test]
fn backup_retention_is_bounded_without_touching_originals() {
    let (tmp, st, _) = setup();
    let dir = st.root.join("backups");
    fs::create_dir_all(&dir).unwrap();
    for n in 0..60 {
        fs::write(dir.join(format!("snapshot-{n:03}.sqlite")), [0; 20]).unwrap();
    }
    for n in 0..4 {
        fs::write(dir.join(format!("checkpoint-{n:03}.sqlite")), [0; 20]).unwrap();
    }
    portable::prune(&dir, 400).unwrap();
    let size: u64 = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len())
        .sum();
    assert!(size <= 400);
    assert!(tmp.path().join("reference.png").exists());
    assert!(st.verify_media(&st.values("media").unwrap()[0]).is_ok());
}
#[test]
fn eighty_episode_queue_prepare_submit_resume_are_separate() {
    let (_tmp, st, _) = setup();
    let f = Fake::new();
    let text = (1..=80)
        .map(|n| format!("第{n}集\n场景：门口\n△小王出现。\n"))
        .collect::<String>();
    let source = director_core::pipeline::prepare_source(&text).unwrap();
    st.save_source(serde_json::to_value(&source).unwrap())
        .unwrap();
    for (n, episode) in source.episodes.iter().enumerate() {
        let uid = format!("unit-{n}");
        let scene = &episode.scene_ids[0];
        let row = source
            .rows
            .iter()
            .find(|r| r.episode_id.as_ref() == Some(&episode.id) && r.kind == "body")
            .unwrap();
        st.save_unit(json!({"id":uid,"episodeId":episode.id,"sceneId":scene,"sourceRefs":[row.id],"prompt":"独立可投喂单元","duration":5,"assetRefs":[]})).unwrap();
        let mut snapshot =
            binding::bind(&st, &st.get("units", &uid).unwrap(), "mock", "video").unwrap();
        assert!(snapshot["problems"].as_array().unwrap().is_empty());
        snapshot["autoSubmit"] = json!(true);
        let job = st
            .add_job("video", &uid, "mock", "account", &snapshot, "queued")
            .unwrap();
        tasks::run_generation(&st, &job, &config(), "account", &f).unwrap();
    }
    assert_eq!(f.submits.load(Ordering::SeqCst), 80);
    st.recover_interrupted().unwrap();
    for j in st.jobs().unwrap() {
        tasks::resume_job(&st, s(&j, "id"), &config(), "account", &f, false).unwrap();
    }
    assert_eq!(f.submits.load(Ordering::SeqCst), 80);
    assert_eq!(f.queries.load(Ordering::SeqCst), 80);
}
#[test]
fn independent_engine_and_read_projections() {
    let tmp = TempDir::new().unwrap();
    let e = Engine::with_channels(tmp.path().join("home"), Arc::new(Fake::new())).unwrap();
    let p = e
        .dispatch(json!({"action":"projects.create","title":"demo"}))
        .unwrap();
    let w = e
        .dispatch(json!({"action":"workspace.get","projectId":p["id"]}))
        .unwrap();
    assert!(w["source"].is_null());
    assert_eq!(w["settings"]["textConcurrency"], 4);
}
