use director_core::{
    binding, pipeline,
    providers::{
        Capabilities, DownloadReceipt, GenerationRequest, PreparedRequest, ProviderConfig,
        ProviderResult, QueryResult, SubmitReceipt,
    },
    store::{s, Store},
    tasks::{self, Channels},
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
};
use tempfile::TempDir;

// These are real SQLite/media/binding boundaries. They never invoke a provider,
// text model, or media probe. Prepare-only tests use an in-memory fake channel;
// any submit/query/download attempt is an immediate failure.
struct Fixture {
    temp: TempDir,
    store: Store,
    episode: String,
    scene: String,
    source_row: String,
    parent_media: Value,
}

impl Fixture {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        let store = Store::open(temp.path().join("project")).unwrap();
        store.create("素材绑定验收", "material-binding").unwrap();
        let source = pipeline::prepare_source("第1集\n场景：门口\n小王：我受伤了，走。\n").unwrap();
        let episode = source.episodes[0].id.clone();
        let scene = source.scenes[0].id.clone();
        let source_row = source
            .rows
            .iter()
            .find(|r| r.kind == "body")
            .unwrap()
            .id
            .clone();
        store
            .save_source(serde_json::to_value(source).unwrap())
            .unwrap();
        store
            .save_asset(json!({
                "id":"hero_base", "baseAssetId":"hero", "variantId":"hero:base",
                "name":"小王基础形象", "kind":"character", "prompt":"小王基础参考图",
                "scope":{"kind":"GLOBAL", "scenes":[]},
                "preparation":{"mode":"REFERENCE"}, "sourceRefs":[source_row]
            }))
            .unwrap();
        let image_path = temp.path().join("baseline.png");
        image::RgbImage::from_pixel(3, 2, image::Rgb([20, 40, 80]))
            .save(&image_path)
            .unwrap();
        let parent_media = store
            .import_media(&image_path, "image", Some("hero_base"), Some("hero:base"))
            .unwrap();
        store
            .adopt("hero_base", "hero:base", s(&parent_media, "id"))
            .unwrap();
        Self {
            temp,
            store,
            episode,
            scene,
            source_row,
            parent_media,
        }
    }

    fn inline(&self, id: &str, variant: &str, parent: Option<&str>) -> Value {
        let mut asset = json!({
            "id":id, "baseAssetId":"hero", "variantId":variant,
            "name":"小王受伤状态", "kind":"character", "description":"当前场景手臂受伤",
            "preparation":{"mode":"INLINE", "fromKey":"hero:base"},
            "scope":{"kind":"SCENES", "scenes":[{"episodeId":self.episode,"sceneId":self.scene}]},
            "applicability":{"episodes":[self.episode],"scenes":[self.scene]},
            "sourceRefs":[self.source_row]
        });
        if let Some(parent) = parent {
            asset["sourceVariantId"] = json!(parent);
        }
        self.store.save_asset(asset).unwrap()
    }

    fn unit(&self, id: &str, prompt: &str, refs: Value) -> Value {
        self.store
            .save_unit(json!({
                "id":id, "episodeId":self.episode, "sceneId":self.scene,
                "sourceRefs":[self.source_row], "prompt":prompt, "duration":5, "assetRefs":refs
            }))
            .unwrap()
    }

    fn bind(&self, unit: &Value) -> Value {
        binding::bind(&self.store, unit, "mock", "mock-video").unwrap()
    }

    fn freeze(&self, snapshot: &Value, state: &str) -> String {
        self.store
            .add_job(
                "video",
                s(snapshot, "unitId"),
                "mock",
                "test-account",
                snapshot,
                state,
            )
            .unwrap()
    }
}

fn assert_ready(snapshot: &Value) {
    assert_eq!(
        snapshot["problems"],
        json!([]),
        "unexpected binding problems: {}",
        snapshot["problems"]
    );
}

#[derive(Default)]
struct PrepareOnlyChannels {
    prepares: AtomicUsize,
}

impl Channels for PrepareOnlyChannels {
    fn capabilities(&self, _: &ProviderConfig) -> ProviderResult<Capabilities> {
        panic!("offline material preparation does not read a live catalogue")
    }

