//! Explicit original A15_A/C + three-role storyboard live text acceptance.
//! Synthetic temporary project only; no media channel or production database.
use director_core::{
    pipeline::{self, LockedSource},
    store::{s, Store},
    text_executor::SavedTextExecutor,
    workflow::guard_from_input,
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::PathBuf, time::Instant};
const SOURCE: &str =
    "第一集\n场景：门口\n△小王穿白色衣服站在门口。\n小王（低声）：先别走。\n△小王抬手示意停下。\n";
fn ensure(condition: bool, message: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn counts(store: &Store) -> Result<(i64, i64), String> {
    let conn = store.conn()?;
    let jobs = conn
        .query_row("SELECT COUNT(*) FROM jobs WHERE kind='text'", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let events=conn.query_row("SELECT COUNT(*) FROM events e JOIN jobs j ON j.id=e.job_id WHERE j.kind='text' AND e.type='codex_event'",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    Ok((jobs, events))
}
fn text_jobs(store: &Store) -> Result<Vec<Value>, String> {
    Ok(store.jobs()?.into_iter().filter(|j|j["kind"]=="text").map(|j|json!({"id":j["id"],"stage":j["snapshot"]["stage"],"skill":j["snapshot"]["skill"],"status":j["status"],"validation":j["receipt"]["validation"],"ruleId":j["snapshot"]["ruleSnapshot"]["primary"]["id"],"ruleVersion":j["snapshot"]["ruleSnapshot"]["primary"]["version"],"ruleSha256":j["snapshot"]["ruleSnapshot"]["primary"]["sha256"],"methods":j["snapshot"]["ruleSnapshot"]["methods"],"inputCharacters":j["snapshot"]["input"].to_string().chars().count(),"output":j["result"],"error":j["error"]})).collect())
}
fn frozen(store: &Store) -> Result<Value, String> {
    let source = store.source()?;
    Ok(
        json!({"source":source,"foundation":store.foundation()?,"assets":store.values("assets")?,"existingUnits":[],"selection":{"episodeIds":[source["episodes"][0]["id"]]},"settings":{"visualStyle":"16:9真人","fantasyMode":"off","referenceMode":"TEXT_ONLY","confirmedDirection":"克制的真人短剧，只呈现白衣小王在门口低声挽留与抬手阻拦，保留完整原话和动作，不新增人物、道具、能力或背景事件。"},"capabilities":{"version":"isolated-text-only/v1","mode":"TEXT_ONLY","minDuration":4,"maxDuration":15,"imageLimit":5}}),
    )
}
fn check_storyboard(source: &LockedSource, output: &Value) -> Result<Value, String> {
    ensure(
        output["status"] == "completed",
        &format!("第三阶段未完成：{}", output["blocked"]),
    )?;
    let units = output["units"].as_array().ok_or("没有文字单元")?;
    ensure(!units.is_empty(), "第三阶段未产生文字单元")?;
    let mut spoken = String::new();
    let mut parts = 0;
    let mut references = 0;
    let mut intervals = HashSet::new();
    for unit in units {
        let prompt = s(unit, "prompt");
        ensure(
            !prompt.trim().is_empty() && prompt.contains("小王"),
            "提示词未独立说明当前人物",
        )?;
        ensure(
            !["同上", "参照前一单元", "承接上一单元", "接上一个单元"]
                .iter()
                .any(|v| prompt.contains(v)),
            "提示词依赖前一单元",
        )?;
        for asset in unit["assetRefs"].as_array().ok_or("单元无结构化资产引用")? {
            ensure(
                asset["assetId"] == "xiaowang-white" && asset["variantId"] == "white",
                "资产引用没有使用fixture稳定身份",
            )?;
            references += 1;
        }
        for shot in unit["shots"].as_array().ok_or("单元无镜表")? {
            let duration = shot["duration"].as_f64().ok_or("镜时长无效")?;
            for part in shot["dialogueParts"].as_array().ok_or("缺少声窗结构")? {
                ensure(s(part, "speaker") == "小王", "说者归属不正确")?;
                let begin = part["voiceStart"].as_f64().ok_or("缺少声窗起点")?;
                let end = part["voiceEnd"].as_f64().ok_or("缺少声窗结束")?;
                ensure(
                    begin >= 0.0 && end > begin && end <= duration + 0.000001,
                    "声窗超出镜头或为空",
                )?;
                ensure(
                    intervals.insert((
                        s(part, "lineId").to_string(),
                        part["quoteStart"].to_string(),
                        part["quoteEnd"].to_string(),
                    )),
                    "原话区间重复",
                )?;
                let text = s(part, "text");
                ensure(prompt.contains(text), "独立提示词遗漏已物化原话")?;
                spoken.push_str(text);
                parts += 1;
            }
        }
    }
    let expected = source
        .rows
        .iter()
        .filter_map(|row| row.dialogue.as_ref())
        .map(pipeline::spoken_text)
        .collect::<String>();
    ensure(spoken == expected, "逐字对白、顺序或演法/发声分离不正确")?;
    ensure(parts > 0 && references > 0, "未核查到声窗或实际资产引用")?;
    Ok(
        json!({"units":units.len(),"spokenText":spoken,"expectedSpokenText":expected,"voiceWindows":parts,"assetReferences":references,"independentPrompts":true}),
    )
}
async fn exercise(
    store: &Store,
    source: &LockedSource,
    evidence: &mut Value,
) -> Result<(), String> {
    for (rule, version) in [
        ("asset-art-director", "1.3.0"),
        ("asset-visual-facts-extractor", "1.1.0"),
    ] {
        ensure(
            pipeline::rule_snapshot(rule)?["version"] == version,
            &format!("当前原版规则版本未加载：{rule}@{version}"),
        )?;
    }
    let settings = json!({"textProvider":"codex","codexPath":std::env::var("DIRECTOR_TEST_CODEX_PATH").unwrap_or_default(),"textModel":"gpt-6.1-sol","reasoning":"medium"});
    let resolved = director_core::text_cli::resolve_settings(&settings).await?;
    ensure(
        s(&resolved, "textModel") == "gpt-6.1-sol" && s(&resolved, "reasoning") == "medium",
        "实际模型/强度错误",
    )?;
    evidence["cliVersion"] = resolved["textCliVersion"].clone();
    let run = store.add_job(
        "workflow",
        "images.design",
        "local",
        "",
        &json!({"stage":"images.design","sourceSha256":source.sha256}),
        "running",
    )?;
    let executor = SavedTextExecutor {
        store: store.clone(),
        settings: resolved.clone(),
        workflow_id: Some(run),
    };
    let input = frozen(store)?;
    let before = counts(store)?;
    let start = Instant::now();
    let designed = pipeline::run_asset_design(&input, &executor, "gpt-6.1-sol", "medium").await?;
    evidence["stage2Milliseconds"] = json!(start.elapsed().as_millis());
    evidence["assetPromptProposal"] = designed.clone();
    ensure(
        designed["blocked"]
            .as_array()
            .map(|v| v.is_empty())
            .unwrap_or(false),
        &format!("第二阶段阻塞：{}", designed["blocked"]),
    )?;
    ensure(
        designed["assets"].as_array().map(|v| v.len()) == Some(1),
        "没有交付唯一确定的资产设计",
    )?;
    ensure(
        designed["facts"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|f| s(f, "assetId") == "xiaowang" && s(f, "value").contains("白")),
        "A15_A没有提取源支持的白衣事实",
    )?;
    ensure(
        s(&designed["assets"][0], "prompt").contains("白"),
        "C设计漏掉白衣事实",
    )?;
    let after_design = counts(store)?;
    evidence["stage2GenerationRequestsSent"] = json!(after_design.0 - before.0);
    ensure(
        after_design.0 - before.0 == 2,
        "极小fixture应执行一次A15_A和一次C",
    )?;
    let jobs = text_jobs(store)?;
    for (stage, rule, version) in [
        ("assetVisualFacts", "asset-visual-facts-extractor", "1.1.0"),
        ("assetDesign", "asset-art-director", "1.3.0"),
    ] {
        let snapshot = pipeline::rule_snapshot(rule)?;
        ensure(
            jobs.iter().any(|job| {
                job["stage"] == stage
                    && job["ruleId"] == rule
                    && job["ruleVersion"] == version
                    && job["ruleSha256"] == snapshot["sha256"]
                    && job["validation"] == "accepted"
            }),
            &format!("未实际采用当前原版规则：{stage}/{rule}@{version}"),
        )?;
    }
    store.publish_asset_design(
        input["source"]["version"].as_i64().ok_or("源版本缺失")?,
        input["foundation"]["version"].as_i64().unwrap_or(0),
        &designed,
    )?;
    ensure(
        !s(&store.get("assets", "xiaowang-white")?, "prompt").is_empty(),
        "设计未原子落库",
    )?;
    ensure(
        !store.foundation()?["visualFactBatches"]
            .as_array()
            .map(|v| v.is_empty())
            .unwrap_or(true),
        "空事实/事实包回执未落库",
    )?;
    let replay = pipeline::run_asset_design(&input, &executor, "gpt-6.1-sol", "medium").await?;
    ensure(replay == designed, "同输入缓存复跑改变资产设计或事实身份")?;
    let after_replay = counts(store)?;
    evidence["stage2CacheAdditionalRequests"] = json!(after_replay.0 - after_design.0);
    ensure(
        after_replay == after_design,
        "第二阶段缓存复跑新增请求或CLI事件",
    )?;
    let storyboard_input = frozen(store)?;
    let run = store.add_job(
        "workflow",
        "storyboard.run",
        "local",
        "",
        &json!({"stage":"storyboard.run","sourceSha256":source.sha256}),
        "running",
    )?;
    let executor = SavedTextExecutor {
        store: store.clone(),
        settings: resolved,
        workflow_id: Some(run),
    };
    let start = Instant::now();
    let output =
        pipeline::run_storyboard(&storyboard_input, &executor, "gpt-6.1-sol", "medium").await?;
    evidence["stage3Milliseconds"] = json!(start.elapsed().as_millis());
    evidence["storyboardProposal"] = output.clone();
    evidence["stage3Checks"] = check_storyboard(source, &output)?;
    let after_storyboard = counts(store)?;
    evidence["stage3GenerationRequestsSent"] = json!(after_storyboard.0 - after_replay.0);
    store.publish_storyboard(
        &guard_from_input(&storyboard_input),
        &output,
        &storyboard_input,
        None,
    )?;
    let jobs = text_jobs(store)?;
    for (stage, skill) in [
        ("storyboardPlan", "episode-emotion-planner"),
        ("storyboardCreate", "unit-performance-director"),
        ("storyboardFinish", "episode-finishing-editor"),
    ] {
        ensure(
            jobs.iter().any(|job| {
                job["stage"] == stage
                    && job["skill"] == skill
                    && job["ruleId"] == skill
                    && job["validation"] == "accepted"
                    && !s(job, "ruleSha256").is_empty()
            }),
            &format!("未实际执行并采用规则岗位：{stage}"),
        )?;
    }
    let replay =
        pipeline::run_storyboard(&storyboard_input, &executor, "gpt-6.1-sol", "medium").await?;
    check_storyboard(source, &replay)?;
    ensure(replay == output, "同输入复跑改变分镜单元内容")?;
    let final_counts = counts(store)?;
    evidence["stage3CacheAdditionalRequests"] = json!(final_counts.0 - after_storyboard.0);
    ensure(
        final_counts == after_storyboard,
        "第三阶段缓存复跑新增请求或CLI事件",
    )?;
    ensure(
        store.source()?["text"] == SOURCE && store.source()?["sha256"] == source.sha256,
        "原文被改变",
    )?;
    evidence["nativeJsonlEvents"] = json!(final_counts.1 - before.1);
    ensure(final_counts.1 > before.1, "未取得真实JSONL事件")?;
    Ok(())
}
#[tokio::test]
#[ignore = "real Codex A15_A/C and three-role storyboard text only, no paid image/video"]
async fn original_stage2_and_stage3_run_live_and_replay_without_additional_requests() {
    let temporary = tempfile::tempdir().unwrap();
    let store = Store::open(temporary.path().join("isolated-project")).unwrap();
    store
        .create(
            "原版第二三阶段真实文本烟测",
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    store.ensure_workflow_storage().unwrap();
    let source = pipeline::prepare_source(SOURCE).unwrap();
    pipeline::validate_source(&source).unwrap();
    assert!(!source.diagnostics.iter().any(|d| d.blocking));
    let stored = store.save_source(json!(source)).unwrap();
    let episode = &source.episodes[0];
    let scene = &source.scenes[0];
    let row = &source.rows[2].id;
    store.save_foundation(json!({"schemaVersion":"foundation/v1","sourceSha256":source.sha256,"overview":"白衣小王在门口低声挽留并抬手阻拦。","direction":"真人克制表达。","productionDirection":"克制的真人表达，人物白衣与源动作不变，不添加背景事件。","directionConfirmed":true,"episodes":[{"episodeId":episode.id,"summary":"小王低声挽留。","context":"门口连续动作。","sourceRefs":episode.row_ids}],"assets":[{"id":"xiaowang","name":"小王","kind":"CH","aliases":[],"description":"白衣人物","sourceRefs":[row],"variants":[]}],"facts":[],"issues":[]})).unwrap();
    store.save_asset(json!({"id":"xiaowang-white","baseAssetId":"xiaowang","variantId":"white","name":"小王","kind":"CH","description":"原文明示白色衣服。","sourceRefs":[row],"scope":{"kind":"SCENES","scenes":[{"episodeId":episode.id,"sceneId":scene.id}]},"applicability":{"episodes":[episode.id],"scenes":[scene.id]},"preparation":{"mode":"REFERENCE"},"prompt":""})).unwrap();
    let rule_contracts: Vec<_> = [
        "asset-visual-facts-extractor",
        "asset-art-director",
        "episode-emotion-planner",
        "unit-performance-director",
        "episode-finishing-editor",
    ]
    .into_iter()
    .map(|id| {
        let snapshot = pipeline::rule_snapshot(id).unwrap();
        json!({"id":snapshot["id"],"version":snapshot["version"],"sha256":snapshot["sha256"]})
    })
    .collect();
    let mut evidence = json!({"ok":false,"artifact":"original-stage23-live/verbatim-asset-rules-v1","ruleContracts":rule_contracts,"originalBodyShaReport":"reports/original-asset-rule-body-sha.json","model":"gpt-6.1-sol","reasoning":"medium","syntheticFixture":true,"sourceSha256":stored["sha256"],"source":SOURCE,"productionDatabaseAccess":false,"imageVideoGenerationRequestsSent":0});
    let result = exercise(&store, &source, &mut evidence).await;
    evidence["ok"] = json!(result.is_ok());
    evidence["textJobs"] = json!(text_jobs(&store).unwrap_or_else(|e| vec![json!({"error":e})]));
    if let Err(error) = &result {
        evidence["error"] = json!(error);
        evidence["retainedFixture"] = json!(temporary.keep());
    }
    let report = std::env::var("DIRECTOR_TEST_STAGE23_REPORT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("reports/original-stage23-live.json")
        });
    assert!(report.is_absolute());
    std::fs::create_dir_all(report.parent().unwrap()).unwrap();
    director_core::store::atomic_json(&report, &evidence).unwrap();
    println!(
        "{}",
        json!({"ok":evidence["ok"],"report":report,"error":evidence.get("error"),"stage2Requests":evidence["stage2GenerationRequestsSent"],"stage3Requests":evidence["stage3GenerationRequestsSent"],"cacheAdditional":[evidence["stage2CacheAdditionalRequests"],evidence["stage3CacheAdditionalRequests"]]})
    );
    assert!(
        result.is_ok(),
        "real stage23 failed: {}",
        result.unwrap_err()
    );
}
