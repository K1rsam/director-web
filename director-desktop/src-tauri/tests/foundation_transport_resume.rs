//! Offline compatibility proof for a foundation transport appendix correction.
//! No model, media channel, production project, or accepted result is executed.
use director_core::{
    engine::workflow_resume_rule_audit,
    pipeline,
    providers::{
        Capabilities, DownloadReceipt, GenerationRequest, PreparedRequest, ProviderConfig,
        ProviderError, ProviderResult, QueryResult, SubmitReceipt,
    },
    store::{s, Store},
    tasks::Channels,
    Engine,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const F2: &str = "foundation-asset-catalog";
const Q1: &str = "foundation-finishing-editor";
const MARKER: &str = "## 桌面运输契约";

fn rule(id: &str, content: &str) -> Value {
    json!({"id":id,"version":"1.0.0","content":content,"sha256":pipeline::digest(content)})
}
fn rules() -> Value {
    json!([
        rule("screenplay-fidelity", "# F1\n原文由程序物化，覆盖一次。\n"),
        rule(
            F2,
            "# F2\n按原规则提取身份、形象、范围与来源。\n\n## 桌面运输契约\n旧目录字段。\n"
        ),
        rule(
            Q1,
            "# Q1\n仅输出有据差异，保留派生父关系。\n\n## 桌面运输契约\n旧差异字段。\n"
        ),
    ])
}
fn workflow(frozen: Value) -> Value {
    json!({"id":"offline-workflow","kind":"workflow","entityId":"foundation.run","status":"failed",
        "snapshot":{"runnerVersion":"desktop-runner/v1","stage":"foundation.run","foundationMethod":"foundation-delivery/v2",
            "sourceVersion":7,"input":{"source":{"sha256":"frozen-source-sha"},"assets":[{"id":"existing-identity"}]},"rules":frozen}})
}
fn change_content(rule: &mut Value, content: String) {
    rule["sha256"] = json!(pipeline::digest(&content));
    rule["content"] = json!(content);
}
fn corrected_rules(frozen: &Value, ids: &[&str]) -> Value {
    let mut corrected = frozen.clone();
    for rule in corrected.as_array_mut().unwrap() {
        if ids.contains(&s(rule, "id")) {
            let body = s(rule, "content").split_once(MARKER).unwrap().0;
            let content = format!("{body}{MARKER}\n轻量目录与差异字段由程序恢复。\n");
            change_content(rule, content);
        }
    }
    corrected
}
fn rejected(job: &Value, current: &Value) {
    let before = job.to_string();
    let error = workflow_resume_rule_audit(job, current).unwrap_err();
    assert!(error.contains("制作规则已更新"), "{error}");
    assert_eq!(job.to_string(), before);
}

#[test]
fn exact_rule_set_keeps_the_existing_resume_path_without_migration() {
    let rules = rules();
    assert_eq!(
        workflow_resume_rule_audit(&workflow(rules.clone()), &rules).unwrap(),
        None
    );
    let mut legacy = workflow(rules.clone());
    legacy["snapshot"]
        .as_object_mut()
        .unwrap()
        .remove("foundationMethod");
    assert_eq!(workflow_resume_rule_audit(&legacy, &rules).unwrap(), None);
}

#[test]
fn only_f2_q1_appendices_can_change_with_ordered_old_and_current_hash_evidence() {
    for changed in [vec![F2], vec![Q1], vec![F2, Q1]] {
        let old = rules();
        let job = workflow(old.clone());
        let before = job.to_string();
        let current = corrected_rules(&old, &changed);
        let audit = workflow_resume_rule_audit(&job, &current).unwrap().unwrap();
        assert_eq!(audit["policy"], "foundation-transport-footer/v1");
        assert_eq!(audit["foundationMethod"], "foundation-delivery/v2");
        assert_eq!(
            audit["frozenSnapshotSha256"],
            pipeline::digest(&job["snapshot"].to_string())
        );
        assert_eq!(audit["sourceVersion"], 7);
        assert_eq!(audit["sourceSha256"], "frozen-source-sha");
        assert_eq!(audit["originalSnapshotPreserved"], true);
        assert_eq!(
            audit["changedRules"].as_array().unwrap().len(),
            changed.len()
        );
        for (index, pair) in old
            .as_array()
            .unwrap()
            .iter()
            .zip(current.as_array().unwrap())
            .enumerate()
        {
            assert_eq!(audit["oldRules"][index]["id"], pair.0["id"]);
            assert_eq!(audit["oldRules"][index]["sha256"], pair.0["sha256"]);
            assert_eq!(audit["currentRules"][index]["sha256"], pair.1["sha256"]);
        }
        for changed in audit["changedRules"].as_array().unwrap() {
            let original = old
                .as_array()
                .unwrap()
                .iter()
                .find(|rule| rule["id"] == changed["id"])
                .unwrap();
            let body = s(original, "content").split_once(MARKER).unwrap().0;
            assert_eq!(changed["originalBodySha256"], pipeline::digest(body));
        }
        assert_eq!(job.to_string(), before);
    }
}

#[test]
fn changed_original_method_whitespace_and_line_endings_are_not_transport_changes() {
    let old = rules();
    for index in [1, 2] {
        for replacement in ["原规则", "原方法 ", "\r\n"] {
            let mut current = corrected_rules(&old, &[F2, Q1]);
            let content = s(&current[index], "content");
            let body_end = content.find(MARKER).unwrap();
            let altered = format!(
                "{}{}{}",
                &content[..body_end],
                replacement,
                &content[body_end..]
            );
            change_content(&mut current[index], altered);
            rejected(&workflow(old.clone()), &current);
        }
    }
}

#[test]
fn absent_embedded_or_ambiguous_transport_heading_is_rejected() {
    let old = rules();
    for index in [1, 2] {
        for content in [
            "# 无附录\n正文。\n".to_string(),
            format!("# 方法\n正文提到 {MARKER} 但不是标题。\n"),
            format!("{}{MARKER}\n第二个附录。\n", s(&old[index], "content")),
            s(&old[index], "content").replace(MARKER, &format!("{MARKER}补充")),
        ] {
            let mut before = old.clone();
            change_content(&mut before[index], content.clone());
            let mut current = before.clone();
            change_content(&mut current[index], format!("{content}修订。\n"));
            rejected(&workflow(before), &current);
        }
    }
}

#[test]
fn identities_versions_order_and_other_metadata_are_immutable() {
    let old = rules();
    let baseline = corrected_rules(&old, &[F2, Q1]);
    let mut cases = vec![];
    for index in [1, 2] {
        let mut current = baseline.clone();
        current[index]["id"] = json!("different-rule");
        cases.push(current);
        let mut current = baseline.clone();
        current[index]["version"] = json!("2.0.0");
        cases.push(current);
        let mut current = baseline.clone();
        current[index]["futureMetadata"] = json!("changed");
        cases.push(current);
    }
    let mut current = baseline.clone();
    current.as_array_mut().unwrap().swap(1, 2);
    cases.push(current);
    let mut current = baseline.clone();
    current.as_array_mut().unwrap().pop();
    cases.push(current);
    let mut current = baseline.clone();
    current
        .as_array_mut()
        .unwrap()
        .push(rule("new-rule", "新岗"));
    cases.push(current);
    for current in cases {
        rejected(&workflow(old.clone()), &current);
    }
    let mut duplicate = old.clone();
    duplicate.as_array_mut().unwrap().push(old[1].clone());
    rejected(
        &workflow(duplicate.clone()),
        &corrected_rules(&duplicate, &[F2, Q1]),
    );
}

#[test]
fn unchanged_fidelity_and_content_sha_consistency_are_required() {
    let old = rules();
    let mut current = corrected_rules(&old, &[F2, Q1]);
    change_content(&mut current[0], "# F1\n修改了保真正文。\n".to_string());
    rejected(&workflow(old.clone()), &current);
    for index in [0, 1, 2] {
        let mut before = old.clone();
        before[index]["sha256"] = json!("invalid-old-sha");
        rejected(&workflow(before), &corrected_rules(&old, &[F2, Q1]));
        let mut current = corrected_rules(&old, &[F2, Q1]);
        current[index]["sha256"] = json!("invalid-current-sha");
        rejected(&workflow(old.clone()), &current);
    }
}

#[test]
fn other_workflows_runner_or_methods_cannot_use_the_transport_exception() {
    let old = rules();
    let current = corrected_rules(&old, &[F2, Q1]);
    let original = workflow(old);
    let mut jobs = vec![];
    for (field, value) in [("kind", "text"), ("entityId", "storyboard.run")] {
        let mut job = original.clone();
        job[field] = json!(value);
        jobs.push(job);
    }
    for (field, value) in [
        ("stage", "storyboard.run"),
        ("runnerVersion", "desktop-runner/v2"),
        ("foundationMethod", "foundation-delivery/v3"),
    ] {
        let mut job = original.clone();
        job["snapshot"][field] = json!(value);
        jobs.push(job);
    }
    let mut legacy = original.clone();
    legacy["snapshot"]
        .as_object_mut()
        .unwrap()
        .remove("foundationMethod");
    jobs.push(legacy);
    for job in jobs {
        rejected(&job, &current);
    }
}

#[derive(Default)]
struct NoChannels(AtomicUsize);
impl NoChannels {
    fn forbidden<T>(&self) -> ProviderResult<T> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(ProviderError::new(
            "OFFLINE_TEST",
            "No upstream call is authorized in this test",
        ))
    }
}
impl Channels for NoChannels {
    fn capabilities(&self, _: &ProviderConfig) -> ProviderResult<Capabilities> {
        self.forbidden()
    }
    fn prepare(
        &self,
        _: &ProviderConfig,
        _: &GenerationRequest,
    ) -> ProviderResult<PreparedRequest> {
        self.forbidden()
    }
    fn submit(&self, _: &ProviderConfig, _: &PreparedRequest) -> ProviderResult<SubmitReceipt> {
        self.forbidden()
    }
    fn query(&self, _: &ProviderConfig, _: &str) -> ProviderResult<QueryResult> {
        self.forbidden()
    }
    fn download(&self, _: &ProviderConfig, _: &str, _: &Path) -> ProviderResult<DownloadReceipt> {
        self.forbidden()
    }
    fn reconcile(&self, _: &ProviderConfig, _: &str) -> ProviderResult<QueryResult> {
        self.forbidden()
    }
}

