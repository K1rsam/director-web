//! Explicit real-text acceptance of the migrated original F1 -> F2 -> Q1 flow.
//! The fixture is synthetic, the database is temporary, and no media channel is used.
use director_core::{
    pipeline::{
        self, foundation_delivery, FoundationProposal, LockedSource, TextExecutor, TextRequest,
    },
    store::{s, Store},
    text_executor::SavedTextExecutor,
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::PathBuf, time::Instant};

const SOURCE: &str = "第1集\n场景：旧仓库\n△梁晨穿深蓝工作服，持有刻有‘L-17’的银色钥匙站在木门前。陈岚穿灰色风衣，站在梁晨身旁。\n梁晨：这把钥匙只能交给你。\n△梁晨把银色钥匙交给陈岚，陈岚接过收好。\n第2集\n场景：旧仓库\n△紧接上场。梁晨仍穿深蓝工作服，陈岚仍穿灰色风衣，从口袋取出同一把刻有‘L-17’的银色钥匙，打开木门。\n陈岚：钥匙没有离开我。\n△梁晨左臂受伤，袖口留下持续可见血迹；他与陈岚仍在门前等待。\n梁晨：先别走。\n";

// A resumed live fixture may submit Q1 explicitly, but it must never regenerate
// its already accepted F2. The executor still performs the real cache lookup.
struct ResumeGuard {
    inner: SavedTextExecutor,
    resume: bool,
}
#[async_trait::async_trait]
impl TextExecutor for ResumeGuard {
    async fn execute(&self, request: TextRequest) -> Result<Value, String> {
        if self.resume && request.stage == "foundation:F2" {
            let mut snapshot = serde_json::to_value(&request).map_err(|error| error.to_string())?;
            snapshot["structuredOutputTransport"] = json!("strict-optionals/v1");
            snapshot["executorPolicy"] = json!("codex-isolated/v1");
            snapshot["executorIdentity"] = json!({"provider":"codex","executable":director_core::text_cli::resolve_executable(&self.inner.settings)?.to_string_lossy()});
            ensure(
                self.inner.store.jobs()?.iter().any(|job| {
                    job["kind"] == "text"
                        && job["status"] == "completed"
                        && job["receipt"]["validation"] == "accepted"
                        && job["snapshot"] == snapshot
                }),
                "原F2 accepted request hash已漂移，烟测拒绝再次生成F2",
            )?;
        }
        self.inner.execute(request).await
    }
    async fn accept(&self, request: &TextRequest, value: &Value) -> Result<(), String> {
        self.inner.accept(request, value).await
    }
    async fn reject(
        &self,
        request: &TextRequest,
        value: &Value,
        reason: &str,
    ) -> Result<(), String> {
        self.inner.reject(request, value, reason).await
    }
}

fn ensure(condition: bool, message: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.to_owned())
    }
}