    fn prepare(
        &self,
        _: &ProviderConfig,
        request: &GenerationRequest,
    ) -> ProviderResult<PreparedRequest> {
        self.prepares.fetch_add(1, Ordering::SeqCst);
        Ok(PreparedRequest {
            provider: "mock".into(),
            request: request.clone(),
            capability_version: "prepare-only/v1".into(),
            upload_receipts: vec![],
            wire: json!({"offline":true}),
            estimated_cost: None,
            prepared_at: "2026-10-06T00:00:00Z".into(),
        })
    }

    fn submit(&self, _: &ProviderConfig, _: &PreparedRequest) -> ProviderResult<SubmitReceipt> {
        panic!("prepare-only material acceptance must never submit video")
    }

    fn query(&self, _: &ProviderConfig, _: &str) -> ProviderResult<QueryResult> {
        panic!("prepare-only material acceptance has no cloud task to query")
    }

    fn download(&self, _: &ProviderConfig, _: &str, _: &Path) -> ProviderResult<DownloadReceipt> {
        panic!("prepare-only material acceptance must never download a cloud result")
    }

    fn reconcile(&self, _: &ProviderConfig, _: &str) -> ProviderResult<QueryResult> {
        panic!("prepare-only material acceptance has no unknown submit")
    }
}

#[test]
fn inline_state_binds_the_baseline_image_and_preserves_its_own_version() {
    let f = Fixture::new();
    let child = f.inline("hero_hurt", "hero:hurt", Some("hero:base"));
    assert!(f.store.adopted("hero_hurt", "hero:hurt").unwrap().is_none());
    let unit = f.unit(
        "hurt-unit",
        "{{asset:hero_hurt:hero:hurt}} 小王右臂受伤，原服装不变。",
        json!([
            {"assetId":"hero_hurt","variantId":"hero:hurt","order":0,"role":"identity"}
        ]),
    );
    let snapshot = f.bind(&unit);
    assert_ready(&snapshot);
    assert_eq!(snapshot["references"].as_array().unwrap().len(), 1);
    let reference = &snapshot["references"][0];
    assert_eq!(reference["mediaId"], f.parent_media["id"]);
    assert_eq!(reference["sha256"], f.parent_media["sha256"]);
    assert_eq!(reference["assetId"], "hero_base");
    assert_eq!(reference["variantId"], "hero:base");
    assert_eq!(
        reference["assetVersion"],
        f.store.get("assets", "hero_base").unwrap()["version"]
    );
    assert_eq!(
        reference["semanticBindings"],
        json!([
            {"assetId":"hero_hurt","variantId":"hero:hurt","assetVersion":child["version"]}
        ])
    );
    assert_eq!(s(&snapshot, "prompt"), "@图片1 小王右臂受伤，原服装不变。");
    binding::validate_snapshot(&f.store, &snapshot).unwrap();
}