fn current_foundation_rules() -> Value {
    json!(pipeline::rule_snapshots()
        .into_iter()
        .filter(|rule| ["screenplay-fidelity", F2, Q1].contains(&rule.id.as_str()))
        .collect::<Vec<_>>())
}

#[test]
fn actual_resume_appends_audit_without_rewriting_frozen_source_data_or_accepted_steps() {
    let temporary = tempfile::tempdir().unwrap();
    let channels = Arc::new(NoChannels::default());
    let engine =
        Engine::with_channels(temporary.path().join("isolated-home"), channels.clone()).unwrap();
    let project = engine
        .dispatch(json!({"action":"projects.create","title":"离线运输续跑验收"}))
        .unwrap();
    let store = engine.store(s(&project, "id")).unwrap();
    let source = store
        .save_source(json!(pipeline::prepare_source(
            "第一集\n场景：门口\n甲：别动。\n"
        )
        .unwrap()))
        .unwrap();
    store.save_asset(json!({"id":"identity:base","baseAssetId":"identity","variantId":"base","kind":"CH","name":"甲基础形象","sourceRefs":[source["rows"][2]["id"]],"prompt":"已采用设计"})).unwrap();
    store.save_foundation(json!({"schemaVersion":"foundation/v1","sourceSha256":source["sha256"],"assets":[],"facts":[],"episodes":[],"issues":[],"overview":"已有基础","direction":"已有方向"})).unwrap();
    store.ensure_workflow_storage().unwrap();
    let current = current_foundation_rules();
    // Replace only the footer to simulate a frozen failed v2 workflow. Use an
    // intentionally stale guard so dispatch exercises real resume but cannot
    // reach SavedTextExecutor or any Codex process.
    let frozen = corrected_rules(&current, &[F2, Q1]);
    let snapshot = json!({"runnerVersion":"desktop-runner/v1","foundationMethod":"foundation-delivery/v2","stage":"foundation.run","rules":frozen,
        "sourceVersion":source["version"],"input":{"source":source,"foundation":store.foundation().unwrap(),"assets":store.values("assets").unwrap(),"settings":{"textModel":"DO-NOT-LAUNCH","reasoning":"medium"}},
        "guard":{"sourceVersion":-1,"foundationVersion":0,"assets":{},"units":{},"episodeIds":[]}});
    let run = store
        .add_job(
            "workflow",
            "foundation.run",
            "local",
            "local",
            &snapshot,
            "failed",
        )
        .unwrap();
    store.update_job(&run, "failed", &json!({"error":"frozen failure","result":{"preserved":true},"prepared":{"decisions":{"kept":true}}})).unwrap();
    let text = store
        .add_job(
            "text",
            "foundation:F2:accepted",
            "local",
            "local",
            &json!({"original":"accepted request"}),
            "completed",
        )
        .unwrap();
    let accepted = json!({"assets":[{"registryKey":"known-identity"}],"acceptedEvidence":"must remain byte identical"});
    store
        .checkpoint(
            &run,
            "F2:batch:0",
            "foundation:F2",
            "accepted-hash",
            "accepted",
            Some(&text),
            Some(&accepted),
            None,
        )
        .unwrap();
    let original_snapshot: String = store
        .conn()
        .unwrap()
        .query_row("SELECT snapshot FROM jobs WHERE id=?1", [&run], |row| {
            row.get(0)
        })
        .unwrap();
    let original_source = store.source().unwrap();
    let original_foundation = store.foundation().unwrap();
    let original_assets = store.values("assets").unwrap();
    let original_steps: String = store
        .conn()
        .unwrap()
        .query_row(
            "SELECT result FROM workflow_steps WHERE workflow_id=?1",
            [&run],
            |row| row.get(0),
        )
        .unwrap();
    let original_result: String = store
        .conn()
        .unwrap()
        .query_row("SELECT result FROM jobs WHERE id=?1", [&run], |row| {
            row.get(0)
        })
        .unwrap();
    engine
        .dispatch(json!({"action":"workflows.resume","projectId":project["id"],"workflowId":run}))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while s(&store.job(&run).unwrap(), "error") == "frozen failure" {
        assert!(
            Instant::now() < deadline,
            "Offline resume worker did not finish its guard check"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let final_job = store.job(&run).unwrap();
    assert_eq!(final_job["status"], "failed");
    assert!(s(&final_job, "error").contains("原文或制作基础已更新"));
    assert_eq!(final_job["snapshot"], snapshot);
    assert_eq!(final_job["result"]["preserved"], true);
    assert_eq!(final_job["prepared"], json!({"decisions":{"kept":true}}));
    let conn = store.conn().unwrap();
    let saved_snapshot: String = conn
        .query_row("SELECT snapshot FROM jobs WHERE id=?1", [&run], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(saved_snapshot, original_snapshot);
    let saved_result: String = conn
        .query_row("SELECT result FROM jobs WHERE id=?1", [&run], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(saved_result, original_result);
    let saved_steps: String = conn
        .query_row(
            "SELECT result FROM workflow_steps WHERE workflow_id=?1",
            [&run],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(saved_steps, original_steps);
    assert_eq!(
        store.accepted_step(&run, "accepted-hash").unwrap(),
        Some(accepted)
    );
    assert_eq!(store.source().unwrap(), original_source);
    assert_eq!(store.foundation().unwrap(), original_foundation);
    assert_eq!(store.values("assets").unwrap(), original_assets);
    let event: String = conn.query_row("SELECT data FROM events WHERE job_id=?1 AND type='foundation_transport_rule_migration'", [&run], |row| row.get(0)).unwrap();
    let audit: Value = serde_json::from_str(&event).unwrap();
    assert_eq!(
        audit,
        workflow_resume_rule_audit(&final_job, &current)
            .unwrap()
            .unwrap()
    );
    assert_eq!(audit["changedRules"].as_array().unwrap().len(), 2);
    let text_jobs: i64 = conn
        .query_row("SELECT COUNT(*) FROM jobs WHERE kind='text'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        text_jobs, 1,
        "Resume must not launch a new text request before the source guard"
    );
    assert_eq!(channels.0.load(Ordering::SeqCst), 0);
}

#[test]
fn actual_resume_rejects_a_method_change_before_audit_or_worker_launch() {
    let temporary = tempfile::tempdir().unwrap();
    let channels = Arc::new(NoChannels::default());
    let engine =
        Engine::with_channels(temporary.path().join("isolated-home"), channels.clone()).unwrap();
    let project = engine
        .dispatch(json!({"action":"projects.create","title":"离线正文拒绝验收"}))
        .unwrap();
    let store: Store = engine.store(s(&project, "id")).unwrap();
    let mut frozen = corrected_rules(&current_foundation_rules(), &[F2]);
    let f2 = frozen
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|rule| rule["id"] == F2)
        .unwrap();
    let changed = s(f2, "content").replacen("\n", "\n改写原版方法。\n", 1);
    change_content(f2, changed);
    let snapshot = json!({"runnerVersion":"desktop-runner/v1","stage":"foundation.run","foundationMethod":"foundation-delivery/v2","rules":frozen,"input":{"source":{"unchanged":true}}});
    let run = store
        .add_job(
            "workflow",
            "foundation.run",
            "local",
            "local",
            &snapshot,
            "failed",
        )
        .unwrap();
    store
        .update_job(&run, "failed", &json!({"error":"original error"}))
        .unwrap();
    let before = store.job(&run).unwrap();
    let error = engine
        .dispatch(json!({"action":"workflows.resume","projectId":project["id"],"workflowId":run}))
        .unwrap_err();
    assert!(error.contains("制作规则已更新"));
    assert_eq!(store.job(&run).unwrap(), before);
    let events: i64 = store.conn().unwrap().query_row("SELECT COUNT(*) FROM events WHERE job_id=?1 AND type='foundation_transport_rule_migration'", [&run], |row| row.get(0)).unwrap();
    assert_eq!(events, 0);
    assert_eq!(channels.0.load(Ordering::SeqCst), 0);
}