fn counts(store: &Store) -> Result<(i64, i64), String> {
    let connection = store.conn()?;
    let jobs = connection
        .query_row("SELECT COUNT(*) FROM jobs WHERE kind='text'", [], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    let events = connection.query_row("SELECT COUNT(*) FROM events e JOIN jobs j ON j.id=e.job_id WHERE j.kind='text' AND e.type='codex_event'", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    Ok((jobs, events))
}

fn text_job_evidence(store: &Store) -> Result<Vec<Value>, String> {
    store
        .jobs()?
        .into_iter()
        .filter(|job| job["kind"] == "text")
        .map(|job| {
            let snapshot = &job["snapshot"];
            let event_count: i64 = store
                .conn()?
                .query_row(
                    "SELECT COUNT(*) FROM events WHERE job_id=?1 AND type='codex_event'",
                    [s(&job, "id")],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            Ok(json!({
                "id":job["id"], "stage":snapshot["stage"], "skill":snapshot["skill"],
                "status":job["status"], "validation":job["receipt"]["validation"],
                "scope":snapshot.pointer("/input/delivery/scope"),
                "inputCharacters":snapshot["input"].to_string().chars().count(),
                "schemaCharacters":snapshot["schema"].to_string().chars().count(),
                "ruleCharacters":snapshot["ruleSnapshot"].to_string().chars().count(),
                "outputCharacters":job["result"].to_string().chars().count(),
                "nativeJsonlEvents":event_count, "error":job["error"]
            }))
        })
        .collect()
}

fn check_asset_table(
    source: &LockedSource,
    proposal: &FoundationProposal,
) -> Result<Vec<Value>, String> {
    pipeline::validate_foundation(source, proposal)?;
    ensure(
        proposal.source_sha256 == source.sha256,
        "制作基础 sourceSha256 与锁定原文不一致",
    )?;
    let expected: HashSet<_> = source
        .episodes
        .iter()
        .map(|episode| episode.id.as_str())
        .collect();
    let covered: HashSet<_> = proposal
        .episodes
        .iter()
        .map(|episode| episode.episode_id.as_str())
        .collect();
    ensure(expected == covered, "最终制作基础没有完整覆盖两集")?;
    let table = pipeline::flatten_foundation_assets(proposal);
    ensure(!table.is_empty(), "没有输出可交第二阶段的资产表")?;
    let identities: HashSet<_> = proposal
        .assets
        .iter()
        .map(|asset| asset.id.as_str())
        .collect();
    ensure(identities.len() == proposal.assets.len(), "身份ID不唯一")?;
    let row_ids: HashSet<_> = table.iter().map(|row| s(row, "id")).collect();
    ensure(row_ids.len() == table.len(), "形象级资产行ID不唯一")?;
    for row in &table {
        ensure(
            !s(row, "id").is_empty()
                && !s(row, "variantId").is_empty()
                && !s(row, "baseAssetId").is_empty(),
            "资产行缺稳定身份/形象键",
        )?;
        ensure(
            row["sourceRefs"]
                .as_array()
                .is_some_and(|refs| !refs.is_empty()),
            "资产表缺当前原文来源引用",
        )?;
        ensure(
            row.pointer("/preparation/mode")
                .and_then(Value::as_str)
                .is_some(),
            "旧preparation未进入第二阶段资产表",
        )?;
        if row["scope"]["kind"] == "SCENES" {
            let scenes = row["scope"]["scenes"]
                .as_array()
                .ok_or("SCENES形象缺场引用")?;
            ensure(!scenes.is_empty(), "SCENES形象适用范围为空")?;
            for scope in scenes {
                ensure(
                    source.scenes.iter().any(|scene| {
                        scene.id == s(scope, "sceneId") && scene.episode_id == s(scope, "episodeId")
                    }),
                    "形象适用场不属于当前原文",
                )?;
                ensure(
                    row["applicability"]["episodes"]
                        .as_array()
                        .is_some_and(|episodes| episodes.contains(&scope["episodeId"]))
                        && row["applicability"]["scenes"]
                            .as_array()
                            .is_some_and(|scenes| scenes.contains(&scope["sceneId"])),
                    "扁平资产表丢失形象适用集场",
                )?;
            }
        }
    }
    for person in ["梁晨", "陈岚"] {
        ensure(
            proposal
                .assets
                .iter()
                .any(|asset| asset.name == person && asset.kind == "CH"),
            &format!("必要可见人物未正确登记：{person}"),
        )?;
    }
    ensure(
        proposal
            .assets
            .iter()
            .any(|asset| asset.kind == "LOC" && asset.name.contains("旧仓库")),
        "必要可复现场景未登记",
    )?;
    ensure(
        proposal.assets.iter().any(|asset| {
            asset.kind == "PROP"
                && (asset.name.contains("钥匙") || asset.description.contains("L-17"))
        }),
        "跨集交接和辨认的关键钥匙未登记",
    )?;
    let injured = proposal
        .assets
        .iter()
        .filter(|asset| asset.name == "梁晨")
        .flat_map(|asset| &asset.variants)
        .find(|variant| {
            variant.name.contains("伤")
                || variant.description.contains("血迹")
                || variant.description.contains("左臂")
        });
    let injured = injured.ok_or("第2集持续可见伤态未保留为形象")?;
    ensure(injured.scope.kind == "SCENES", "第二集伤态未明确局部适用场")?;
    let second = &source.episodes[1].id;
    ensure(
        !injured.scope.scenes.is_empty()
            && injured
                .scope
                .scenes
                .iter()
                .all(|scope| &scope.episode_id == second),
        "后集伤态错误前溯到第1集",
    )?;
    ensure(
        !proposal.issues.iter().any(|issue| issue.blocking),
        "明确的烟测剧本仍有阻塞问题，不能伪称通过",
    )?;
    Ok(table)
}

async fn exercise(
    store: &Store,
    source: &LockedSource,
    evidence: &mut Value,
    resume: bool,
) -> Result<(), String> {
    let settings = json!({"textProvider":"codex","codexPath":std::env::var("DIRECTOR_TEST_CODEX_PATH").unwrap_or_default(),"textModel":"gpt-6.1-sol","reasoning":"medium"});
    let resolved = director_core::text_cli::resolve_settings(&settings).await?;
    ensure(
        s(&resolved, "textModel") == "gpt-6.1-sol" && s(&resolved, "reasoning") == "medium",
        "实际模型或强度与指定参数不一致",
    )?;
    evidence["cliVersion"] = resolved["textCliVersion"].clone();
    evidence["cliExecutable"] = resolved["textCliExecutable"].clone();
    let existing = store.jobs()?;
    let workflow_id = if resume {
        existing
            .iter()
            .find(|job| {
                job["kind"] == "workflow"
                    && job["entityId"] == "foundation.run"
                    && job["snapshot"]["foundationMethod"] == foundation_delivery::METHOD_VERSION
                    && job["snapshot"]["sourceSha256"] == source.sha256
            })
            .map(|job| s(job, "id").to_owned())
            .ok_or("保留fixture缺原foundation工作流")?
    } else {
        store.add_job("workflow", "foundation.run", "local", "", &json!({"foundationMethod":foundation_delivery::METHOD_VERSION,"sourceSha256":source.sha256}), "running")?
    };
    let executor = ResumeGuard {
        inner: SavedTextExecutor {
            store: store.clone(),
            settings: resolved,
            workflow_id: Some(workflow_id),
        },
        resume,
    };
    let context = json!({"settings":{"ratio":"16:9","medium":"真人","confirmedDirection":"双人交接关键钥匙的连续行动，保留原文人物、对白、服装与伤态，不补造设定。"}});
    evidence["plan"] = foundation_delivery::preview_foundation_delivery(source, &context)?;
    let initial_counts = counts(store)?;
    let first_start = Instant::now();
    let first = foundation_delivery::run_foundation_delivery(
        source,
        &context,
        &executor,
        "gpt-6.1-sol",
        "medium",
    )
    .await?;
    evidence["firstRunMilliseconds"] = json!(first_start.elapsed().as_millis());
    let first_counts = counts(store)?;
    evidence["generationRequestsSent"] = json!(first_counts.0 - initial_counts.0);
    evidence["firstRunNativeJsonlEvents"] = json!(first_counts.1 - initial_counts.1);
    ensure(
        first_counts.0 - initial_counts.0 == if resume { 1 } else { 2 },
        "调用数量不符：新fixture只需F2+Q1，显式恢复fixture只需已拒绝Q1",
    )?;
    if resume {
        let new_jobs: Vec<_> = store
            .jobs()?
            .into_iter()
            .filter(|job| {
                job["kind"] == "text" && !existing.iter().any(|prior| prior["id"] == job["id"])
            })
            .collect();
        ensure(
            new_jobs.len() == 1 && new_jobs[0]["snapshot"]["stage"] == "foundation:Q1",
            "显式恢复重发了已经接受的F2",
        )?;
        evidence["newF2RequestsAfterExplicitResume"] = json!(0);
    }
    ensure(
        first_counts.1 > initial_counts.1,
        "未保存实际Codex JSONL事件",
    )?;
    let table = check_asset_table(source, &first)?;
    evidence["assetTable"] = json!(table);
    evidence["assetIdentities"] = json!(first.assets.iter().map(|asset| json!({"id":asset.id,"name":asset.name,"kind":asset.kind,"variantIds":asset.variants.iter().map(|variant| &variant.id).collect::<Vec<_>>()})).collect::<Vec<_>>());
    evidence["outputSha256"] = json!(pipeline::digest(
        &serde_json::to_string(&first).map_err(|error| error.to_string())?
    ));
    // Save only into the isolated fixture, so the table is tested as a real Stage2 handoff.
    store.save_foundation(serde_json::to_value(&first).map_err(|error| error.to_string())?)?;
    for row in pipeline::flatten_foundation_assets(&first) {
        store.save_asset(row)?;
    }
    ensure(
        store.values("assets")?.len() == table.len(),
        "临时资产表落库不完整",
    )?;
    let replay_start = Instant::now();
    let replay = foundation_delivery::run_foundation_delivery(
        source,
        &context,
        &executor,
        "gpt-6.1-sol",
        "medium",
    )
    .await?;
    evidence["cachedRunMilliseconds"] = json!(replay_start.elapsed().as_millis());
    let final_counts = counts(store)?;
    evidence["requestsSentAfterCacheReuse"] = json!(final_counts.0 - first_counts.0);
    evidence["nativeJsonlEventsAfterCacheReuse"] = json!(final_counts.1 - first_counts.1);
    ensure(
        final_counts == first_counts,
        "同输入续跑新增模型任务或CLI事件，缓存没有真正复用",
    )?;
    ensure(
        serde_json::to_value(&first).map_err(|error| error.to_string())?
            == serde_json::to_value(&replay).map_err(|error| error.to_string())?,
        "缓存复跑改变稳定资产ID、适用范围或制作基础内容",
    )?;
    check_asset_table(source, &replay)?;
    ensure(
        store.source()?["text"] == SOURCE && store.source()?["sha256"] == source.sha256,
        "原文在模型交付或资产落库期间被改变",
    )?;
    evidence["stableIdentityOnReplay"] = json!(true);
    evidence["sourceShaAndTextPreserved"] = json!(true);
    evidence["stage2AssetTablePersisted"] = json!(true);
    Ok(())
}

#[tokio::test]
#[ignore = "two real Codex text requests using the existing login; isolated fixture, no image/video generation"]
async fn original_f2_q1_generate_a_source_backed_asset_table_and_replay_without_new_calls() {
    let resumed = std::env::var("DIRECTOR_TEST_FOUNDATION_FIXTURE")
        .ok()
        .map(PathBuf::from);
    let mut temporary = if resumed.is_none() {
        Some(tempfile::tempdir().unwrap())
    } else {
        None
    };
    let project = resumed
        .clone()
        .unwrap_or_else(|| temporary.as_ref().unwrap().path().join("isolated-project"));
    if resumed.is_some() {
        let resolved = std::fs::canonicalize(&project).unwrap();
        let temp_root = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        assert!(
            project.is_absolute()
                && resolved.starts_with(temp_root)
                && project.file_name().and_then(|name| name.to_str()) == Some("isolated-project"),
            "只允许显式恢复本测试在系统Temp目录保留的isolated-project"
        );
    }
    let store = Store::open(project.clone()).unwrap();
    store.ensure_workflow_storage().unwrap();
    if resumed.is_none() {
        store
            .create(
                "原版第一阶段真实文本烟测",
                &uuid::Uuid::new_v4().to_string(),
            )
            .unwrap();
    }
    assert_eq!(
        store.project().unwrap()["title"],
        "原版第一阶段真实文本烟测"
    );
    let source = pipeline::prepare_source(SOURCE).unwrap();
    pipeline::validate_source(&source).unwrap();
    assert_eq!(source.episodes.len(), 2);
    assert!(!source
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.blocking));
    if resumed.is_none() {
        store
            .save_source(serde_json::to_value(&source).unwrap())
            .unwrap();
    } else {
        let original = store.source().unwrap();
        assert_eq!(original["text"], SOURCE, "恢复fixture的原文必须逐字相同");
        assert_eq!(
            original["sha256"], source.sha256,
            "恢复fixture的来源SHA必须相同"
        );
    }
    let mut evidence = json!({
        "ok":false,"method":foundation_delivery::METHOD_VERSION,"model":"gpt-6.1-sol","reasoning":"medium",
        "sourceSha256":source.sha256,"sourceCharacters":SOURCE.chars().count(),"episodes":source.episodes.len(),"scenes":source.scenes.len(),
        "productionDatabaseAccess":false,"imageVideoGenerationRequestsSent":0,"syntheticFixture":true,"explicitResume":resumed.is_some(),"fixtureProject":project
    });
    let outcome = exercise(&store, &source, &mut evidence, resumed.is_some()).await;
    evidence["textJobs"] =
        json!(text_job_evidence(&store)
            .unwrap_or_else(|error| vec![json!({"evidenceReadError":error})]));
    if let Ok((attempts, events)) = counts(&store) {
        evidence["textRequestAttempts"] = json!(attempts);
        evidence["nativeJsonlEvents"] = json!(events);
        if evidence.get("generationRequestsSent").is_none() {
            evidence["generationRequestsSent"] = json!(attempts);
        }
    }
    evidence["ok"] = json!(outcome.is_ok());
    if let Err(error) = &outcome {
        evidence["error"] = json!(error);
    }
    let report = std::env::var("DIRECTOR_TEST_FOUNDATION_REPORT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("reports/original-foundation-live.json")
        });
    assert!(
        report.is_absolute(),
        "evidence report must use an explicit absolute path"
    );
    if outcome.is_err() {
        // Retain only this synthetic fixture for diagnosing the original result;
        // do not repeat a paid text request or weaken the production validator.
        let retained = temporary
            .take()
            .map(|temporary| temporary.keep())
            .unwrap_or_else(|| project.parent().unwrap().to_path_buf());
        evidence["retainedFixture"] = json!(retained);
    }
    if let Some(parent) = report.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    director_core::store::atomic_json(&report, &evidence).unwrap();
    println!(
        "{}",
        json!({"ok":evidence["ok"],"report":report,"requests":evidence["generationRequestsSent"],"cacheAdditionalRequests":evidence["requestsSentAfterCacheReuse"],"error":evidence.get("error")})
    );
    assert!(
        outcome.is_ok(),
        "real original foundation smoke failed: {}",
        outcome.unwrap_err()
    );
}