#[test]
fn two_semantic_states_share_one_physical_image_order() {
    let f = Fixture::new();
    f.inline("hero_hurt", "hero:hurt", Some("hero:base"));
    f.inline("hero_wet", "hero:wet", Some("hero:base"));
    let unit = f.unit(
        "shared-unit",
        "{{asset:hero_hurt:hero:hurt}} 手臂受伤；{{asset:hero_wet:hero:wet}} 衣服沾水。",
        json!([
            {"assetId":"hero_wet","variantId":"hero:wet","order":5},
            {"assetId":"hero_hurt","variantId":"hero:hurt","order":0}
        ]),
    );
    let snapshot = f.bind(&unit);
    assert_ready(&snapshot);
    assert_eq!(snapshot["references"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["references"][0]["order"], 0);
    let semantic = snapshot["references"][0]["semanticBindings"]
        .as_array()
        .unwrap();
    assert_eq!(semantic.len(), 2);
    assert_eq!(semantic[0]["assetId"], "hero_hurt");
    assert_eq!(semantic[1]["assetId"], "hero_wet");
    assert_eq!(s(&snapshot, "prompt").matches("@图片1").count(), 2);
    assert!(!s(&snapshot, "prompt").contains("@图片2"));
    binding::validate_snapshot(&f.store, &snapshot).unwrap();
}

#[test]
fn replacing_baseline_image_expires_unsubmitted_inline_material_snapshots() {
    let f = Fixture::new();
    f.inline("hero_hurt", "hero:hurt", Some("hero:base"));
    let unit = f.unit(
        "replace-unit",
        "{{asset:hero_hurt:hero:hurt}} 小王带伤走。",
        json!([
            {"assetId":"hero_hurt","variantId":"hero:hurt","order":0}
        ]),
    );
    let snapshot = f.bind(&unit);
    assert_ready(&snapshot);
    let key = f.freeze(&snapshot, "ready");
    let frozen = f.store.job(&key).unwrap()["snapshot"].clone();
    let replacement = f.temp.path().join("replacement.png");
    image::RgbImage::from_pixel(3, 2, image::Rgb([90, 80, 70]))
        .save(&replacement)
        .unwrap();
    let media = f
        .store
        .import_media(&replacement, "image", Some("hero_base"), Some("hero:base"))
        .unwrap();
    f.store
        .adopt("hero_base", "hero:base", s(&media, "id"))
        .unwrap();
    let job = f.store.job(&key).unwrap();
    assert_eq!(s(&job, "status"), "stale");
    assert_eq!(
        job["snapshot"], frozen,
        "invalidation must preserve submitted-material evidence"
    );
    assert!(binding::validate_snapshot(&f.store, &snapshot).is_err());
    let refreshed = f.bind(&unit);
    assert_ready(&refreshed);
    assert_eq!(refreshed["references"][0]["mediaId"], media["id"]);
    assert_ne!(
        refreshed["references"][0]["sha256"],
        snapshot["references"][0]["sha256"]
    );
}

#[test]
fn changing_inline_semantic_version_expires_unsubmitted_parent_image_snapshot() {
    let f = Fixture::new();
    let mut child = f.inline("hero_hurt", "hero:hurt", Some("hero:base"));
    let unit = f.unit(
        "revision-unit",
        "{{asset:hero_hurt:hero:hurt}} 小王带伤走。",
        json!([
            {"assetId":"hero_hurt","variantId":"hero:hurt","order":0}
        ]),
    );
    let snapshot = f.bind(&unit);
    assert_ready(&snapshot);
    let key = f.freeze(&snapshot, "queued");
    child["description"] = json!("当前场景左臂受伤，与前稿不同");
    let revised = f.store.save_asset(child).unwrap();
    assert_ne!(
        revised["version"],
        snapshot["references"][0]["semanticBindings"][0]["assetVersion"]
    );
    assert!(binding::validate_snapshot(&f.store, &snapshot).is_err());
    assert_eq!(
        s(&f.store.job(&key).unwrap(), "status"),
        "stale",
        "the physical parent is unchanged, but its frozen semantic child is stale"
    );
    assert_eq!(
        f.store
            .adopted("hero_base", "hero:base")
            .unwrap()
            .as_deref(),
        Some(s(&f.parent_media, "id"))
    );
}

#[test]
fn audio_only_asset_does_not_request_or_consume_an_image_slot() {
    let f = Fixture::new();
    f.store
        .save_asset(json!({
            "id":"offscreen_voice","variantId":"voice:base","name":"门外声音",
            "kind":"character","preparation":{"mode":"AUDIO"},
            "scope":{"kind":"SCENES","scenes":[{"episodeId":f.episode,"sceneId":f.scene}]},
            "sourceRefs":[f.source_row]
        }))
        .unwrap();
    let unit = f.unit(
        "audio-unit",
        "{{asset:hero_base:hero:base}} 小王在门口；门外传来一句声音。",
        json!([
            {"assetId":"offscreen_voice","variantId":"voice:base","order":0,"role":"audio"},
            {"assetId":"hero_base","variantId":"hero:base","order":1,"role":"identity"}
        ]),
    );
    let snapshot = f.bind(&unit);
    assert_ready(&snapshot);
    assert_eq!(snapshot["references"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["references"][0]["order"], 0);
    assert_eq!(snapshot["references"][0]["kind"], "image");
    assert_eq!(s(&snapshot, "prompt").matches("@图片1").count(), 1);
    assert!(!s(&snapshot, "prompt").contains("@图片2"));
}

#[test]
fn cyclic_inline_material_sources_block_locally_without_binding_a_random_image() {
    let f = Fixture::new();
    f.inline("hero_hurt", "hero:hurt", Some("hero:wet"));
    f.inline("hero_wet", "hero:wet", Some("hero:hurt"));
    let unit = f.unit(
        "cycle-unit",
        "{{asset:hero_hurt:hero:hurt}} 小王带伤走。",
        json!([
            {"assetId":"hero_hurt","variantId":"hero:hurt","order":0}
        ]),
    );
    let snapshot = f.bind(&unit);
    assert_eq!(snapshot["references"], json!([]));
    let issue = snapshot["problems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["code"] == "MATERIAL_SOURCE_UNRESOLVED")
        .expect("cycle must be blocked");
    assert_eq!(issue["assetId"], "hero_hurt");
    assert!(s(issue, "message").contains("循环"));
    assert!(f.store.jobs().unwrap().is_empty());
}

#[test]
fn missing_explicit_inline_parent_blocks_instead_of_falling_back_by_name() {
    let f = Fixture::new();
    f.inline("hero_hurt", "hero:hurt", Some("missing:base"));
    let unit = f.unit(
        "missing-unit",
        "{{asset:hero_hurt:hero:hurt}} 小王带伤走。",
        json!([
            {"assetId":"hero_hurt","variantId":"hero:hurt","order":0}
        ]),
    );
    let snapshot = f.bind(&unit);
    assert_eq!(snapshot["references"], json!([]));
    let issue = snapshot["problems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["code"] == "MATERIAL_SOURCE_UNRESOLVED")
        .expect("missing parent must be blocked");
    assert_eq!(issue["assetId"], "hero_hurt");
    assert!(s(issue, "message").contains("missing:base"));
    assert!(f.store.jobs().unwrap().is_empty());
}

#[test]
fn inline_text_prop_freezes_instructions_without_consuming_an_image_slot() {
    let f = Fixture::new();
    let prop = f
        .store
        .save_asset(json!({"id":"system","variantId":"system:base",
        "kind":"prop","name":"系统文字界面","description":"只显示原文已有提示",
        "preparation":{"mode":"INLINE","note":"连续系统提示，无需独立位图"},
        "scope":{"kind":"GLOBAL","scenes":[]},"sourceRefs":[f.source_row]}))
        .unwrap();
    let unit = f.unit(
        "text-unit",
        "{{asset:hero_base:hero:base}} 看见 {{asset:system:system:base}}。",
        json!([{"assetId":"hero_base","variantId":"hero:base","order":0},
               {"assetId":"system","variantId":"system:base","order":1}]),
    );
    let snapshot = f.bind(&unit);
    assert_ready(&snapshot);
    assert_eq!(snapshot["references"].as_array().unwrap().len(), 1);
    assert_eq!(
        snapshot["inlineReferences"][0]["assetVersion"],
        prop["version"]
    );
    assert!(s(&snapshot, "prompt").contains("@图片1"));
    assert!(s(&snapshot, "prompt").contains("连续系统提示，无需独立位图"));
    assert!(!s(&snapshot, "prompt").contains("{{asset:"));
    binding::validate_snapshot(&f.store, &snapshot).unwrap();
    let key = f.freeze(&snapshot, "ready");
    let known_unit = f.unit(
        "known-text-unit",
        s(&unit, "prompt"),
        unit["assetRefs"].clone(),
    );
    let known_snapshot = f.bind(&known_unit);
    assert_ready(&known_snapshot);
    let known = f.freeze(&known_snapshot, "processing");
    f.store
        .update_job(
            &known,
            "processing",
            &json!({"providerTaskId":"existing-cloud-id"}),
        )
        .unwrap();
    let mut changed = prop;
    changed["preparation"]["note"] = json!("修订文字排版，仍不独立制图");
    f.store.save_asset(changed).unwrap();
    assert_eq!(f.store.job(&key).unwrap()["status"], "stale");
    assert_eq!(f.store.job(&known).unwrap()["status"], "processing");
    assert_eq!(f.store.job(&known).unwrap()["snapshot"], known_snapshot);
    assert!(binding::validate_snapshot(&f.store, &snapshot).is_err());
}

#[test]
fn catalogue_uppercase_inline_prop_prepares_as_text_without_cloud_submission() {
    let f = Fixture::new();
    let prop = f
        .store
        .save_asset(json!({
            "id":"catalogue-prop:catalogue-prop:base","variantId":"catalogue-prop:base",
            "baseAssetId":"catalogue-prop","kind":"PROP","name":"系统文字界面",
            "sourceVariantId":null,
            "preparation":{"mode":"INLINE","note":"以稳定版式呈现原文系统提示，不制作独立图片"},
            "scope":{"kind":"SCENES","scenes":[{"episodeId":f.episode,"sceneId":f.scene}]},
            "applicability":{"episodes":[f.episode],"scenes":[f.scene]},
            "sourceRefs":[f.source_row]
        }))
        .unwrap();
    let unit = f.unit(
        "catalogue-text-unit",
        "{{asset:hero_base:hero:base}} 看见 {{asset:catalogue-prop:catalogue-prop:base:catalogue-prop:base}}。",
        json!([
            {"assetId":"hero_base","variantId":"hero:base","order":0},
            {"assetId":prop["id"],"variantId":prop["variantId"],"order":1,"imageBindingRequired":true}
        ]),
    );
    let mut snapshot = f.bind(&unit);
    assert_ready(&snapshot);
    assert_eq!(snapshot["references"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["references"][0]["mediaId"], f.parent_media["id"]);
    assert_eq!(snapshot["inlineReferences"].as_array().unwrap().len(), 1);
    assert_eq!(
        snapshot["inlineReferences"][0]["assetVersion"],
        prop["version"]
    );
    assert!(s(&snapshot, "prompt").contains("以稳定版式呈现原文系统提示，不制作独立图片"));
    assert!(!s(&snapshot, "prompt").contains("{{asset:"));
    assert!(!s(&snapshot, "prompt").contains("@图片2"));
    binding::validate_generation_snapshot(&f.store, &snapshot).unwrap();
    snapshot["autoSubmit"] = json!(false);
    let key = f.freeze(&snapshot, "queued");
    let config: ProviderConfig = serde_json::from_value(json!({"kind":"mock"})).unwrap();
    let channels = PrepareOnlyChannels::default();
    tasks::run_generation(&f.store, &key, &config, "test-account", &channels).unwrap();
    let job = f.store.job(&key).unwrap();
    assert_eq!(job["status"], "ready");
    assert_eq!(job["snapshot"], snapshot);
    assert_eq!(job["prepared"]["request"]["prompt"], snapshot["prompt"]);
    assert_eq!(
        job["prepared"]["request"]["references"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(job["receipt"].is_null());
    assert!(s(&job, "providerTaskId").is_empty());
    assert_eq!(channels.prepares.load(Ordering::SeqCst), 1);
    tasks::run_generation(&f.store, &key, &config, "test-account", &channels).unwrap();
    assert_eq!(channels.prepares.load(Ordering::SeqCst), 1);
    assert_eq!(f.store.job(&key).unwrap()["status"], "ready");
}

#[test]
fn uppercase_inline_prop_keeps_explicit_parent_and_manual_image_paths() {
    for (case, kind, parent, adopted) in [
        ("explicit-parent", "PROP", Some("hero_base"), false),
        ("missing-parent", "PROP", Some("missing:base"), false),
        ("manual-image", "PROP", None, true),
        ("character", "CH", None, false),
        ("unknown-kind", "unknown", None, false),
    ] {
        let f = Fixture::new();
        let mut asset = json!({"id":"prop","variantId":"prop:base","kind":kind,
            "name":"素材状态","preparation":{"mode":"INLINE","note":"范围内表现"},
            "scope":{"kind":"GLOBAL","scenes":[]},"sourceRefs":[f.source_row]});
        if let Some(parent) = parent {
            asset["sourceAssetId"] = json!(parent);
        }
        let prop = f.store.save_asset(asset).unwrap();
        if adopted {
            f.store
                .adopt("prop", "prop:base", s(&f.parent_media, "id"))
                .unwrap();
        }
        let unit = f.unit(
            case,
            "{{asset:prop:prop:base}}",
            json!([
                {"assetId":"prop","variantId":"prop:base","order":0}
            ]),
        );
        let snapshot = f.bind(&unit);
        assert_eq!(snapshot["inlineReferences"], json!([]), "{case}");
        if parent == Some("hero_base") || adopted {
            assert_ready(&snapshot);
            assert_eq!(snapshot["prompt"], "@图片1");
            assert_eq!(snapshot["references"][0]["mediaId"], f.parent_media["id"]);
            assert_eq!(
                snapshot["references"][0]["assetId"],
                if adopted { "prop" } else { "hero_base" }
            );
            assert_eq!(
                snapshot["references"][0]["semanticBindings"][0]["assetVersion"],
                prop["version"]
            );
            binding::validate_generation_snapshot(&f.store, &snapshot).unwrap();
        } else {
            assert!(
                snapshot["problems"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p["code"] == "MATERIAL_SOURCE_UNRESOLVED"),
                "{case}"
            );
            assert_eq!(snapshot["references"], json!([]), "{case}");
        }
        assert!(f.store.jobs().unwrap().is_empty(), "{case}");
    }
}

#[test]
fn adopted_inline_prop_image_replaces_text_and_invalidates_only_unsubmitted_snapshot() {
    let f = Fixture::new();
    f.store
        .save_asset(
            json!({"id":"system","variantId":"system:base","kind":"prop",
        "name":"系统界面","preparation":{"mode":"INLINE","note":"文字界面"},
        "scope":{"kind":"GLOBAL","scenes":[]},"sourceRefs":[f.source_row]}),
        )
        .unwrap();
    let unit = f.unit(
        "text-image-unit",
        "{{asset:system:system:base}}",
        json!([{"assetId":"system","variantId":"system:base","order":0}]),
    );
    let snapshot = f.bind(&unit);
    assert_ready(&snapshot);
    let key = f.freeze(&snapshot, "ready");
    f.store
        .adopt("system", "system:base", s(&f.parent_media, "id"))
        .unwrap();
    assert_eq!(f.store.job(&key).unwrap()["status"], "stale");
    assert!(binding::validate_snapshot(&f.store, &snapshot).is_err());
    let physical = f.bind(&unit);
    assert_ready(&physical);
    assert_eq!(physical["inlineReferences"], json!([]));
    assert_eq!(physical["references"][0]["assetId"], "system");
    assert_eq!(physical["prompt"], "@图片1");
    binding::validate_snapshot(&f.store, &physical).unwrap();
}

#[test]
fn inline_prop_with_explicit_missing_parent_remains_blocked() {
    let f = Fixture::new();
    f.store
        .save_asset(
            json!({"id":"bad-prop","variantId":"bad-prop:base","kind":"prop",
        "name":"明确沿用不存在的素材","preparation":{"mode":"INLINE","fromKey":"missing:base"},
        "scope":{"kind":"GLOBAL","scenes":[]},"sourceRefs":[f.source_row]}),
        )
        .unwrap();
    let unit = f.unit(
        "bad-prop-unit",
        "{{asset:bad-prop:bad-prop:base}}",
        json!([{"assetId":"bad-prop","variantId":"bad-prop:base","order":0}]),
    );
    let snapshot = f.bind(&unit);
    assert!(snapshot["problems"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["code"] == "MATERIAL_SOURCE_UNRESOLVED"));
    assert_eq!(snapshot["inlineReferences"], json!([]));
}

#[test]
fn original_execution_export_keeps_readable_prose_and_uses_current_manual_text_for_submission() {
    let f = Fixture::new();
    let mut unit = f.unit(
        "execution-export-unit",
        "[参考素材] 小王基础形象\n分镜1｜0-5s｜5s\n画面：小王走。",
        json!([{"assetId":"hero_base","variantId":"hero:base","order":0,"use":"character"}]),
    );
    unit["storyboardCreativeProfile"] = json!("original-production-contract/v1");
    unit["channelPromptTemplate"] = json!("陈旧模板不得覆盖用户修改");
    unit = f.store.save_unit(unit).unwrap();
    let snapshot = f.bind(&unit);
    assert_ready(&snapshot);
    assert!(s(&snapshot, "prompt").contains("@图片1：小王基础形象"));
    assert!(!s(&snapshot, "prompt").contains("陈旧模板"));
    assert!(!s(&unit, "prompt").contains("{{asset:"));
    binding::validate_snapshot(&f.store, &snapshot).unwrap();
    unit["prompt"] = json!("用户修订的完整分镜正文");
    unit["promptOverride"] = json!(true);
    let revised = f.store.save_unit(unit).unwrap();
    let snapshot = f.bind(&revised);
    assert_ready(&snapshot);
    assert!(s(&snapshot, "prompt").starts_with("用户修订的完整分镜正文"));
    assert!(s(&snapshot, "prompt").contains("@图片1：小王基础形象"));
}
