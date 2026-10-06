//! Offline production roundtrip using real source, publication, media and binding code.
use director_core::{
    binding,
    pipeline::{self, TextExecutor, TextRequest},
    providers::*,
    store::{hash_file, s, Store},
    tasks::{self, Channels},
    workflow::guard_from_input,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

#[derive(Default)]
struct Model {
    accepted: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl TextExecutor for Model {
    async fn execute(&self, request: TextRequest) -> Result<Value, String> {
        let input = &request.input;
        if request.stage == "foundation:F2" || request.stage == "foundation:Q1" {
            assert_eq!(input["source"]["coordinateSystem"], "UTF-16 half-open");
            let row = input["source"]["rows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row[4] == "body")
                .unwrap();
            return Ok(if request.stage == "foundation:F2" {
                json!({
                    "format":"ASSET_CATALOG_DESKTOP_V2", "sourceSha256":input["sourceSha256"], "coverage":input["scope"],
                    "assets":[{"name":"小王｜白衣", "type":"CH", "episodes":[row[2]],
                        "sceneRefs":[[row[2],row[3]]], "sourceRefs":[row[0]], "role":"主角",
                        "preparation":{"mode":"REFERENCE"}}]
                })
            } else {
                json!({
                    "format":"ASSET_OPTIMIZATION_DESKTOP_V2", "sourceSha256":input["sourceSha256"],
                    "coverage":input["scope"], "changes":{}
                })
            });
        }
        if request.stage == "assetVisualFacts" {
            return Ok(
                json!({"schemaVersion":"asset-visual-facts-wire/v1", "coveredPacketRef":input["coveredPacketRef"], "facts":[], "issues":[]}),
            );
        }
        if request.stage == "assetDesign" {
            assert_eq!(input["designMode"], "BASE");
            assert_eq!(input["imageEvidence"], "NO_PIXELS_READ");
            let refs: Vec<_> = input["evidence"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["id"].clone())
                .collect();
            return Ok(
                json!({"schemaVersion":"asset-design/v1", "assetId":input["asset"]["id"],
                "variantId":input["asset"]["variantId"], "prompt":"真人小王，白衣，在门口抬手，人物形象清晰。",
                "freeDesignScope":"原文未写的服装细节仅为制作设计。", "sourceRefs":refs, "referenceVariantIds":[]}),
            );
        }
        let rows = input["sourceRows"]
            .as_array()
            .ok_or("fake received no source rows")?;
        let row = rows
            .iter()
            .find(|row| row["kind"] == "body")
            .ok_or("no body")?;
        let refs = json!([row["id"]]);
        let emotion = json!({"subject":"小王","contextTone":"门口的低声阻拦","audienceEffect":"阻拦与召回可读",
            "change":"阻拦后召回","landing":"抬手的读点","retain":["原话与源演法"]});
        match request.stage.as_str() {
            "storyboardPlan" => Ok(json!({
                "schemaVersion":"storyboard-plan/v2","unitPackingPolicy":"event-first-v1","emotionArc":"阻拦后召回",
                "events":[{"id":"event","sceneId":row["sceneId"],"sourceRefs":refs,"boundaryBefore":{"kind":"episode_start","reason":"本集源开始"},"emotionContract":emotion}],
                "workPackages":[{"id":"package","eventId":"event","sourceRefs":refs,"contextRefs":[],"entryFactIds":[],"dependsOn":[],"scenarioKeys":[],"emotionContract":emotion}],
                "provisionalUnits":[{"id":"provisional","packageId":"package","sourceRefs":refs,"secondsRange":[4,4]}],
                "entryFacts":[],"fantasyCandidates":[]
            })),
            "storyboardFinish" if input["finishMode"] == "delta" => {
                assert_eq!(
                    request.schema["properties"]["schemaVersion"]["enum"][0],
                    "storyboard-delta/v2"
                );
                assert_eq!(
                    input["productionDirection"]["direction"],
                    "克制但有行动力度。"
                );
                let ids: Vec<_> = input["previousDraft"]["units"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|unit| unit["id"].clone())
                    .collect();
                Ok(
                    json!({"schemaVersion":"storyboard-delta/v2","baseDraftHash":input["baseDraftHash"],"retainedUnitIds":ids,"replacements":[],"revisionNotes":[],"unresolved":[]}),
                )
            }
            "storyboardCreate" | "storyboardFinish" => {
                assert_eq!(
                    request.schema["properties"]["schemaVersion"]["enum"][0],
                    "storyboard-draft/v2"
                );
                assert_eq!(
                    input["productionDirection"]["direction"],
                    "克制但有行动力度。"
                );
                let asset = &input["assets"][0];
                let quote = &row["dialogue"];
                let parts: Vec<_> = quote["spokenSegments"].as_array().unwrap().iter().enumerate().map(|(index,segment)| json!({
                    "lineId":quote["id"],"quoteStart":segment["range"]["start"],"quoteEnd":segment["range"]["end"],
                    "presentation":"画内","delivery":"低声说出","voiceStart":index as f64,"voiceEnd":index as f64+0.9
                })).collect();
                Ok(json!({"schemaVersion":"storyboard-draft/v2","units":[{
                    "id":"unit","episodeId":row["episodeId"],"eventId":"event","sceneId":row["sceneId"],"title":"门口召回",
                    "unitDirection":"小王抬手示意，低声阻拦后召回。","intent":{"subject":"小王","change":"阻拦后召回","landing":"抬手的读点","retain":["原话与源演法"]},
                    "boundaryBefore":{"kind":"episode_start","reason":"本集源开始"},"scene":"门口","participants":["小王"],"props":[],
                    "lighting":"门外侧光","initialState":"小王站在门口。","exitState":"小王抬手后仍站在门口。","sourceRefs":refs,
                    "assetRefs":[{"assetId":asset["id"],"variantId":asset["variantId"],"use":"character","order":1,"sourceRefs":refs}],
                    "shots":[{"id":"shot","duration":4.0,"camera":"近景读手势与脸部","picture":"小王抬手示意。","lighting":"门外侧光",
                        "sound":"原声与门口底声","transition":"手势收住后切出","sourceRefs":refs,"contextRefs":[],"dialogueParts":parts}]
                }],"fantasyRealization":[],"revisionNotes":[],"unresolved":[]}))
            }
            other => Err(format!("unexpected fake stage: {other}")),
        }
    }

    async fn accept(&self, request: &TextRequest, _: &Value) -> Result<(), String> {
        self.accepted.lock().unwrap().push(request.stage.clone());
        Ok(())
    }
}

/// Deliberately contains no network or subprocess implementation.
#[derive(Default)]
struct MediaChannel {
    submits: AtomicUsize,
    downloads: AtomicUsize,
}
impl Channels for MediaChannel {
    fn capabilities(&self, _: &ProviderConfig) -> ProviderResult<Capabilities> {
        Ok(serde_json::from_value(json!({"provider":"offline-test-channel","version":"offline-test/v1","source":"in-process fake", "checkedAt":"offline","models":[],"canCancel":false,"canReconcileUnknown":false,"raw":{}})).unwrap())
    }
    fn prepare(
        &self,
        _: &ProviderConfig,
        r: &GenerationRequest,
    ) -> ProviderResult<PreparedRequest> {
        for reference in &r.references {
            assert_eq!(hash_file(&reference.path).unwrap().0, reference.sha256);
        }
        Ok(PreparedRequest {
            provider: "offline-test-channel".into(),
            request: r.clone(),
            capability_version: "offline-test/v1".into(),
            upload_receipts: vec![],
            wire: json!({"mock":true}),
            estimated_cost: None,
            prepared_at: "offline".into(),
        })
    }
    fn submit(&self, _: &ProviderConfig, p: &PreparedRequest) -> ProviderResult<SubmitReceipt> {
        self.submits.fetch_add(1, Ordering::SeqCst);
        Ok(SubmitReceipt {
            task_id: format!("remote-{}", p.request.kind),
            status: "processing".into(),
            result_urls: vec![],
            raw: json!({"mock":true}),
        })
    }
    fn query(&self, _: &ProviderConfig, id: &str) -> ProviderResult<QueryResult> {
        assert!(["remote-image", "remote-video"].contains(&id));
        Ok(QueryResult {
            task_id: id.into(),
            status: "succeeded".into(),
            result_urls: vec![format!("mock://{id}")],
            error: None,
            actual_cost: None,
            raw: json!({"mock":true}),
        })
    }
    fn download(
        &self,
        _: &ProviderConfig,
        url: &str,
        path: &Path,
    ) -> ProviderResult<DownloadReceipt> {
        self.downloads.fetch_add(1, Ordering::SeqCst);
        let image = url == "mock://remote-image";
        if image {
            image::RgbImage::from_pixel(2, 2, image::Rgb([70, 90, 110]))
                .save(path)
                .unwrap();
        } else {
            assert_eq!(url, "mock://remote-video");
            fs::write(path, b"offline fixture bytes; not a playable video").unwrap();
        }
        let (sha256, bytes) = hash_file(path).unwrap();
        Ok(DownloadReceipt {
            path: path.into(),
            sha256,
            bytes,
            mime: Some(if image { "image/png" } else { "video/mp4" }.into()),
        })
    }
    fn reconcile(&self, _: &ProviderConfig, _: &str) -> ProviderResult<QueryResult> {
        panic!("known task recovery must not reconcile or resubmit")
    }
}

fn frozen(store: &Store) -> Value {
    let source = store.source().unwrap();
    json!({"source":source,"foundation":store.foundation().unwrap(),"assets":store.values("assets").unwrap(),
        "existingUnits":store.values("units").unwrap(),"selection":{"episodeIds":[source["episodes"][0]["id"]]},
        "settings":{"visualStyle":"16:9真人","fantasyMode":"off","confirmedDirection":"克制但有行动力度。"},
        "capabilities":{"version":"offline-test/v1","minDuration":4,"maxDuration":15,"imageLimit":5}})
}

#[tokio::test]
async fn locked_source_to_current_image_to_published_storyboard_binds_exact_identity() {
    let temporary = tempfile::tempdir().unwrap();
    let store = Store::open(temporary.path().join("project")).unwrap();
    store.create("离线闭环", "roundtrip").unwrap();
    let source =
        pipeline::prepare_source("第一集\n场景：门口\n小王（低声）：别动（抬手），回来😀。\n")
            .unwrap();
    store
        .save_source(serde_json::to_value(&source).unwrap())
        .unwrap();
    let model = Model::default();
    let input = frozen(&store);
    let foundation = pipeline::foundation_delivery::run_foundation_delivery(
        &source,
        &input,
        &model,
        "offline-test-model",
        "medium",
    )
    .await
    .unwrap();
    let assets = pipeline::flatten_foundation_assets(&foundation);
    assert_eq!(assets.len(), 1);
    store
        .publish_foundation(
            &guard_from_input(&input),
            serde_json::to_value(foundation).unwrap(),
            assets,
            None,
        )
        .unwrap();

    let design_input = frozen(&store);
    let designs = pipeline::run_asset_design(&design_input, &model, "offline-test-model", "medium")
        .await
        .unwrap();
    assert!(
        designs["blocked"].as_array().unwrap().is_empty(),
        "{}",
        designs["blocked"]
    );
    assert_eq!(designs["assets"].as_array().unwrap().len(), 1);
    let mut designed = designs["assets"][0].clone();
    designed["expectedVersion"] = designed["version"].clone();
    let asset = store.save_asset(designed).unwrap();
    assert_eq!(asset["promptOrigin"], "AI");
    assert_eq!(asset["design"]["schemaVersion"], "asset-design/v1");

    // All channels are in-process doubles. The only writes are in this temporary project.
    store
        .save_settings(&json!({"ffprobePath":temporary.path().join("absent-ffprobe.exe")}))
        .unwrap();
    let channels = MediaChannel::default();
    let config: ProviderConfig =
        serde_json::from_value(json!({"kind":"offline-test-channel"})).unwrap();
    let image_snapshot = json!({"requestId":"image-roundtrip", "kind":"image", "provider":"offline-test-channel",
        "model":"offline-image", "prompt":asset["prompt"], "promptBody":asset["prompt"],
        "assetId":asset["id"], "assetVersion":asset["version"], "variantId":asset["variantId"],
        "sourceVersion":store.source().unwrap()["version"], "ratio":"16:9", "resolution":"2K",
        "references":[], "options":{}, "autoSubmit":true, "ruleSnapshot":pipeline::rule_snapshot("asset-image-production").unwrap()});
    binding::validate_generation_snapshot(&store, &image_snapshot).unwrap();
    let image_job = store
        .add_job(
            "image",
            s(&asset, "id"),
            "offline-test-channel",
            "offline-account",
            &image_snapshot,
            "queued",
        )
        .unwrap();
    tasks::run_generation(&store, &image_job, &config, "offline-account", &channels).unwrap();
    assert_eq!(
        store.job(&image_job).unwrap()["providerTaskId"],
        "remote-image"
    );
    tasks::resume_job(
        &store,
        &image_job,
        &config,
        "offline-account",
        &channels,
        true,
    )
    .unwrap();
    let downloaded = store.job(&image_job).unwrap();
    assert_eq!(downloaded["status"], "downloaded");
    let image = store
        .get("media", downloaded["resultMediaIds"][0].as_str().unwrap())
        .unwrap();
    let image_file = store.verify_media(&image).unwrap();
    assert_eq!(hash_file(&image_file).unwrap().0, s(&image, "sha256"));
    assert_eq!(image::open(image_file).unwrap().width(), 2);
    assert_eq!(
        store
            .adopted(s(&asset, "id"), s(&asset, "variantId"))
            .unwrap()
            .as_deref(),
        Some(s(&image, "id"))
    );
    let submitted = channels.submits.load(Ordering::SeqCst);
    tasks::resume_job(
        &store,
        &image_job,
        &config,
        "offline-account",
        &channels,
        true,
    )
    .unwrap();
    assert_eq!(channels.submits.load(Ordering::SeqCst), submitted);

    let input = frozen(&store);
    let output = pipeline::run_storyboard(&input, &model, "offline-test-model", "medium")
        .await
        .unwrap();
    assert_eq!(output["status"], "completed");
    assert_eq!(output["units"].as_array().unwrap().len(), 1);
    store
        .publish_storyboard(&guard_from_input(&input), &output, &input, None)
        .unwrap();
    let unit = store.get("units", s(&output["units"][0], "id")).unwrap();
    let spoken: String = unit["shots"][0]["dialogueParts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| s(part, "text"))
        .collect();
    assert_eq!(spoken, "别动，回来😀。");
    assert_eq!(unit["assetRefs"][0]["assetId"], asset["id"]);
    assert_eq!(unit["sourceVersion"], store.source().unwrap()["version"]);
    assert_eq!(
        unit["foundationVersion"],
        store.foundation().unwrap()["version"]
    );

    let mut package = binding::bind(
        &store,
        &unit,
        "offline-test-channel",
        "offline-test-video-model",
    )
    .unwrap();
    assert!(
        package["problems"].as_array().unwrap().is_empty(),
        "{}",
        package["problems"]
    );
    assert_eq!(package["references"].as_array().unwrap().len(), 1);
    let reference = &package["references"][0];
    assert_eq!(reference["assetId"], asset["id"]);
    assert_eq!(reference["variantId"], asset["variantId"]);
    assert_eq!(
        reference["assetVersion"],
        store.get("assets", s(&asset, "id")).unwrap()["version"]
    );
    assert_eq!(reference["mediaId"], image["id"]);
    assert_eq!(reference["sha256"], image["sha256"]);
    assert!(s(&package, "prompt").contains("@图片1"));
    assert!(!s(&package, "prompt").contains("{{asset:"));
    binding::validate_snapshot(&store, &package).unwrap();
    package["autoSubmit"] = json!(true);
    let video_job = store
        .add_job(
            "video",
            s(&unit, "id"),
            "offline-test-channel",
            "offline-account",
            &package,
            "queued",
        )
        .unwrap();
    tasks::run_generation(&store, &video_job, &config, "offline-account", &channels).unwrap();
    let submitted_video = store.job(&video_job).unwrap();
    assert_eq!(submitted_video["providerTaskId"], "remote-video");
    assert_eq!(submitted_video["snapshot"], package);
    assert_eq!(
        submitted_video["prepared"]["request"]["references"][0]["sha256"],
        image["sha256"]
    );
    // Re-open the store: recovery is query/download of the original ID, never generation.
    let reopened = Store::open(store.root.clone()).unwrap();
    tasks::resume_job(
        &reopened,
        &video_job,
        &config,
        "offline-account",
        &channels,
        true,
    )
    .unwrap();
    let downloaded = reopened.job(&video_job).unwrap();
    assert_eq!(downloaded["status"], "downloaded");
    assert_eq!(downloaded["providerTaskId"], "remote-video");
    let video = reopened
        .get("media", downloaded["resultMediaIds"][0].as_str().unwrap())
        .unwrap();
    assert_eq!(
        hash_file(&reopened.verify_media(&video).unwrap())
            .unwrap()
            .0,
        s(&video, "sha256")
    );
    tasks::resume_job(
        &reopened,
        &video_job,
        &config,
        "offline-account",
        &channels,
        true,
    )
    .unwrap();
    assert_eq!(channels.submits.load(Ordering::SeqCst), 2); // 1 image + 1 video only.
    assert_eq!(channels.downloads.load(Ordering::SeqCst), 2); // Completed files are not downloaded twice.
    assert_eq!(reopened.source().unwrap()["sha256"], source.sha256);
    assert_eq!(reopened.source().unwrap()["text"], source.text);
    assert_eq!(
        *model.accepted.lock().unwrap(),
        [
            "foundation:F2",
            "foundation:Q1",
            "assetVisualFacts",
            "assetDesign",
            "storyboardPlan",
            "storyboardCreate",
            "storyboardFinish"
        ]
    );
    println!("offline Stage1 F2/Q1=2, Stage2 A15_A=1, design=1, Stage3 plan/create/finish=3 (author groups=1; finish groups=1); media submit=2; recovery submit=0; media SHA verified; video pixels/sound not assessed");
}
