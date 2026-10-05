//! Read-only replay of a saved eight-batch foundation run. This executor has no
//! CLI/API/store write path; ordinary test runs never open a user's database.
use director_core::pipeline::{digest, run_foundation, LockedSource, TextExecutor, TextRequest};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};

const STOP: &str = "isolated variant replay intentionally stops before batch nine";
const WATCH_ASSET: &str = "prop:exam-scoring-watch";
const WATCH_VARIANT: &str = "exam-scoring-watch:base";

struct SavedBatch {
    job_id: String,
    request: TextRequest,
    original_response: Value,
    recorded_result: Value,
    state: String,
}

struct SavedRun {
    workflow_id: String,
    source: LockedSource,
    context: Value,
    model: String,
    reasoning: String,
    batches: Vec<SavedBatch>,
}

fn load_saved_run() -> SavedRun {
    let path = std::env::var_os("DIRECTOR_FOUNDATION_VARIANT_REPLAY_DB")
        .expect("explicit read-only fixture database path is required");
    let workflow_id = std::env::var("DIRECTOR_FOUNDATION_VARIANT_REPLAY_WORKFLOW")
        .expect("explicit saved workflow ID is required");
    // A deferred read transaction binds the input, checkpoints and raw events to
    // one consistent SQLite snapshot. SQLITE_OPEN_READ_ONLY forbids DB writes.
    let mut connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("read-only fixture database must already exist");
    let transaction = connection.transaction().unwrap();
    let snapshot: String = transaction
        .query_row(
            "SELECT snapshot FROM jobs WHERE id=?1 AND kind='workflow' AND entity_id='foundation.run'",
            [&workflow_id],
            |row| row.get(0),
        )
        .unwrap();
    let workflow: Value = serde_json::from_str(&snapshot).unwrap();
    let input = &workflow["input"];
    let source: LockedSource = serde_json::from_value(input["source"].clone()).unwrap();
    assert_eq!(
        source.episodes.len(),
        10,
        "this replay covers a ten-episode source"
    );
    let rows: Vec<(String, String, String, String)> = {
        let mut statement = transaction
            .prepare(
                "SELECT j.id,j.snapshot,j.result,w.state FROM workflow_steps w JOIN jobs j ON j.id=w.text_job_id WHERE w.workflow_id=?1 AND w.stage='foundation' AND j.kind='text' ORDER BY j.created_at,w.rowid LIMIT 8",
            )
            .unwrap();
        statement
            .query_map([&workflow_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(
        rows.len(),
        8,
        "the saved run must contain its original eight batches"
    );
    let batches = rows
        .into_iter()
        .enumerate()
        .map(|(index, (job_id, snapshot, result, state))| {
            assert_eq!(state, if index < 7 { "accepted" } else { "rejected" });
            let request: TextRequest = serde_json::from_str(&snapshot).unwrap();
            assert_eq!(request.input["episode"]["number"], json!(index + 1));
            assert_eq!(request.input["batchIndex"], json!(0));
            assert_eq!(request.input["batchCount"], json!(1));
            // Completed jobs contain materialized output. Recover the original
            // model response from its persisted Codex event instead of inventing
            // a fresh response or weakening the saved request contract.
            let original: String = transaction
                .query_row(
                    "SELECT json_extract(data,'$.item.text') FROM events WHERE job_id=?1 AND type='codex_event' AND json_extract(data,'$.type')='item.completed' AND json_extract(data,'$.item.type')='agent_message' ORDER BY id DESC LIMIT 1",
                    [&job_id],
                    |row| row.get(0),
                )
                .expect("saved original model response must exist");
            SavedBatch {
                job_id,
                request,
                original_response: serde_json::from_str(&original).unwrap(),
                recorded_result: serde_json::from_str(&result).unwrap(),
                state,
            }
        })
        .collect();
    let saved = SavedRun {
        workflow_id,
        source,
        context: json!({
            "foundation":input["foundation"],
            "assets":input["assets"],
            "selection":input["selection"],
            "settings":{"confirmedDirection":input["foundation"]["productionDirection"]}
        }),
        model: input["settings"]["textModel"].as_str().unwrap().into(),
        reasoning: input["settings"]["reasoning"].as_str().unwrap().into(),
        batches,
    };
    transaction.commit().unwrap();
    saved
}

fn same_request(actual: &TextRequest, expected: &TextRequest, batch: usize) -> Result<(), String> {
    let actual = serde_json::to_value(actual).unwrap();
    let expected = serde_json::to_value(expected).unwrap();
    if actual != expected {
        let changed: Vec<_> = [
            "stage",
            "skill",
            "model",
            "reasoning",
            "input",
            "schema",
            "ruleSnapshot",
        ]
        .into_iter()
        .filter(|field| actual[field] != expected[field])
        .collect();
        let mut catalog_changes = Vec::new();
        if let Some(assets) = actual["input"]["knownAssets"].as_array() {
            for asset in assets {
                let Some(old) = expected["input"]["knownAssets"]
                    .as_array()
                    .and_then(|items| items.iter().find(|old| old["id"] == asset["id"]))
                else {
                    continue;
                };
                for variant in asset["variants"].as_array().unwrap() {
                    let Some(prior) = old["variants"]
                        .as_array()
                        .and_then(|items| items.iter().find(|old| old["id"] == variant["id"]))
                    else {
                        continue;
                    };
                    for field in ["name", "sourceVariantId", "scope"] {
                        if variant[field] != prior[field] {
                            let scope_fields: Vec<_> = ["kind", "reason", "scenes"]
                                .into_iter()
                                .filter(|key| variant["scope"][key] != prior["scope"][key])
                                .collect();
                            catalog_changes.push(json!({"assetId":asset["id"],"variantId":variant["id"],"changedField":field,"changedScopeFields":scope_fields}));
                        }
                    }
                }
            }
        }
        return Err(format!(
            "batch {batch} rebuilt a different request ({changed:?}); expected hash {}, actual hash {}; catalog changes {}; no generation is possible",
            digest(&expected.to_string()), digest(&actual.to_string()), json!(catalog_changes)
        ));
    }
    Ok(())
}

struct ReadOnlyReplay<'a> {
    saved: &'a [SavedBatch],
    calls: AtomicUsize,
    accepted: Mutex<Vec<Value>>,
    ninth_request: Mutex<Option<TextRequest>>,
}

#[async_trait::async_trait]
impl TextExecutor for ReadOnlyReplay<'_> {
    async fn execute(&self, request: TextRequest) -> Result<Value, String> {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        if index == self.saved.len() {
            assert_eq!(self.accepted.lock().unwrap().len(), 8);
            assert_eq!(request.input["episode"]["number"], json!(9));
            *self.ninth_request.lock().unwrap() = Some(request);
            return Err(STOP.into());
        }
        let batch = self
            .saved
            .get(index)
            .ok_or("replay exceeded its saved eight batches")?;
        same_request(&request, &batch.request, index + 1)?;
        Ok(batch.original_response.clone())
    }

    async fn accept(&self, request: &TextRequest, value: &Value) -> Result<(), String> {
        let mut accepted = self.accepted.lock().unwrap();
        let index = accepted.len();
        let batch = &self.saved[index];
        same_request(request, &batch.request, index + 1)?;
        if batch.state == "accepted" {
            assert!(
                value == &batch.recorded_result,
                "batch {} must preserve its already accepted normalized result",
                index + 1
            );
        }
        // Across all original responses, registered identities and parent links
        // remain protected; the regression is a display-label refinement only.
        for asset in value["assets"].as_array().unwrap() {
            if let Some(prior) = request.input["knownAssets"]
                .as_array()
                .unwrap()
                .iter()
                .find(|prior| prior["id"] == asset["id"])
            {
                assert_eq!(asset["name"], prior["name"]);
                assert_eq!(asset["kind"], prior["kind"]);
                for variant in asset["variants"].as_array().unwrap() {
                    if let Some(old) = prior["variants"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|old| old["id"] == variant["id"])
                    {
                        assert_eq!(variant["sourceVariantId"], old["sourceVariantId"]);
                    }
                }
            }
        }
        accepted.push(value.clone());
        Ok(())
    }

    async fn reject(
        &self,
        _request: &TextRequest,
        _value: &Value,
        reason: &str,
    ) -> Result<(), String> {
        Err(format!("saved batch failed current validation: {reason}"))
    }
}

#[tokio::test]
#[ignore = "requires explicit private read-only DB/workflow env; replays saved outputs only and stops before batch nine"]
async fn saved_eight_batches_revalidate_and_resolve_watch_without_live_generation() {
    let saved = load_saved_run();
    let original_source = serde_json::to_value(&saved.source).unwrap();
    let original_sha = saved.source.sha256.clone();
    let replay = ReadOnlyReplay {
        saved: &saved.batches,
        calls: AtomicUsize::new(0),
        accepted: Mutex::new(Vec::new()),
        ninth_request: Mutex::new(None),
    };
    let error = run_foundation(
        &saved.source,
        &saved.context,
        &replay,
        &saved.model,
        &saved.reasoning,
    )
    .await
    .unwrap_err();
    assert_eq!(error, STOP);
    assert_eq!(replay.calls.load(Ordering::SeqCst), 9);
    assert_eq!(replay.accepted.lock().unwrap().len(), 8);
    assert!(serde_json::to_value(&saved.source).unwrap() == original_source);
    assert_eq!(saved.source.sha256, original_sha);
    let next = replay.ninth_request.lock().unwrap();
    let next = next.as_ref().unwrap();
    let watch = next.input["knownAssets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["id"] == WATCH_ASSET)
        .unwrap();
    let variant = watch["variants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|variant| variant["id"] == WATCH_VARIANT)
        .unwrap();
    assert_eq!(watch["name"], "大考计分手表");
    assert_eq!(variant["name"], "计分手表基础形象");
    assert_eq!(variant["sourceVariantId"], Value::Null);
    assert_eq!(variant["scope"]["kind"], "SCENES");
    assert_eq!(variant["scope"]["reason"], Value::Null);
    assert_eq!(
        variant["scope"]["scenes"],
        json!([{
            "episodeId":saved.source.episodes[7].id,
            "sceneId":saved.source.episodes[7].scene_ids[0]
        }])
    );
    let before = saved.batches[7].request.input["knownAssets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["id"] == WATCH_ASSET)
        .unwrap()["variants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|variant| variant["id"] == WATCH_VARIANT)
        .unwrap()
        .clone();
    assert_eq!(before["name"], "计分手表待定位形象");
    assert_eq!(before["scope"]["kind"], "UNRESOLVED");
    println!(
        "{}",
        json!({
            "workflowId":saved.workflow_id,
            "savedTextJobIds":saved.batches.iter().map(|batch|batch.job_id.clone()).collect::<Vec<_>>(),
            "acceptedBatches":8,
            "stoppedBeforeEpisode":9,
            "sourceEpisodes":10,
            "completeTenEpisodes":false,
            "sameOriginalTextRequests":8,
            "sameOriginalSourceSha256":original_sha,
            "originalSourceUnchanged":true,
            "existingIdentitiesAndParentReferencesUnchanged":true,
            "cliOrApiInvocations":0,
            "newGenerationJobs":0,
            "databaseAccess":"SQLite READ_ONLY, consistent read transaction",
            "watch":{"assetId":WATCH_ASSET,"variantId":WATCH_VARIANT,"name":variant["name"],"scope":variant["scope"],"sourceVariantId":variant["sourceVariantId"]}
        })
    );
}
