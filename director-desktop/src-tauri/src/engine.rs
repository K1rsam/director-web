use crate::{
    binding,
    dreamina_session::{authorization_url, DreaminaSessions},
    pipeline, portable,
    providers::{Capabilities, ModelCapability, ProviderConfig},
    store::{atomic_json, id, now, s, Result, Store},
    tasks::{self, Channels, RealChannels},
    text_executor::SavedTextExecutor,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

pub struct Engine {
    pub home: PathBuf,
    pub channels: Arc<dyn Channels>,
    active: Mutex<HashSet<String>>,
    registry_mutex: Mutex<()>,
    // Serializes registry lifecycle changes with synchronous dispatch and worker reservations.
    lifecycle_mutex: Mutex<()>,
    dreamina_sessions: Arc<DreaminaSessions>,
    live_accounts: bool,
    pub stop: AtomicBool,
}
struct VideoChannel {
    account: String,
    fingerprint: String,
    capabilities: Capabilities,
    report: Value,
}
impl Engine {
    pub fn new(home: PathBuf) -> Result<Arc<Self>> {
        Self::build(home, Arc::new(RealChannels), true)
    }
    pub fn with_channels(home: PathBuf, channels: Arc<dyn Channels>) -> Result<Arc<Self>> {
        Self::build(home, channels, false)
    }
    fn build(home: PathBuf, channels: Arc<dyn Channels>, live_accounts: bool) -> Result<Arc<Self>> {
        fs::create_dir_all(home.join("projects")).map_err(|e| e.to_string())?;
        let engine = Arc::new(Self {
            home,
            channels,
            active: Mutex::new(HashSet::new()),
            registry_mutex: Mutex::new(()),
            lifecycle_mutex: Mutex::new(()),
            dreamina_sessions: Arc::new(DreaminaSessions::default()),
            live_accounts,
            stop: AtomicBool::new(false),
        });
        for p in engine.project_list()? {
            if project_archived(&p) || !Path::new(s(&p, "rootPath")).join("project.sqlite").is_file() {
                continue;
            }
            let store = registered_store(&p)?;
            store.recover_interrupted()?;
            store.ensure_current_images()?;
        }
        Ok(engine)
    }
    pub fn registry(&self) -> Result<Value> {
        let p = self.home.join("projects.json");
        if !p.exists() {
            return Ok(json!([]));
        }
        serde_json::from_slice(&fs::read(p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }
    fn register(&self, store: &Store) -> Result<()> {
        let _guard = self.registry_mutex.lock().map_err(|e| e.to_string())?;
        let mut list = self.registry()?;
        let rows = list.as_array_mut().ok_or("项目索引损坏")?;
        let mut p = store.project()?;
        p["archivedAt"] = Value::Null;
        p["lifecycleVersion"] = json!(0);
        if rows.iter().any(|v| v["id"] == p["id"]) {
            return Err("此项目已经导入；为保持任务身份不能重复注册".into());
        }
        rows.push(p);
        atomic_json(&self.home.join("projects.json"), &list)
    }
    pub fn project_list(&self) -> Result<Vec<Value>> {
        let mut rows = self.registry()?.as_array().ok_or("项目索引损坏")?.clone();
        for p in &mut rows {
            p["lifecycleVersion"] = json!(lifecycle_version(p)?);
            if p.get("archivedAt").is_none() {
                p["archivedAt"] = Value::Null;
            }
            // A missing/archived registry entry must never initialize a fresh database.
            if project_archived(p) {
                continue;
            }
            if let Ok(store) = registered_store(p) {
                let c = store.conn()?;
                let count = |table: &str| {
                    c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| {
                        r.get::<_, i64>(0)
                    })
                    .unwrap_or(0)
                };
                p["counts"] = json!({"assets":count("assets"),"media":count("media"),"units":count("units"),"jobs":count("jobs")});
                p["sourceVersion"] = store.source()?["version"].clone();
            }
        }
        Ok(rows)
    }
    pub fn store(&self, key: &str) -> Result<Store> {
        let p = self
            .registry()?
            .as_array()
            .ok_or("项目索引损坏")?
            .iter()
            .find(|p| s(p, "id") == key)
            .cloned()
            .ok_or("项目不存在")?;
        if project_archived(&p) {
            return Err("项目已归档，请先恢复项目".into());
        }
        registered_store(&p)
    }
    fn project_lifecycle(&self, request: &Value) -> Result<Value> {
        let key = s(request, "projectId");
        let expected = request["expectedVersion"].as_u64().ok_or("缺少项目当前版本，请刷新后再操作")?;
        let _registry = self.registry_mutex.lock().map_err(|e| e.to_string())?;
        let mut registry = self.registry()?;
        let rows = registry.as_array_mut().ok_or("项目索引损坏")?;
        let index = rows.iter().position(|p| s(p, "id") == key).ok_or("项目不存在")?;
        let current = &rows[index];
        let version = lifecycle_version(current)?;
        if version != expected {
            return Err("项目状态已变化，请刷新后再操作".into());
        }
        let prefix = format!("project:{key}:");
        if self.active.lock().map_err(|e| e.to_string())?.iter().any(|k| k.starts_with(&prefix)) {
            return Err("本项目仍有本地任务正在执行，请等待任务结束后再归档或删除".into());
        }
        let action = s(request, "action");
        let archived = project_archived(current);
        if action == "projects.delete" && !archived {
            return Err("请先归档项目，再删除项目记录".into());
        }
        if action == "projects.archive" && archived {
            return Err("项目已经归档，请刷新列表".into());
        }
        if action == "projects.restore" && !archived {
            return Err("项目当前未归档，请刷新列表".into());
        }
        if action == "projects.restore" {
            let store = registered_store(current)?;
            store.recover_interrupted()?;
            store.ensure_current_images()?;
        }
        let next = version.checked_add(1).ok_or("项目版本已超出范围")?;
        let mut result = current.clone();
        if action == "projects.archive" {
            if let Some(summary) = self.project_list()?.into_iter().find(|p| s(p, "id") == key) {
                result["counts"] = summary["counts"].clone();
                result["sourceVersion"] = summary["sourceVersion"].clone();
            }
        }
        result["projectId"] = json!(key);
        result["lifecycleVersion"] = json!(next);
        result["filesRetained"] = json!(true);
        if action == "projects.delete" {
            result["deleted"] = json!(true);
            rows.remove(index);
        } else {
            result["archivedAt"] = if action == "projects.archive" { json!(now()) } else { Value::Null };
            result["updatedAt"] = json!(now());
            let mut saved = result.clone();
            saved.as_object_mut().ok_or("项目索引损坏")?.remove("projectId");
            saved.as_object_mut().ok_or("项目索引损坏")?.remove("filesRetained");
            rows[index] = saved;
        }
        atomic_json(&self.home.join("projects.json"), &registry)?;
        Ok(result)
    }
    pub fn config(&self, store: &Store, provider: &str) -> Result<(ProviderConfig, String)> {
        if provider == "dreamina" && self.live_accounts {
            let config = self.dreamina_config(store)?;
            let account = self.dreamina_sessions.snapshot(&config)?;
            let identity = s(&account, "accountKey");
            return Ok((
                config,
                if account["ready"] == true
                    && account["identityVerified"] == true
                    && !identity.is_empty()
                {
                    identity.to_owned()
                } else {
                    "dreamina:official:unverified".into()
                },
            ));
        }
        let settings = store.settings()?;
        let project = store.project()?;
        let pid = s(&project, "id");
        let env = format!(
            "DIRECTOR_NEW_{}_{}",
            pid.replace('-', "_"),
            provider.to_uppercase()
        );
        if ["bh", "chrome"].contains(&provider) {
            let secret = keyring::Entry::new("director-desktop", &format!("{pid}:{provider}"))
                .ok()
                .and_then(|entry| entry.get_password().ok());
            if let Some(secret) = secret {
                std::env::set_var(&env, secret);
            } else {
                std::env::remove_var(&env);
            }
        }
        let cli = if s(&settings, "dreaminaPath").is_empty() {
            bundled_dreamina().map(|p| json!(p)).unwrap_or(Value::Null)
        } else {
            settings["dreaminaPath"].clone()
        };
        let cfg:ProviderConfig=serde_json::from_value(json!({"kind":provider,"endpoint":match provider{"bh"=>settings.get("bhEndpoint"),"chrome"=>settings.get("chromeEndpoint"),_=>None},"credentialEnv":if provider=="bh"{Some(env.clone())}else{None},"bridgeTokenEnv":if provider=="chrome"{Some(env.clone())}else{None},"cliPath":cli,"timeoutSeconds":settings.get("providerTimeoutSeconds").cloned().unwrap_or(json!(120)),"adaptedModels":settings.get("adaptedModels").cloned().unwrap_or(json!([]))})).map_err(|e|e.to_string())?;
        let account_key = format!("{provider}AccountId");
        let explicit = s(&settings, &account_key);
        let endpoint = cfg.endpoint.as_deref().unwrap_or("official-cli");
        let account = if !explicit.is_empty() {
            format!("{provider}:{endpoint}:account:{explicit}")
        } else if let Ok(secret) = std::env::var(&env) {
            use sha2::{Digest, Sha256};
            format!(
                "{provider}:{endpoint}:credential:{:x}",
                Sha256::digest(secret.as_bytes())
            )
        } else {
            format!("{provider}:{endpoint}:unidentified")
        };
        Ok((cfg, account))
    }
    fn dreamina_config(&self, store: &Store) -> Result<ProviderConfig> {
        let settings = store.settings()?;
        let cli = if s(&settings, "dreaminaPath").is_empty() {
            bundled_dreamina().map(|p| json!(p)).unwrap_or(Value::Null)
        } else {
            settings["dreaminaPath"].clone()
        };
        serde_json::from_value(json!({"kind":"dreamina","cliPath":cli,"timeoutSeconds":settings.get("providerTimeoutSeconds").cloned().unwrap_or(json!(120))})).map_err(|e| e.to_string())
    }
    fn require_account(&self, store: &Store, provider: &str) -> Result<()> {
        if provider == "dreamina" && self.live_accounts {
            let account = self
                .dreamina_sessions
                .snapshot(&self.dreamina_config(store)?)?;
            if account["ready"] != true
                || account["identityVerified"] != true
                || s(&account, "accountKey").is_empty()
            {
                return Err("请在渠道设置中连接即梦官方 CLI，或刷新现有登录状态。".into());
            }
            return Ok(());
        }
        require_account(store, provider)
    }
    fn checked_account(&self, config: &ProviderConfig, fallback: &str) -> Result<String> {
        if self.live_accounts && config.kind == "dreamina" {
            self.dreamina_sessions.fresh_identity(config)
        } else {
            Ok(fallback.to_owned())
        }
    }
    fn pause_for_auth(store: &Store, key: &str, message: &str) -> Result<()> {
        let job = store.job(key)?;
        // Authentication failure must never release an uncertain submit for regeneration.
        let state = if s(&job, "status") == "submission_unknown" {
            "submission_unknown"
        } else {
            "auth_required"
        };
        store.update_job(key, state, &json!({"error":message}))
    }
    /// Authentication recovery only re-enables queries for the original persisted IDs.
    /// A pre-submission failure requires a new explicit generation operation.
    pub fn resume_authenticated_dreamina(&self, store: &Store, account: &Value) -> Result<()> {
        let _lifecycle = self.lifecycle_mutex.lock().map_err(|e| e.to_string())?;
        let pid = s(&store.project()?, "id").to_owned();
        if self.registry()?.as_array().ok_or("项目索引损坏")?.iter().any(|p| s(p, "id") == pid && project_archived(p)) {
            return Ok(());
        }
        self.resume_authenticated_dreamina_locked(store, account)
    }
    fn resume_authenticated_dreamina_locked(&self, store: &Store, account: &Value) -> Result<()> {
        if account["ready"] != true
            || account["identityVerified"] != true
            || s(account, "accountKey").is_empty()
        {
            return Ok(());
        }
        let identity = s(account, "accountKey");
        let mut conn = store.conn()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let resumed = tx.execute("INSERT INTO events(job_id,type,data,created_at) SELECT id,'authentication_recovered','{\"queryOnly\":true,\"state\":\"submitted\"}',?1 FROM jobs WHERE provider='dreamina' AND state='auth_required' AND account_id=?2 AND task_id IS NOT NULL AND task_id<>''",rusqlite::params![now(),identity]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE jobs SET state='submitted',error=NULL,next_attempt_at=0,updated_at=?1 WHERE provider='dreamina' AND state='auth_required' AND account_id=?2 AND task_id IS NOT NULL AND task_id<>''",rusqlite::params![now(),identity]).map_err(|e|e.to_string())?;
        let expired = tx.execute("UPDATE jobs SET state='stale',error='登录已恢复；此项没有生成任务回执，请明确重新发起生成',updated_at=?1 WHERE provider='dreamina' AND state='auth_required' AND account_id=?2 AND (task_id IS NULL OR task_id='')",rusqlite::params![now(),identity]).map_err(|e|e.to_string())?;
        if resumed + expired > 0 {
            tx.execute("INSERT INTO metadata VALUES('changed_at',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[now()]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn workspace(&self, store: &Store, episode: Option<&str>) -> Result<Value> {
        let mut assets = store.values("assets")?;
        let mut deleted_assets = store.deleted_assets()?;
        let media = store.values("media")?;
        let mut units = store.unit_summaries()?;
        let jobs = store.job_summaries()?;
        let c = store.conn()?;
        let mut aq = c
            .prepare("SELECT asset_id,variant_id,media_id FROM adoptions")
            .map_err(|e| e.to_string())?;
        let adopted = aq
            .query_map([], |r| {
                Ok((
                    (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<HashMap<_, _>, _>>()
            .map_err(|e| e.to_string())?;
        let mut mq = c
            .prepare("SELECT asset_id,variant_id,media_id FROM media_assets ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let mut candidates: HashMap<(String, String), Vec<String>> = HashMap::new();
        for row in mq
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
        {
            let (a, v, m) = row.map_err(|e| e.to_string())?;
            candidates.entry((a, v)).or_default().push(m);
        }
        let mut vq=c.prepare("SELECT a.unit_id,a.media_id,COALESCE((SELECT json_extract(value,'$.unitVersion') FROM metadata WHERE key='video_adoption:'||a.unit_id AND json_extract(value,'$.mediaId')=a.media_id),(SELECT json_extract(j.snapshot,'$.unitVersion') FROM jobs j JOIN job_media jm ON jm.job_id=j.id WHERE jm.media_id=a.media_id AND j.entity_id=a.unit_id AND j.kind='video' AND j.created_at<=a.created_at ORDER BY j.created_at DESC LIMIT 1)) FROM video_adoptions a").map_err(|e|e.to_string())?;
        let video_adoptions = vq
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?),
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<HashMap<_, _>, _>>()
            .map_err(|e| e.to_string())?;
        for a in assets.iter_mut().chain(deleted_assets.iter_mut()) {
            let key = (s(a, "id").to_string(), s(a, "variantId").to_string());
            a["adoptedMediaId"] = json!(adopted.get(&key));
            a["candidates"] = json!(candidates.get(&key).cloned().unwrap_or_default());
        }
        if let Some(ep) = episode {
            units.retain(|u| s(u, "episodeId") == ep)
        }
        for u in &mut units {
            if let Some(j) = jobs
                .iter()
                .find(|j| s(j, "entityId") == s(u, "id") && s(j, "kind") == "video")
            {
                u["status"] = j["status"].clone();
                u["problems"] = j["snapshot"]["problems"].clone();
                if s(j, "status") == "ready" {
                    u["preparedPackage"] = json!({"provider":j["provider"],"model":j["snapshot"]["model"],"unitVersion":j["snapshot"]["unitVersion"],"references":j["snapshot"]["references"],"problems":j["snapshot"]["problems"],"estimatedCost":j["prepared"]["estimatedCost"],"jobId":j["id"],"ratio":j["snapshot"]["ratio"],"resolution":j["snapshot"]["resolution"],"duration":j["snapshot"]["duration"],"prompt":j["snapshot"]["prompt"]});
                }
                u["resultMediaIds"] = j["resultMediaIds"].clone();
            }
            if let Some((mid, version)) = video_adoptions.get(s(u, "id")) {
                u["adoptedMediaId"] = json!(mid);
                u["adoptedVideoVersion"] = json!(version);
            }
            if let Some(obj) = u.as_object_mut() {
                for key in [
                    "shots",
                    "plan",
                    "emotionPlan",
                    "performance",
                    "ruleSnapshots",
                ] {
                    obj.remove(key);
                }
            }
        }
        let mut summaries = jobs.clone();
        for j in &mut summaries {
            let snap = j["snapshot"].clone();
            let prepared = j["prepared"].clone();
            j["snapshot"] = json!({"model":snap["model"],"unitVersion":snap["unitVersion"],"problems":snap["problems"]});
            j["prepared"] = json!({"estimatedCost":prepared["estimatedCost"]});
            if let Some(obj) = j.as_object_mut() {
                obj.remove("receipt");
            }
        }
        let mut providers = Vec::new();
        let mut q = c
            .prepare("SELECT data FROM catalogs")
            .map_err(|e| e.to_string())?;
        for v in q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
        {
            providers.push(crate::store::parse(v.map_err(|e| e.to_string())?)?);
        }
        let source = store.source()?;
        let mut diagnostics = source.get("diagnostics").cloned().unwrap_or(json!([]));
        let last_import: Option<String> = store
            .conn()?
            .query_row(
                "SELECT value FROM metadata WHERE key='last_import_report'",
                [],
                |r| r.get(0),
            )
            .ok();
        let report = last_import
            .and_then(|v| serde_json::from_str::<Value>(&v).ok())
            .unwrap_or(Value::Null);
        if let Some(items) = report["diagnostics"].as_array() {
            if let Some(all) = diagnostics.as_array_mut() {
                all.extend(items.iter().cloned());
            }
        }
        let mut dq=c.prepare("SELECT type,data,created_at FROM events WHERE type IN ('batch_blocked','operation_error','local_error','catalog_refresh_failed') ORDER BY id DESC LIMIT 30").map_err(|e|e.to_string())?;
        let notices = dq
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for notice in notices {
            let (code, data, time) = notice.map_err(|e| e.to_string())?;
            let data: Value = serde_json::from_str(&data).unwrap_or(json!(data));
            let message = if let Some(items) = data.as_array() {
                items
                    .iter()
                    .map(|v| v.as_str().unwrap_or("").to_string())
                    .collect::<Vec<_>>()
                    .join("；")
            } else {
                s(&data, "message").to_string()
            };
            if let Some(items) = diagnostics.as_array_mut() {
                items.push(json!({"code":code,"message":message,"createdAt":time,"details":data}));
            }
        }
        let rules: Vec<_> = pipeline::rule_snapshots()
            .into_iter()
            .map(|r| json!({"id":r.id,"version":r.version,"sha256":r.sha256}))
            .collect();
        Ok(
            json!({"project":store.project()?,"source":source,"foundation":store.foundation()?,"assets":assets,"deletedAssets":deleted_assets,"media":media,"units":units,"jobs":summaries,"workflowProgress":store.workflow_progress()?,"settings":store.settings()?,"providers":providers,"dreaminaAccount":self.dreamina_sessions.snapshot(&self.dreamina_config(store)?)?,"rules":rules,"diagnostics":diagnostics,"lastImportReport":report}),
        )
    }
    pub fn dispatch(self: &Arc<Self>, request: Value) -> Result<Value> {
        let action = s(&request, "action");
        // File pickers and library reads must not hold a project lifecycle reservation.
        match action {
            "projects.list" => return Ok(json!(self.project_list()?)),
            "files.choose" => return choose_files(&request),
            "legacy.inspect" => return crate::importer::inspect_legacy(Path::new(s(&request, "path"))),
            _ => {}
        }
        let lifecycle = self.lifecycle_mutex.lock().map_err(|e| e.to_string())?;
        match action {
            "projects.archive" | "projects.restore" | "projects.delete" => return self.project_lifecycle(&request),
            "projects.create" => {
                let key = id();
                let root = if s(&request, "rootPath").is_empty() {
                    self.home.join("projects").join(&key)
                } else {
                    PathBuf::from(s(&request, "rootPath")).join(&key)
                };
                let store = Store::open(root)?;
                store.create(s(&request, "title"), &key)?;
                self.register(&store)?;
                return store.project();
            }
            "project.import" => {
                let target = self.home.join("projects").join(id());
                let store = portable::import(Path::new(s(&request, "path")), &target)?;
                self.register(&store)?;
                store.ensure_current_images()?;
                return self.workspace(&store, None);
            }
            _ => {}
        }
        let store = self.store(s(&request, "projectId"))?;
        // The short lock makes validation + reservation atomic with archive/delete. The
        // marker outlives synchronous work, and spawned workers acquire their own marker.
        let _operation = self.acquire_keys(project_worker_keys(&store, vec![])?)?;
        drop(lifecycle);
        match action {
            "workspace.get" => {
                store.ensure_current_images()?;
                return self.workspace(&store, request.get("episodeId").and_then(Value::as_str));
            }
            "units.get" => return store.get("units", s(&request, "unitId")),
            "units.versions.list" => return store.unit_versions(s(&request, "unitId")),
            "units.version.restore" => {
                store.restore_unit_version(
                    s(&request, "unitId"),
                    request["version"].as_i64().ok_or("请选择历史版本")?,
                    request["expectedVersion"]
                        .as_i64()
                        .ok_or("缺少当前版本，请刷新")?,
                )?;
            }
            "production.direction.save" => {
                store.save_production_direction(
                    s(&request, "direction"),
                    request["expectedSourceVersion"]
                        .as_i64()
                        .ok_or("请先导入原文")?,
                    request["expectedFoundationVersion"].as_i64(),
                )?;
            }
            "workflows.resume" | "storyboard.decision.resolve" => {
                self.resume_production(store.clone(), &request)?;
            }
            "units.regenerate" => {
                let unit = store.get("units", s(&request, "unitId"))?;
                if request.get("expectedVersion").is_some()
                    && request["expectedVersion"] != unit["version"]
                {
                    return Err("单元已更新，请刷新后重做".into());
                }
                if s(&request, "instruction").trim().is_empty() {
                    return Err("请填写此单元的修改要求".into());
                }
                let run = json!({"action":"storyboard.run","projectId":request["projectId"],"episodeIds":[unit["episodeId"]],"unitIds":[unit["id"]],"revisionInstruction":request["instruction"]});
                self.spawn_production(store.clone(), run)?;
            }
            "assets.get" => return store.get("assets", s(&request, "assetId")),
            "assets.usage" => return store.asset_usage(s(&request, "assetId")),
            "jobs.detail" => {
                let mut j = store.job(s(&request, "jobId"))?;
                let c = store.conn()?;
                let mut q=c.prepare("SELECT type,data,created_at FROM events WHERE job_id=?1 ORDER BY id DESC LIMIT 100").map_err(|e|e.to_string())?;
                let events=q.query_map([s(&request,"jobId")],|r|Ok(json!({"type":r.get::<_,String>(0)?,"data":r.get::<_,String>(1)?,"createdAt":r.get::<_,String>(2)?}))).map_err(|e|e.to_string())?.collect::<std::result::Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
                j["events"] = json!(events);
                return Ok(j);
            }
            "source.import" => {
                let text = if let Some(text) = request["text"].as_str() {
                    text.to_owned()
                } else {
                    crate::importer::read_source(Path::new(s(&request, "path")))?
                };
                store.save_source(
                    serde_json::to_value(pipeline::prepare_source(&text)?)
                        .map_err(|e| e.to_string())?,
                )?;
            }
            "source.resolve" | "source.reparse" => {
                let expected = request["expectedSourceVersion"]
                    .as_i64()
                    .ok_or("缺少当前原文版本，请刷新后再确认")?;
                let raw = store.source()?;
                if raw["version"].as_i64() != Some(expected) {
                    return Err("原文范围已更新，请刷新后再确认".into());
                }
                let source = serde_json::from_value(raw).map_err(|e| e.to_string())?;
                let resolved = if action == "source.reparse" {
                    pipeline::reparse_source(&source)?
                } else {
                    let decisions: Vec<pipeline::BoundaryDecision> =
                        serde_json::from_value(request["decisions"].clone())
                            .map_err(|e| e.to_string())?;
                    pipeline::apply_boundary_decisions(&source, &decisions)?
                };
                store.save_source_if_current(
                    serde_json::to_value(resolved).map_err(|e| e.to_string())?,
                    expected,
                )?;
            }
            "legacy.import" => {
                let report = crate::importer::import_legacy(
                    &store,
                    Path::new(s(&request, "path")),
                    &request,
                )?;
                store.event("", "legacy_import", &report)?;
                store.conn()?.execute("INSERT INTO metadata VALUES('last_import_report',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[report.to_string()]).map_err(|e|e.to_string())?;
            }
            "assets.save" => {
                let original=store.get("assets", s(&request["asset"], "id")).unwrap_or(json!({}));
                let mut asset=merge(original.clone(), &request["asset"]);
                if request["asset"].get("prompt").is_some() && original["prompt"]!=asset["prompt"] {
                    asset["promptOrigin"]=json!("MANUAL");
                }
                store.save_asset_user(asset)?;
            }
            "assets.delete" | "assets.restore" => {
                store.set_asset_deleted(
                    s(&request, "assetId"),
                    request["expectedVersion"]
                        .as_i64()
                        .ok_or("请刷新资产后再操作")?,
                    action == "assets.delete",
                )?;
            }
            "units.save" => {
                let original = store
                    .get("units", s(&request["unit"], "id"))
                    .unwrap_or(json!({}));
                let value = store.save_unit(merge(original.clone(), &request["unit"]))?;
                if original["exitState"] != value["exitState"]
                    || original["prompt"] != value["prompt"]
                {
                    store.invalidate_unit_dependents(s(&value, "id"))?;
                }
            }
            "media.import" => {
                if let Some(paths) = request["paths"].as_array() {
                    let mut imported = Vec::new();
                    let mut failures = Vec::new();
                    for path in paths {
                        match import_user_media(
                            &store,
                            &request,
                            Path::new(path.as_str().unwrap_or("")),
                        ) {
                            Ok(media) => imported.push(media["id"].clone()),
                            Err(message) => failures.push(json!({"path":path,"message":message})),
                        }
                    }
                    let mut workspace = self.workspace(&store, None)?;
                    workspace["mediaImportReport"] = json!({"importedCount":imported.len(),"mediaIds":imported,"failures":failures,"order":"input","currentImage":"lastSuccessfulImport"});
                    return Ok(workspace);
                }
                import_user_media(&store, &request, Path::new(s(&request, "path")))?;
            }
            "images.ensure_current" => {
                let report = store.ensure_current_images()?;
                let mut workspace = self.workspace(&store, None)?;
                workspace["currentImageInitialization"] = report;
                return Ok(workspace);
            }
            "media.adopt" => store.adopt(
                s(&request, "assetId"),
                s(&request, "variantId"),
                s(&request, "mediaId"),
            )?,
            "media.adopt_batch" => store.adopt_batch(
                request["selections"]
                    .as_array()
                    .ok_or("请选择要采用的候选")?,
            )?,
            "videos.adopt" => adopt_video(&store, s(&request, "unitId"), s(&request, "mediaId"))?,
            "settings.save" => {
                let data = &request["settings"];
                let old = store.settings()?;
                let pid = s(&request, "projectId");
                for (k, provider) in [
                    ("bhToken", "bh"),
                    ("chromeToken", "chrome"),
                    ("textApiKey", "text"),
                ] {
                    if let Some(secret) = data[k].as_str().filter(|s| !s.is_empty()) {
                        keyring::Entry::new("director-desktop", &format!("{pid}:{provider}"))
                            .map_err(|e| e.to_string())?
                            .set_password(secret)
                            .map_err(|e| format!("无法安全保存凭据: {e}"))?;
                    }
                }
                store.save_settings(data)?;
                if data.get("dreaminaPath").is_some() && data["dreaminaPath"] != old["dreaminaPath"]
                {
                    self.dreamina_sessions
                        .forget(&self.dreamina_config(&store)?)?;
                }
                if [
                    "ratio",
                    "videoResolution",
                    "imageResolution",
                    "videoProvider",
                    "videoModel",
                    "imageProvider",
                    "imageModel",
                    "bhEndpoint",
                    "dreaminaPath",
                ]
                .iter()
                .any(|k| data.get(*k).is_some() && data[*k] != old[*k])
                {
                    store.invalidate_unsubmitted("生成设置已变化，请重新准备")?;
                }
            }
            "textCli.status"
            | "textCli.login"
            | "textCli.loginStatus"
            | "textCli.cancelLogin"
            | "textCli.openLogin" => {
                if !self.live_accounts {
                    if action == "textCli.status" {
                        return Ok(
                            json!({"available":false,"ready":false,"loggedIn":false,"models":[],"limits":[],"warnings":["离线启动验收不读取宿主 CLI 账户"],"login":{"state":"idle"},"generationRequestsSent":0,"diagnostic":true}),
                        );
                    }
                    return Err("离线验收模式不启动账户登录".into());
                }
                let mut settings = store.settings()?;
                if action == "textCli.status" {
                    if let Some(path) = request["settings"]["codexPath"].as_str() {
                        settings["codexPath"] = json!(path.trim());
                    }
                }
                let runtime = crate::text_cli::control_runtime()?;
                return match action {
                    "textCli.status" => {
                        Ok(runtime.block_on(crate::text_cli::status(&settings, true)))
                    }
                    "textCli.login" => runtime.block_on(crate::text_cli::start_login(&settings)),
                    "textCli.loginStatus" => Ok(crate::text_cli::login_status()),
                    "textCli.cancelLogin" => Ok(crate::text_cli::cancel_login()),
                    _ => runtime.block_on(crate::text_cli::open_login_url()),
                };
            }
            "dreamina.status" | "dreamina.login" | "dreamina.logout" => {
                let _guard = self.acquire_keys(vec!["channel:dreamina".into()])?;
                let config = self.dreamina_config(&store)?;
                let account = match action {
                    "dreamina.login" => {
                        let account = self.dreamina_sessions.begin(&config)?;
                        if s(&account, "status") == "authorizing" {
                            if let Err(error) =
                                open_authorization(s(&account["authorization"], "verificationUrl"))
                            {
                                store.event("", "operation_error", &json!({"message":error}))?;
                            }
                        }
                        account
                    }
                    "dreamina.logout" => self.dreamina_sessions.logout(&config)?,
                    _ => self.dreamina_sessions.poll_or_refresh(&config)?,
                };
                self.resume_authenticated_dreamina_locked(&store, &account)?;
            }
            "dreamina.open_authorization" => {
                let account = self
                    .dreamina_sessions
                    .snapshot(&self.dreamina_config(&store)?)?;
                if s(&account, "status") != "authorizing" {
                    return Err("没有正在进行的即梦授权，请先连接。".into());
                }
                open_authorization(s(&account["authorization"], "verificationUrl"))?;
            }
            "providers.refresh" => {
                let provider = s(&request, "provider");
                let _guard = self.acquire_keys(vec![format!("channel:{provider}")])?;
                let (c, _) = self.config(&store, provider)?;
                if provider == "dreamina" && self.live_accounts {
                    let account = self.dreamina_sessions.poll_or_refresh(&c)?;
                    self.resume_authenticated_dreamina_locked(&store, &account)?;
                }
                let (c, account) = self.config(&store, provider)?;
                let fingerprint = capability_fingerprint(&c, &account);
                let cap = match self.channels.capabilities(&c) {
                    Ok(cap) => cap,
                    Err(e) => {
                        if e.auth_required {
                            store
                                .conn()?
                                .execute("DELETE FROM catalogs WHERE provider=?1", [provider])
                                .map_err(|e| e.to_string())?;
                        }
                        return Err(e.message);
                    }
                };
                let (current, current_account) = self.config(&store, provider)?;
                if capability_fingerprint(&current, &current_account) != fingerprint {
                    return Err("渠道或账户配置在核实时发生变化，请重试".into());
                }
                save_capability_cache(&store, &c, &account, &fingerprint, &cap)?;
                return Ok(json!(cap));
            }
            "videos.preflight" => {
                let provider = video_provider(&store, &request)?;
                let _guard = self.acquire_keys(vec![format!("channel:{provider}")])?;
                let verified = self.video_channel(&store, &provider, &request)?;
                let mut workspace = self.workspace(&store, None)?;
                workspace["videoPreflight"] = verified.report;
                return Ok(workspace);
            }
            "videos.prepare" | "videos.submit" => {
                let provider = video_provider(&store, &request)?;
                let _guard = self.acquire_keys(vec![format!("channel:{provider}")])?;
                let report = self.queue_videos(&store, &request, action == "videos.submit")?;
                let mut workspace = self.workspace(&store, None)?;
                workspace["videoQueueReport"] = report;
                return Ok(workspace);
            }
            "images.run" => {
                let report = self.queue_images(&store, &request)?;
                let mut workspace = self.workspace(&store, None)?;
                workspace["imageQueueReport"] = report;
                return Ok(workspace);
            }
            "foundation.run" | "images.design" | "images.produce" | "storyboard.run" => {
                self.spawn_stage(store.clone(), request.clone())?;
            }
            "jobs.close_unknown" => {
                let key = s(&request, "jobId");
                let _guard = self.acquire_keys(vec![format!("job:{key}")])?;
                store.close_unknown_job(
                    key,
                    request["confirmedNotAccepted"].as_bool() == Some(true),
                    s(&request, "reason"),
                )?;
            }
            "jobs.query" | "jobs.download" | "jobs.reconcile" => {
                let key = s(&request, "jobId").to_owned();
                let job = store.job(&key)?;
                let (cfg, account) = self.config(&store, s(&job, "provider"))?;
                let engine = self.clone();
                let st = store.clone();
                let act = action.to_owned();
                let remote = s(&request, "providerTaskId").to_owned();
                let locks = project_worker_keys(&store, vec![
                    format!("job:{key}"),
                    format!("channel:{}", s(&job, "provider")),
                ])?;
                self.spawn_exclusive_keys(locks, move || {
                    let account = match engine.checked_account(&cfg, &account) {
                        Ok(account) => account,
                        Err(message) => {
                            Self::pause_for_auth(&st, &key, &message)?;
                            return Ok(());
                        }
                    };
                    let result = if act == "jobs.reconcile" {
                        if remote.is_empty() {
                            tasks::reconcile(&st, &key, &cfg, &account, engine.channels.as_ref())
                        } else {
                            if s(&job, "status") != "submission_unknown"
                                || s(&job, "accountId") != account
                            {
                                return Err("仅原账户的未知提交可人工关联任务ID".into());
                            }
                            let query = engine
                                .channels
                                .query(&cfg, &remote)
                                .map_err(|e| e.message)?;
                            st.event(
                                &key,
                                "manual_task_identification",
                                &json!({"providerTaskId":remote,"userIdentified":true}),
                            )?;
                            st.update_job(
                                &key,
                                if query.status == "succeeded" {
                                    "succeeded"
                                } else {
                                    "submitted"
                                },
                                &json!({"providerTaskId":remote,"result":query}),
                            )
                        }
                    } else {
                        tasks::resume_job(
                            &st,
                            &key,
                            &cfg,
                            &account,
                            engine.channels.as_ref(),
                            act == "jobs.download",
                        )
                    };
                    if let Err(e) = &result {
                        st.event(&key, "operation_error", &json!({"message":e}))?;
                    }
                    result
                })?;
            }
            "project.export" => return portable::export(&store, Path::new(s(&request, "path"))),
            "backup.create" => return portable::backup(&store, true),
            "backup.restore" => return self.restore_backup(&store, Path::new(s(&request, "path"))),
            _ => return Err(format!("未知操作: {action}")),
        }
        self.workspace(&store, None)
    }
    fn spawn_exclusive<F>(self: &Arc<Self>, key: String, work: F) -> Result<()>
    where
        F: FnOnce() -> Result<()> + Send + 'static,
    {
        let mut keys = vec![key.clone()];
        if let Some(project_id) = key.strip_prefix("pipeline:") {
            keys.push(format!("project:{project_id}:{}", id()));
        }
        self.spawn_exclusive_keys(keys, work)
    }
    fn spawn_exclusive_keys<F>(self: &Arc<Self>, keys: Vec<String>, work: F) -> Result<()>
    where
        F: FnOnce() -> Result<()> + Send + 'static,
    {
        let guard = self.acquire_keys(keys)?;
        std::thread::spawn(move || {
            let _guard = guard;
            let _ = work();
        });
        Ok(())
    }
    fn acquire_keys(self: &Arc<Self>, keys: Vec<String>) -> Result<ActiveGuard> {
        if self.stop.load(Ordering::SeqCst) {
            return Err("客户端正在退出".into());
        }
        let mut active = self.active.lock().map_err(|e| e.to_string())?;
        // Close the race with shutdown between the optimistic check and taking this lock.
        if self.stop.load(Ordering::SeqCst) {
            return Err("客户端正在退出".into());
        }
        if let Some(key) = keys.iter().find(|key| active.contains(*key)) {
            let message = if let Some(provider) = key.strip_prefix("channel:") {
                let name = match provider {
                    "dreamina" => "即梦",
                    "bh" => "BH",
                    "chrome" => "Chrome 图片",
                    _ => provider,
                };
                format!("{name}渠道正在检查或处理已有任务，请稍后再试；这不影响原文和分镜阅读。")
            } else if key.starts_with("pipeline:") {
                "本项目的文字制作流程正在执行，请在任务记录查看进度。".to_owned()
            } else {
                "这项操作正在执行，请稍后刷新记录。".to_owned()
            };
            return Err(message);
        }
        for key in &keys {
            active.insert(key.clone());
        }
        drop(active);
        Ok(ActiveGuard {
            engine: self.clone(),
            keys,
        })
    }
    /// After stopping new work, drain only channel/job workers through their final receipt writes.
    /// Pipeline/text work is deliberately outside this wait. Repeated bounded calls are safe.
    pub fn await_channel_shutdown(&self, timeout_seconds: u64) -> bool {
        let started = std::time::Instant::now();
        let timeout = Duration::from_secs(timeout_seconds.min(60));
        loop {
            match self.active.lock() {
                Ok(active)
                    if !active
                        .iter()
                        .any(|key| key.starts_with("job:") || key.starts_with("channel:")) =>
                {
                    return true
                }
                Err(_) => return false,
                _ => {}
            }
            if started.elapsed() >= timeout {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    /// Drain every owned worker, including final pipeline/text database writes after cancellation.
    pub fn await_worker_shutdown(&self, timeout_seconds: u64) -> bool {
        let started = std::time::Instant::now();
        let timeout = Duration::from_secs(timeout_seconds.min(60));
        loop {
            match self.active.lock() {
                Ok(active) if active.is_empty() => return true,
                Err(_) => return false,
                _ => {}
            }
            if started.elapsed() >= timeout {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    pub fn start(self: &Arc<Self>) {
        let engine = self.clone();
        std::thread::spawn(move || {
            while !engine.stop.load(Ordering::SeqCst) {
                let _ = engine.tick();
                std::thread::sleep(Duration::from_secs(5));
            }
        });
    }
    pub fn tick(self: &Arc<Self>) -> Result<()> {
        for p in self.project_list()? {
            let lifecycle = self.lifecycle_mutex.lock().map_err(|e| e.to_string())?;
            if project_archived(&p) {
                continue;
            }
            // Re-check after taking the same lock used by archive/delete and dispatch.
            let store = match self.store(s(&p, "id")) {
                Ok(store) => store,
                Err(_) => continue,
            };
            let _operation = self.acquire_keys(project_worker_keys(&store, vec![])?)?;
            drop(lifecycle);
            let _ = portable::maybe_backup(&store);
            self.refresh_due_dreamina(&store)?;
            self.refresh_due_catalogs(&store)?;
            self.unblock_image_dependencies(&store)?;
            let mut jobs = store.pending_jobs()?;
            jobs.sort_by(|a, b| {
                a["nextAttemptAt"]
                    .as_i64()
                    .unwrap_or(0)
                    .cmp(&b["nextAttemptAt"].as_i64().unwrap_or(0))
                    .then_with(|| s(a, "updatedAt").cmp(s(b, "updatedAt")))
            });
            let mut served = HashSet::new();
            for j in jobs {
                let state = s(&j, "status");
                let provider = s(&j, "provider");
                if !["video", "image"].contains(&s(&j, "kind")) {
                    continue;
                }
                if ![
                    "queued",
                    "ready",
                    "submitted",
                    "processing",
                    "succeeded",
                    "query_failed",
                    "download_failed",
                ]
                .contains(&state)
                {
                    continue;
                }
                if j["nextAttemptAt"].as_i64().unwrap_or(0) > chrono::Utc::now().timestamp()
                    || served.contains(provider)
                {
                    continue;
                }
                if state == "ready" && j["snapshot"]["autoSubmit"].as_bool() != Some(true) {
                    continue;
                }
                let key = s(&j, "id").to_owned();
                let (cfg, account) = self.config(&store, provider)?;
                let st = store.clone();
                let channels = self.channels.clone();
                let is_gen = ["queued", "ready"].contains(&state);
                let locks = project_worker_keys(&store, vec![format!("channel:{provider}"), format!("job:{key}")])?;
                let engine = self.clone();
                let spawned = self.spawn_exclusive_keys(locks, move || {
                    let account = match engine.checked_account(&cfg, &account) {
                        Ok(account) => account,
                        Err(message) => {
                            Self::pause_for_auth(&st, &key, &message)?;
                            return Ok(());
                        }
                    };
                    let r = if is_gen {
                        tasks::run_generation(&st, &key, &cfg, &account, channels.as_ref())
                    } else {
                        tasks::resume_job(&st, &key, &cfg, &account, channels.as_ref(), true)
                    };
                    if let Err(e) = r {
                        let _ = st.event(&key, "local_error", &json!({"message":e}));
                    }
                    drop(engine);
                    Ok(())
                });
                if spawned.is_ok() {
                    served.insert(provider.to_string());
                }
                // One oldest available operation per channel, other channels remain independent.
            }
        }
        Ok(())
    }
    fn refresh_due_dreamina(self: &Arc<Self>, store: &Store) -> Result<()> {
        if !self.live_accounts {
            return Ok(());
        }
        let config = self.dreamina_config(store)?;
        if !config.cli_path.as_ref().is_some_and(|p| p.is_file()) {
            return Ok(());
        }
        if !self.dreamina_sessions.due(&config)? {
            return Ok(());
        }
        let engine = self.clone();
        let st = store.clone();
        let locks = project_worker_keys(store, vec!["channel:dreamina".into()])?;
        let _ = self.spawn_exclusive_keys(locks, move || {
            let account = engine.dreamina_sessions.poll_or_refresh(&config)?;
            // Shared official CLI identity applies to every local project on this computer.
            for project in engine.project_list()? {
                let _lifecycle = engine.lifecycle_mutex.lock().map_err(|e| e.to_string())?;
                let target = match engine.store(s(&project, "id")) {
                    Ok(target) => target,
                    Err(_) => continue,
                };
                if crate::dreamina_session::config_key(&engine.dreamina_config(&target)?)
                    == crate::dreamina_session::config_key(&config)
                {
                    engine.resume_authenticated_dreamina_locked(&target, &account)?;
                }
            }
            let _ = st;
            Ok(())
        });
        Ok(())
    }
    fn refresh_due_catalogs(self: &Arc<Self>, store: &Store) -> Result<()> {
        let settings = store.settings()?;
        for provider in ["dreamina", "bh", "chrome"] {
            if provider == "dreamina"
                && s(&settings, "dreaminaPath").is_empty()
                && bundled_dreamina().is_none()
            {
                continue;
            }
            if provider == "chrome" && s(&settings, "chromeEndpoint").is_empty() {
                continue;
            }
            let key = format!("catalog_attempt:{provider}");
            let checked: Option<String> = store
                .conn()?
                .query_row("SELECT value FROM metadata WHERE key=?1", [&key], |r| {
                    r.get(0)
                })
                .ok();
            if checked
                .as_deref()
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|t| chrono::Utc::now().signed_duration_since(t).num_seconds() < 900)
                .unwrap_or(false)
            {
                continue;
            }
            let (cfg, account) = self.config(store, provider)?;
            if provider == "bh"
                && cfg
                    .credential_env
                    .as_deref()
                    .and_then(|e| std::env::var(e).ok())
                    .is_none()
            {
                continue;
            }
            let channels = self.channels.clone();
            let engine = self.clone();
            let st = store.clone();
            let provider = provider.to_owned();
            let locks = project_worker_keys(store, vec![format!("catalog:{provider}"), format!("channel:{provider}")])?;
            let _ = self.spawn_exclusive_keys(locks, move || {
                // A busy startup account check is a deferred attempt, not a failed refresh.
                // Only an acquired worker may start the 15-minute refresh interval.
                st.conn()?.execute("INSERT INTO metadata VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",rusqlite::params![key,now()]).map_err(|e|e.to_string())?;
                let fingerprint = capability_fingerprint(&cfg, &account);
                let (current, current_account) = engine.config(&st, &provider)?;
                if capability_fingerprint(&current, &current_account) != fingerprint {
                    return Err("渠道或账户配置在核实时发生变化，请重试".into());
                }
                match channels.capabilities(&cfg) {
                    Ok(cap) => {
                        let (current, current_account) = engine.config(&st, &provider)?;
                        if capability_fingerprint(&current, &current_account) != fingerprint {
                            return Err("渠道或账户配置在核实时发生变化，请重试".into());
                        }
                        save_capability_cache(&st, &cfg, &account, &fingerprint, &cap)?;
                    }
                    Err(e) => {
                        st.event(
                            "",
                            "catalog_refresh_failed",
                            &json!({"provider":provider,"message":e.message}),
                        )?;
                        if e.auth_required {
                            st.conn()?
                                .execute("DELETE FROM catalogs WHERE provider=?1", [provider])
                                .map_err(|e| e.to_string())?;
                        }
                    }
                }
                Ok(())
            });
        }
        Ok(())
    }
    fn unblock_image_dependencies(&self, store: &Store) -> Result<()> {
        let assets = store.values("assets")?;
        for summary in store
            .pending_jobs()?
            .iter()
            .filter(|j| s(j, "status") == "waiting_dependency")
        {
            let full_job = store.job(s(summary, "id"))?;
            let j = &full_job;
            let a = match store.active_asset(s(j, "entityId")) {
                Ok(asset) => asset,
                Err(error) => {
                    store.update_job(s(j, "id"), "stale", &json!({"error":error}))?;
                    continue;
                }
            };
            if a["version"] != j["snapshot"]["assetVersion"] {
                store.update_job(s(j, "id"), "stale", &json!({"error":"派生设计已变化"}))?;
                continue;
            }
            match image_references(store, &assets, &a) {
                Ok(Some(refs)) => {
                    let mut snapshot = j["snapshot"].clone();
                    snapshot["references"] = json!(refs);
                    store.conn()?.execute("UPDATE jobs SET snapshot=?1 WHERE id=?2 AND state='waiting_dependency'",rusqlite::params![snapshot.to_string(),s(j,"id")]).map_err(|e|e.to_string())?;
                    store.claim_job(s(j, "id"), "waiting_dependency", "queued")?;
                }
                Ok(None) => {}
                Err(e) => {
                    store.update_job(s(j, "id"), "blocked", &json!({"error":e}))?;
                }
            }
        }
        Ok(())
    }
    fn video_channel(
        &self,
        store: &Store,
        provider: &str,
        request: &Value,
    ) -> Result<VideoChannel> {
        if self.live_accounts && !["dreamina", "bh"].contains(&provider) {
            return Err("所选渠道尚未适配视频生成".into());
        }
        let (config, mut account) = self.config(store, provider)?;
        if provider == "dreamina" && self.live_accounts {
            let mut status = self.dreamina_sessions.snapshot(&config)?;
            if self.dreamina_sessions.due(&config)? || status["ready"] != true {
                status = self.dreamina_sessions.poll_or_refresh(&config)?;
                self.resume_authenticated_dreamina(store, &status)?;
            }
            if status["ready"] != true
                || status["identityVerified"] != true
                || s(&status, "accountKey").is_empty()
            {
                return Err(if s(&status, "message").is_empty() {
                    "请先连接即梦官方账户".into()
                } else {
                    s(&status, "message").into()
                });
            }
            account = s(&status, "accountKey").to_owned();
        } else {
            self.require_account(store, provider)?;
            if self.live_accounts
                && provider == "bh"
                && config
                    .credential_env
                    .as_deref()
                    .and_then(|name| std::env::var(name).ok())
                    .is_none_or(|value| value.trim().is_empty())
            {
                return Err("请先在渠道设置中配置 BH 凭据".into());
            }
        }
        if request
            .get("expectedAccountKey")
            .and_then(Value::as_str)
            .filter(|key| !key.is_empty())
            .is_some_and(|expected| expected != account)
        {
            return Err("账户身份已变化，请核对当前账户后重新准备".into());
        }
        let fingerprint = capability_fingerprint(&config, &account);
        let cached: Option<(String, String)> = store
            .conn()?
            .query_row(
                "SELECT data,fetched_at FROM catalogs WHERE provider=?1",
                [provider],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        let marker: Option<String> = store
            .conn()?
            .query_row(
                "SELECT value FROM metadata WHERE key=?1",
                [format!("capability_binding:{provider}")],
                |row| row.get(0),
            )
            .ok();
        let marker = marker.and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
        let usable = cached.and_then(|(raw, at)| {
            let cap: Capabilities = serde_json::from_str(&raw).ok()?;
            let bound = marker.as_ref().is_some_and(|m| {
                s(m, "fingerprint") == fingerprint && s(m, "version") == cap.version
            });
            (bound
                && timestamp_fresh(&at, 900)
                && timestamp_fresh(&cap.checked_at, 900)
                && cap.provider == provider
                && !cap.version.is_empty())
            .then_some(cap)
        });
        let (capabilities, source) = if let Some(cap) = usable {
            (cap, "cache")
        } else {
            let cap = match self.channels.capabilities(&config) {
                Ok(cap) => cap,
                Err(error) => {
                    store.event(
                        "",
                        "video_preflight_failed",
                        &json!({"provider":provider,"message":error.message}),
                    )?;
                    if error.auth_required {
                        store
                            .conn()?
                            .execute("DELETE FROM catalogs WHERE provider=?1", [provider])
                            .map_err(|e| e.to_string())?;
                    }
                    return Err(error.message);
                }
            };
            if cap.provider != provider
                || cap.version.is_empty()
                || !timestamp_fresh(&cap.checked_at, 900)
            {
                return Err("渠道没有返回当前、完整且身份一致的能力目录".into());
            }
            let (current, current_account) = self.config(store, provider)?;
            if capability_fingerprint(&current, &current_account) != fingerprint {
                return Err("渠道或账户配置在核实时发生变化，请重试准备".into());
            }
            save_capability_cache(store, &config, &account, &fingerprint, &cap)?;
            (cap, "refreshed")
        };
        let report = json!({"provider":provider,"capabilityVersion":capabilities.version,"source":source,"checkedAt":capabilities.checked_at});
        Ok(VideoChannel {
            account,
            fingerprint,
            capabilities,
            report,
        })
    }
    fn queue_videos(&self, store: &Store, r: &Value, submit: bool) -> Result<Value> {
        let ids = r["unitIds"]
            .as_array()
            .filter(|ids| !ids.is_empty())
            .ok_or("请选择分镜单元")?;
        let mut seen = HashSet::new();
        for id in ids {
            let key = id
                .as_str()
                .filter(|id| !id.trim().is_empty())
                .ok_or("无效unitId")?;
            if !seen.insert(key) {
                return Err("分镜单元选择不能重复".into());
            }
        }
        let settings = store.settings()?;
        let provider = video_provider(store, r)?;
        let model = r
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(s(&settings, "videoModel"))
            .trim();
        if model.is_empty() {
            return Err("请选择视频模型".into());
        }
        let verified = self.video_channel(store, &provider, r)?;
        let capability = verified
            .capabilities
            .models
            .iter()
            .find(|m| m.id == model && m.kind == "video")
            .ok_or("所选模型不是此渠道已核实的视频模型")?;
        if !capability.adapted
            || capability.min_duration.is_none_or(|min| min == 0)
            || capability
                .max_duration
                .is_none_or(|max| Some(max) < capability.min_duration)
            || capability.ratios.is_empty()
            || capability.resolutions.is_empty()
        {
            return Err("所选视频模型的参数能力尚未完整适配".into());
        }
        let ratio = r
            .get("ratio")
            .and_then(Value::as_str)
            .unwrap_or(s(&settings, "ratio"))
            .trim();
        let resolution = r
            .get("resolution")
            .and_then(Value::as_str)
            .unwrap_or_else(|| {
                settings
                    .get("videoResolution")
                    .and_then(Value::as_str)
                    .unwrap_or("720p")
            })
            .trim();
        let ratio = capability
            .ratios
            .iter()
            .find(|v| v.as_str() == ratio)
            .ok_or("所选比例不在此视频模型能力中")?
            .clone();
        let resolution = capability
            .resolutions
            .iter()
            .find(|v| v.eq_ignore_ascii_case(resolution))
            .ok_or("所选尺寸不在此视频模型能力中")?
            .clone();
        let (current, current_account) = self.config(store, &provider)?;
        if capability_fingerprint(&current, &current_account) != verified.fingerprint {
            return Err("渠道或账户配置在核实时发生变化，请重试准备".into());
        }
        let parameters = json!({"videoProvider":provider,"videoModel":model,"ratio":ratio,"videoResolution":resolution});
        if !submit {
            save_video_parameters_and_invalidate(
                store,
                &parameters,
                &verified.capabilities.version,
            )?;
        } else if ["videoProvider", "videoModel", "ratio", "videoResolution"]
            .iter()
            .any(|key| settings[*key] != parameters[*key])
        {
            return Err("当前参数与保存的准备设置不一致，请先重新准备并核对素材".into());
        }
        let jobs = store.job_summaries()?;
        let mut queued = Vec::new();
        let mut blocked = Vec::new();
        let mut reused = 0usize;
        for uid in ids {
            let key = uid.as_str().unwrap();
            let result: Result<Value> = (|| {
                if submit {
                    let summary = jobs
                        .iter()
                        .find(|j| {
                            s(j, "entityId") == key
                                && s(j, "kind") == "video"
                                && s(j, "status") == "ready"
                                && s(j, "provider") == provider
                        })
                        .ok_or("请先准备并查看冻结素材、价格估算")?;
                    let job = store.job(s(summary, "id"))?;
                    if s(&job, "accountId") != verified.account {
                        return Err("准备包属于其他账户，请恢复原账户或重新准备".into());
                    }
                    let snapshot = &job["snapshot"];
                    if s(snapshot, "model") != model
                        || snapshot["ratio"] != ratio
                        || snapshot["resolution"] != resolution
                        || s(snapshot, "capabilityVersion") != verified.capabilities.version
                        || s(&job["prepared"], "capabilityVersion") != verified.capabilities.version
                    {
                        store.conn()?.execute("UPDATE jobs SET state='stale',error='冻结参数或能力版本已变化，请重新准备素材包',next_attempt_at=0,updated_at=?1 WHERE id=?2 AND state='ready' AND (task_id IS NULL OR task_id='') AND (receipt IS NULL OR receipt IN ('','null','{}'))",rusqlite::params![now(),s(&job,"id")]).map_err(|e|e.to_string())?;
                        return Err("冻结参数或能力版本已变化，请重新准备素材包".into());
                    }
                    let prepared: crate::providers::PreparedRequest =
                        serde_json::from_value(job["prepared"].clone())
                            .map_err(|_| "冻结的渠道准备回执不完整")?;
                    let request = tasks::generation_request(snapshot)?;
                    if serde_json::to_value(&prepared.request).map_err(|e| e.to_string())?
                        != serde_json::to_value(&request).map_err(|e| e.to_string())?
                    {
                        return Err("准备回执与冻结素材包不一致，请重新准备".into());
                    }
                    if snapshot["problems"]
                        .as_array()
                        .is_none_or(|p| !p.is_empty())
                    {
                        return Err("冻结素材包仍有待处理问题".into());
                    }
                    binding::validate_snapshot(store, snapshot)?;
                    validate_video_capacity(capability, snapshot)?;
                    let mut snapshot = snapshot.clone();
                    snapshot["autoSubmit"] = json!(true);
                    let changed=store.conn()?.execute("UPDATE jobs SET snapshot=?1 WHERE id=?2 AND state='ready' AND (task_id IS NULL OR task_id='') AND account_id=?3",rusqlite::params![snapshot.to_string(),s(&job,"id"),verified.account]).map_err(|e|e.to_string())?;
                    if changed != 1 {
                        return Err("准备状态已变化，请刷新并重新核对".into());
                    }
                    return Ok(
                        json!({"unitId":key,"jobId":job["id"],"status":"ready","submissionEnabled":true}),
                    );
                }
                if let Some(summary) = jobs.iter().find(|j| {
                    s(j, "entityId") == key
                        && s(j, "kind") == "video"
                        && is_active_generation(s(j, "status"))
                }) {
                    let job = store.job(s(summary, "id"))?;
                    if s(&job, "status") == "ready"
                        && s(&job, "accountId") == verified.account
                        && s(&job["snapshot"], "model") == model
                        && job["snapshot"]["ratio"] == ratio
                        && job["snapshot"]["resolution"] == resolution
                        && s(&job["snapshot"], "capabilityVersion") == verified.capabilities.version
                        && s(&job["prepared"], "capabilityVersion") == verified.capabilities.version
                        && binding::validate_snapshot(store, &job["snapshot"]).is_ok()
                    {
                        reused += 1;
                        return Ok(
                            json!({"unitId":key,"jobId":job["id"],"status":"ready","reused":true}),
                        );
                    }
                    return Err("已有原任务或准备包，请恢复原任务或处理未知提交后再生成".into());
                }
                let unit = store.get("units", key)?;
                let mut snapshot = binding::bind(store, &unit, &provider, model)?;
                snapshot["autoSubmit"] = json!(false);
                snapshot["capabilityVersion"] = json!(verified.capabilities.version);
                snapshot["capabilitySnapshot"] = json!({"version":verified.capabilities.version,"checkedAt":verified.capabilities.checked_at,"model":capability});
                if let Err(message) = validate_video_capacity(capability, &snapshot) {
                    snapshot["problems"]
                        .as_array_mut()
                        .ok_or("素材问题列表无效")?
                        .push(json!({"code":"VIDEO_CAPACITY_REVISION_REQUIRED","message":message}));
                }
                let has_problems = snapshot["problems"]
                    .as_array()
                    .is_none_or(|p| !p.is_empty());
                let job = store.add_job(
                    "video",
                    key,
                    &provider,
                    &verified.account,
                    &snapshot,
                    if has_problems { "blocked" } else { "queued" },
                )?;
                if has_problems {
                    return Err(format!(
                        "素材包有待处理问题，请修订此单元后重新准备（任务 {job}）"
                    ));
                }
                Ok(json!({"unitId":key,"jobId":job,"status":"queued"}))
            })();
            match result {
                Ok(item) => queued.push(item),
                Err(reason) => blocked.push(json!({"unitId":key,"reason":reason})),
            }
        }
        if !blocked.is_empty() {
            store.event("", "batch_blocked", &json!(blocked))?;
        }
        if queued.is_empty() {
            return Err(blocked
                .iter()
                .map(|v| format!("{}: {}", s(v, "unitId"), s(v, "reason")))
                .collect::<Vec<_>>()
                .join("；"));
        }
        let mut preflight = verified.report;
        preflight["model"] = json!(model);
        preflight["ratio"] = json!(ratio);
        preflight["resolution"] = json!(resolution);
        Ok(
            json!({"queuedCount":queued.len()-reused,"reusedCount":reused,"blockedCount":blocked.len(),"queued":queued,"blocked":blocked,"preflight":preflight}),
        )
    }
    fn queue_images(&self, store: &Store, r: &Value) -> Result<Value> {
        let settings = store.settings()?;
        let provider = s(r, "provider");
        let model = s(r, "model");
        if model.is_empty() {
            return Err("请选择图片模型".into());
        }
        self.require_account(store, provider)?;
        let (_, account) = self.config(store, provider)?;
        let selected = r["assetIds"].as_array();
        if selected.is_some_and(|ids| {
            ids.iter()
                .any(|id| id.as_str().is_none_or(|id| id.trim().is_empty()))
        }) {
            return Err("图片选择必须使用有效资产ID".into());
        }
        let assets = store.values("assets")?;
        let approved = settings["trialApproved"].as_bool() == Some(true);
        if !approved && r["trial"].as_bool() != Some(true) {
            return Err("请先生成少量试稿并确认画风，再启动批量生成".into());
        }
        let selected_count = assets
            .iter()
            .filter(|a| independent_image(a))
            .filter(|a| selected.map(|l| l.contains(&a["id"])).unwrap_or(true))
            .count();
        if !approved && selected_count > 3 {
            return Err("未确认画风时试稿最多选择3个资产".into());
        }
        let jobs = store.job_summaries()?;
        let mut errors = Vec::new();
        let mut blocked = Vec::new();
        let mut queued = Vec::new();
        if let Some(selection) = selected {
            for key in selection.iter().filter_map(Value::as_str) {
                if !assets.iter().any(|asset| s(asset, "id") == key) {
                    let reason = "所选资产不存在";
                    blocked.push(json!({"assetId":key,"reason":reason}));
                    errors.push(format!("{key}: {reason}"));
                }
            }
        }
        for a in &assets {
            if selected.map(|l| !l.contains(&a["id"])).unwrap_or(false) {
                continue;
            }
            if !independent_image(a) {
                if a.pointer("/preparation/mode").and_then(Value::as_str)==Some("UNRESOLVED") {
                    blocked.push(json!({"assetId":a["id"],"reason":"素材制作方式尚未明确，请调整资产"}));
                }
                continue;
            }
            if let Some(job) = jobs.iter().find(|j| {
                s(j, "entityId") == s(a, "id")
                    && s(j, "kind") == "image"
                    && is_active_generation(s(j, "status"))
            }) {
                let reason = if s(job, "status") == "submission_unknown" {
                    "原图片任务提交结果未知；请先在任务记录核对回执，或确认渠道未接单后关闭记录"
                } else {
                    "此资产已有图片任务；请先查看或恢复原任务"
                };
                blocked.push(json!({"assetId":a["id"],"jobId":job["id"],"status":job["status"],"reason":reason}));
                errors.push(format!("{}: {reason}", s(a, "id")));
                continue;
            }
            let result: Result<String> = (|| {
                if !independent_image(a) {return Err("此形象沿用来源素材或为纯声音，无需独立出图".into());}
                if s(a, "prompt").is_empty() {
                    return Err("资产缺少图片设计提示词".into());
                }
                let (refs, state) = match image_references(store, &assets, a) {
                    Ok(Some(refs)) => (refs, "queued"),
                    Ok(None) => (vec![], "waiting_dependency"),
                    Err(e) => return Err(e),
                };
                let style=s(&settings,"visualStyle");
                let prompt=compile_image_prompt(s(a,"prompt"),style);
                let snapshot = json!({"requestId":id(),"kind":"image","provider":provider,"model":model,"prompt":prompt,"promptBody":a["prompt"],"visualStyle":style,"assetId":a["id"],"assetVersion":a["version"],"variantId":a["variantId"],"sourceVersion":store.source()?["version"],"sourceVariantId":a["sourceVariantId"],"ratio":settings["ratio"],"resolution":settings.get("imageResolution").cloned().unwrap_or(json!("2K")),"references":refs,"options":{},"autoSubmit":true,"ruleSnapshot":pipeline::rule_snapshot("asset-image-production")?});
                store.add_job("image", s(a, "id"), provider, &account, &snapshot, state)
            })();
            match result {
                Ok(key) => queued.push(json!({"assetId":a["id"],"jobId":key})),
                Err(e) => {
                    errors.push(format!("{}: {e}", s(a, "id")));
                    blocked.push(json!({"assetId":a["id"],"reason":e}));
                }
            }
        }
        if !errors.is_empty() {
            store.event("", "batch_blocked", &json!(errors))?;
        }
        if queued.is_empty() && !blocked.is_empty() {
            return Err(errors.join("；"));
        }
        Ok(
            json!({"queued":queued,"blocked":blocked,"queuedCount":queued.len(),"blockedCount":blocked.len()}),
        )
    }
    fn spawn_production(self: &Arc<Self>, store: Store, request: Value) -> Result<()> {
        let stage = s(&request, "action");
        let mut input = production_input(&store, &request)?;
        let runtime = tokio::runtime::Runtime::new().map_err(|error| error.to_string())?;
        input["settings"] =
            runtime.block_on(crate::text_cli::resolve_settings(&input["settings"]))?;
        if stage == "foundation.run" {
            // Freeze the new transport on new runs only. Resuming an existing
            // workflow keeps its original input and accepted request identities.
            input["foundationModelInputProfile"] = json!(pipeline::foundation_wire::PROFILE);
        }
        let rules = production_rules(stage);
        let guard = crate::workflow::guard_from_input(&input);
        store.ensure_workflow_storage()?;
        {
            let mut c = store.conn()?;
            let tx = c.transaction().map_err(|e| e.to_string())?;
            crate::workflow::verify_guard(&tx, &guard)?;
        }
        let snapshot = json!({"runnerVersion":"desktop-runner/v1","foundationMethod":if stage=="foundation.run" {json!("foundation-delivery/v2")}else{Value::Null},"stage":stage,"sourceVersion":input["source"]["version"],"selection":input["selection"],"planningProfile":input["capabilities"],"input":input,"guard":guard,"rules":rules});
        let job = store.add_job("workflow", stage, "local", "local", &snapshot, "queued")?;
        self.execute_production(store, &job, snapshot)
    }
    fn resume_production(self: &Arc<Self>, store: Store, request: &Value) -> Result<()> {
        let id = s(request, "workflowId");
        let job = store.job(id)?;
        if s(&job, "kind") != "workflow"
            || !matches!(
                s(&job, "status"),
                "failed" | "interrupted" | "waiting_decision" | "partially_blocked" | "blocked"
            )
        {
            return Err("请选择已中断或等待处理的制作流程".into());
        }
        let snapshot = job["snapshot"].clone();
        if snapshot["runnerVersion"] != "desktop-runner/v1" {
            return Err("此记录来自旧执行方式，请保留历史并重新启动阶段".into());
        }
        let rule_migration =
            workflow_resume_rule_audit(&job, &production_rules_for_snapshot(&snapshot)?)?;
        if s(request, "action") == "storyboard.decision.resolve" {
            let waiting = &job["result"]["waitingDecision"];
            let episode = s(waiting, "episodeId");
            if episode.is_empty() {
                return Err("当前流程没有等待选择的方案".into());
            }
            let selected = request["selectedIds"]
                .as_array()
                .ok_or("请选择方案，或明确使用空选择")?;
            let allowed: HashSet<_> = waiting["candidates"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|v| s(v, "id"))
                .collect();
            if selected
                .iter()
                .any(|id| id.as_str().is_none_or(|id| !allowed.contains(id)))
            {
                return Err("选择包含未提供的创作方案".into());
            }
            let mut decisions = job["prepared"]["decisions"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            decisions.insert(episode.to_owned(), json!({"selectedFantasyIds":selected}));
            let mut prepared = job["prepared"].as_object().cloned().unwrap_or_default();
            prepared.insert("decisions".into(), json!(decisions));
            store.update_job(id, s(&job, "status"), &json!({"prepared":prepared}))?;
        }
        if let Some(audit) = rule_migration {
            // A transport correction never rewrites the frozen workflow, source,
            // or accepted checkpoints. Current requests still load current rules.
            store.event(id, "foundation_transport_rule_migration", &audit)?;
        }
        self.execute_production(store, id, snapshot)
    }
    fn execute_production(
        self: &Arc<Self>,
        store: Store,
        run: &str,
        snapshot: Value,
    ) -> Result<()> {
        let run = run.to_owned();
        let failure_store = store.clone();
        let failure_run = run.clone();
        let result=self.spawn_exclusive(format!("pipeline:{}",s(&store.project()?,"id")),move||{
            let runtime=tokio::runtime::Runtime::new().map_err(|e|e.to_string())?;
            let result:Result<Value>=runtime.block_on(async {
                let stage=s(&snapshot,"stage");let mut input=snapshot["input"].clone();
                let record=store.job(&run)?;
                let guard=record["prepared"].get("publicationGuard").unwrap_or(&snapshot["guard"]).clone();
                {let mut c=store.conn()?;let tx=c.transaction().map_err(|e|e.to_string())?;crate::workflow::verify_guard(&tx,&guard)?;}
                input["decisions"]=record["prepared"]["decisions"].clone();
                store.update_job(&run,"running",&json!({}))?;
                let settings=input["settings"].clone();
                let exec=SavedTextExecutor{store:store.clone(),settings:settings.clone(),workflow_id:Some(run.clone())};
                let model=s(&settings,"textModel");let reasoning=s(&settings,"reasoning");
                if stage=="foundation.run" {
                    let source:pipeline::LockedSource=serde_json::from_value(input["source"].clone()).map_err(|e|e.to_string())?;
                    let context=json!({"foundation":input["foundation"],"assets":input["assets"],"selection":input["selection"],"foundationModelInputProfile":input["foundationModelInputProfile"],"settings":{"confirmedDirection":input["foundation"]["productionDirection"]}});
                    let mut proposal=match snapshot["foundationMethod"].as_str() {
                        Some("foundation-delivery/v2")=>pipeline::foundation_delivery::run_foundation_delivery(&source,&context,&exec,model,reasoning).await?,
                        None=>pipeline::run_foundation(&source,&context,&exec,model,reasoning).await?,
                        _=>return Err("制作基础执行方法版本不受支持，已保留原记录".into())
                    };
                    let revised=if snapshot["foundationMethod"]=="foundation-delivery/v2" {
                        pipeline::execute_foundation_scene_edits(&source,&mut proposal)?.map(serde_json::to_value).transpose().map_err(|e|e.to_string())?
                    } else {None};
                    let assets=pipeline::flatten_foundation_assets(&proposal);
                    let output=serde_json::to_value(proposal).map_err(|e|e.to_string())?;
                    store.publish_foundation_with_source(&guard,output,assets,Some(&run),revised)
                }else{
                    let mut output=pipeline::run_storyboard(&input,&exec,model,reasoning).await?;
                    output["planningProfile"]=input["capabilities"].clone();output["selection"]=input["selection"].clone();
                    if output["units"].as_array().is_some_and(|u|!u.is_empty()) {store.publish_storyboard(&guard,&output,&input,Some(&run))?;}
                    Ok(output)
                }
            });
            match result {
                Ok(value)=>{let status=match s(&value,"status"){"waiting_decision"=>"waiting_decision","partially_blocked"=>"partially_blocked",_=>"completed"};store.update_job(&run,status,&json!({"result":value}))},
                Err(error)=>store.update_job(&run,"failed",&json!({"error":error}))
            }
        });
        if let Err(error) = &result {
            failure_store.update_job(&failure_run, "failed", &json!({"error":error}))?;
        }
        result
    }
    fn spawn_stage(self: &Arc<Self>, store: Store, r: Value) -> Result<()> {
        let stage = s(&r, "action").to_owned();
        if stage == "foundation.run" || stage == "storyboard.run" {
            return self.spawn_production(store, r);
        }
        let all_assets = store.values("assets")?;
        let (wanted, _) = image_closure(&all_assets, r["assetIds"].as_array());
        let needs_design = stage == "images.design"
            || all_assets.iter().any(|asset| {
                wanted.iter().any(|id| id == s(asset, "id")) && s(asset, "prompt").is_empty()
            });
        if needs_design {
            image_design_source(&store)?;
        }
        let saved_settings = store.settings()?;
        let execution_settings = if needs_design {
            let runtime = tokio::runtime::Runtime::new().map_err(|error| error.to_string())?;
            runtime.block_on(crate::text_cli::resolve_settings(&saved_settings))?
        } else {
            saved_settings
        };
        let version = store.source()?["version"].clone();
        let snapshot = json!({"stage":stage,"sourceVersion":version,"settings":execution_settings});
        let engine = self.clone();
        let job = store.add_job(
            "workflow",
            &format!("{stage}:{}", s(&r, "episodeId")),
            "local",
            "local",
            &snapshot,
            "queued",
        )?;
        let status_store = store.clone();
        let status_job = job.clone();
        let result=self.spawn_exclusive(format!("pipeline:{}",s(&store.project()?,"id")),move||{
            let runtime=tokio::runtime::Runtime::new().map_err(|e|e.to_string())?;
            let result:Result<Value>=runtime.block_on(async{
                store.update_job(&job,"running",&json!({}))?;let settings=execution_settings;let exec=SavedTextExecutor{store:store.clone(),settings:settings.clone(),workflow_id:None};
                let model=s(&settings,"textModel");let reasoning=s(&settings,"reasoning");
                match stage.as_str(){
                    "images.design"=>{let source=image_design_source(&store)?;let basis=store.foundation()?;let basis_version=basis["version"].as_i64().unwrap_or(0);let input=json!({"source":source,"foundation":basis,"assets":store.values("assets")?,"settings":settings,"selection":{"assetIds":r["assetIds"]}});let output=pipeline::run_asset_design(&input,&exec,model,reasoning).await?;store.publish_asset_design(version.as_i64().ok_or("原文版本缺失")?,basis_version,&output)?;Ok(output)},
                    "images.produce"=>{
                        let all=store.values("assets")?;let (wanted,dependency_errors)=image_closure(&all,r["assetIds"].as_array());let selected:Vec<Value>=all.iter().filter(|a|wanted.iter().any(|id|id==s(a,"id"))&&s(a,"prompt").is_empty()).map(|a|a["id"].clone()).collect();
                        let basis=store.foundation()?;let basis_version=basis["version"].as_i64().unwrap_or(0);
                        let mut output=if !selected.is_empty(){let source=image_design_source(&store)?;let input=json!({"source":source,"foundation":basis,"assets":all,"settings":settings,"selection":{"assetIds":selected}});pipeline::run_asset_design(&input,&exec,model,reasoning).await?}else{json!({"assets":[],"blocked":[],"imagePlan":[]})};
                        if let Some(blocked)=output["blocked"].as_array_mut(){blocked.extend(dependency_errors);}
                        if store.source()?["version"]!=version{return Err("原文已更新；设计结果保留，不覆盖当前资产".into())}
                        if !selected.is_empty(){store.publish_asset_design(version.as_i64().ok_or("原文版本缺失")?,basis_version,&output)?;}
                        let approved=settings["trialApproved"].as_bool()==Some(true);let trial=r["trial"].as_bool()==Some(true);
                        if !approved&&!trial{output["status"]=json!("awaitingTrial");return Ok(output)}
                        let mut generation=r.clone();generation["action"]=json!("images.run");
                        let rows=store.values("assets")?;let (wanted,errs)=image_closure(&rows,r["assetIds"].as_array());if let Some(blocked)=output["blocked"].as_array_mut(){blocked.extend(errs);}
                        let ids:Vec<_>=wanted.iter().filter_map(|id|rows.iter().find(|a|s(a,"id")==id)).filter(|a|store.adopted(s(a,"id"),s(a,"variantId")).ok().flatten().is_none()).filter(|a|!trial||approved||image_dependency_ids(&rows,a).map(|d|d.is_empty()).unwrap_or(false)).take(if trial&&!approved{3}else{usize::MAX}).map(|a|a["id"].clone()).collect();generation["assetIds"]=json!(ids);
                        let report=engine.queue_images(&store,&generation)?;if let (Some(blocked),Some(queue_blocked))=(output["blocked"].as_array_mut(),report["blocked"].as_array()){blocked.extend(queue_blocked.iter().cloned());}output["status"]=json!(if report["queuedCount"].as_u64()==Some(0){"noGenerationNeeded"}else if report["blockedCount"].as_u64().unwrap_or(0)>0{"partiallyQueued"}else{"queuedForGeneration"});output["imageQueueReport"]=report;Ok(output)
                    },
                    _=>Err("未知阶段".into())
                }
            });match result{Ok(v)=>store.update_job(&job,"completed",&json!({"result":v})),Err(e)=>store.update_job(&job,"failed",&json!({"error":e}))}
        });
        if let Err(e) = &result {
            status_store.update_job(&status_job, "failed", &json!({"error":e}))?;
        }
        result
    }
    fn restore_backup(&self, store: &Store, path: &Path) -> Result<Value> {
        let source = fs::canonicalize(path).map_err(|e| e.to_string())?;
        let backup_dir = fs::canonicalize(store.root.join("backups")).map_err(|e| e.to_string())?;
        if !source.starts_with(&backup_dir) {
            return Err("请选择本项目的状态快照".into());
        }
        let new_id = id();
        let root = self.home.join("projects").join(&new_id);
        fs::create_dir_all(root.join("media")).map_err(|e| e.to_string())?;
        fs::copy(&source, root.join("project.sqlite")).map_err(|e| e.to_string())?;
        let restored = Store::open(root)?;
        for m in restored.values("media")? {
            let src = store.verify_media(&m)?;
            let dst = restored.absolute_media(&m)?;
            if let Some(p) = dst.parent() {
                fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            fs::copy(src, dst).map_err(|e| e.to_string())?;
            restored.verify_media(&m)?;
        }
        restored
            .conn()?
            .execute(
                "UPDATE project SET id=?1,title=title||'（恢复副本）'",
                [new_id],
            )
            .map_err(|e| e.to_string())?;
        portable::relocate(&restored)?;
        restored.recover_interrupted()?;
        self.register(&restored)?;
        self.workspace(&restored, None)
    }
}
struct ActiveGuard {
    engine: Arc<Engine>,
    keys: Vec<String>,
}
fn project_archived(project: &Value) -> bool {
    !s(project, "archivedAt").is_empty()
}
fn lifecycle_version(project: &Value) -> Result<u64> {
    match project.get("lifecycleVersion") {
        None | Some(Value::Null) => Ok(0),
        Some(value) => value.as_u64().ok_or_else(|| "项目生命周期版本损坏".into()),
    }
}
fn registered_store(project: &Value) -> Result<Store> {
    let root = PathBuf::from(s(project, "rootPath"));
    let database = root.join("project.sqlite");
    if s(project, "rootPath").is_empty() || !database.is_file() {
        return Err("项目文件不存在；请保留项目记录并核对项目目录".into());
    }
    // Validate identity read-only before Store::open can initialize/migrate anything.
    let connection = rusqlite::Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let actual_id: String = connection.query_row("SELECT id FROM project LIMIT 1", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if actual_id != s(project, "id") {
        return Err("项目目录与登记身份不一致，未打开或改写项目".into());
    }
    drop(connection);
    Store::open(root)
}
fn project_worker_keys(store: &Store, mut keys: Vec<String>) -> Result<Vec<String>> {
    keys.push(format!("project:{}:{}", s(&store.project()?, "id"), id()));
    Ok(keys)
}
fn image_design_source(store: &Store) -> Result<pipeline::LockedSource> {
    let raw = store.source()?;
    if raw.is_null() || s(&raw, "text").is_empty() {
        return Err("本项目尚未导入剧本原文。请先到第一阶段导入原文，再设计资产提示词；已有手写提示词的资产可以直接生成图片。".into());
    }
    let source = serde_json::from_value(raw)
        .map_err(|e| format!("剧本原文记录不完整，请重新导入或核对：{e}"))?;
    pipeline::validate_source(&source)?;
    Ok(source)
}
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.engine.active.lock() {
            for key in &self.keys {
                active.remove(key);
            }
        }
    }
}
fn is_active_generation(state: &str) -> bool {
    [
        "queued",
        "preparing",
        "ready",
        "submitting",
        "submitted",
        "processing",
        "downloading",
        "auth_required",
        "submission_unknown",
        "query_failed",
        "download_failed",
        "waiting_dependency",
        "succeeded",
    ]
    .contains(&state)
}
fn require_account(store: &Store, provider: &str) -> Result<()> {
    if ["dreamina", "bh", "chrome"].contains(&provider)
        && s(&store.settings()?, &format!("{provider}AccountId"))
            .trim()
            .is_empty()
    {
        return Err(
            "请为渠道配置稳定账户标签；更换账户时必须更改标签，不能把登录状态当作账户身份".into(),
        );
    }
    Ok(())
}
fn video_provider(store: &Store, request: &Value) -> Result<String> {
    let settings = store.settings()?;
    let provider = request
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or(s(&settings, "videoProvider"))
        .trim();
    if provider.is_empty() {
        Err("请选择视频渠道".into())
    } else {
        Ok(provider.to_owned())
    }
}
fn timestamp_fresh(value: &str, seconds: i64) -> bool {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .is_some_and(|time| {
            let age = chrono::Utc::now().signed_duration_since(time).num_seconds();
            (0..seconds).contains(&age)
        })
}
fn capability_fingerprint(config: &ProviderConfig, account: &str) -> String {
    use sha2::{Digest, Sha256};
    let credential_hash = config
        .credential_env
        .as_deref()
        .and_then(|name| std::env::var(name).ok())
        .map(|secret| format!("{:x}", Sha256::digest(secret.as_bytes())));
    let tool=config.cli_path.as_ref().and_then(|path|std::fs::metadata(path).ok()).map(|m|json!({"bytes":m.len(),"modified":m.modified().ok().and_then(|v|v.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_nanos().to_string())}));
    format!("{:x}",Sha256::digest(serde_json::to_vec(&json!({"config":config,"account":account,"credentialHash":credential_hash,"tool":tool})).unwrap_or_default()))
}
fn save_capability_cache(
    store: &Store,
    config: &ProviderConfig,
    account: &str,
    fingerprint: &str,
    cap: &Capabilities,
) -> Result<()> {
    if cap.provider != config.kind
        || cap.version.is_empty()
        || !timestamp_fresh(&cap.checked_at, 900)
    {
        return Err("能力目录的渠道身份或版本无效".into());
    }
    if capability_fingerprint(config, account) != fingerprint {
        return Err("渠道或账户配置在核实时发生变化，请重试".into());
    }
    let mut conn = store.conn()?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO catalogs VALUES(?1,?2,?3) ON CONFLICT(provider) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at",rusqlite::params![config.kind,serde_json::to_string(cap).map_err(|e|e.to_string())?,now()]).map_err(|e|e.to_string())?;
    tx.execute(
        "INSERT INTO metadata VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![
            format!("capability_binding:{}", config.kind),
            json!({"fingerprint":fingerprint,"version":cap.version}).to_string()
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
fn save_video_parameters_and_invalidate(
    store: &Store,
    parameters: &Value,
    capability_version: &str,
) -> Result<()> {
    let mut conn = store.conn()?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    for key in ["videoProvider", "videoModel", "ratio", "videoResolution"] {
        tx.execute("INSERT INTO settings VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",rusqlite::params![key,parameters[key].to_string()]).map_err(|e|e.to_string())?;
    }
    let changed_at = now();
    // Shared ratio affects image requests; video-only settings never invalidate image work.
    // The same transaction closes the settings/claim race on other channel workers.
    tx.execute("UPDATE jobs SET state='stale',error='视频参数或能力版本已变化，请重新准备',next_attempt_at=0,updated_at=?1 WHERE (task_id IS NULL OR task_id='') AND (receipt IS NULL OR receipt IN ('','null','{}')) AND state IN ('queued','preparing','ready','waiting_dependency') AND ((kind='video' AND (provider!=?2 OR COALESCE(json_extract(snapshot,'$.model'),'')!=?3 OR COALESCE(json_extract(snapshot,'$.ratio'),'')!=?4 OR COALESCE(json_extract(snapshot,'$.resolution'),'')!=?5 OR COALESCE(json_extract(snapshot,'$.capabilityVersion'),'')!=?6)) OR (kind='image' AND COALESCE(json_extract(snapshot,'$.ratio'),?4)!=?4))",rusqlite::params![changed_at,s(parameters,"videoProvider"),s(parameters,"videoModel"),s(parameters,"ratio"),s(parameters,"videoResolution"),capability_version]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO metadata VALUES('changed_at',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[changed_at]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
fn validate_video_capacity(model: &ModelCapability, snapshot: &Value) -> Result<()> {
    let duration = snapshot["duration"]
        .as_u64()
        .ok_or("视频时长需要已核实的正整秒")?;
    if duration < model.min_duration.unwrap_or(0) as u64
        || duration > model.max_duration.unwrap_or(0) as u64
        || (!model.allowed_durations.is_empty()
            && !model
                .allowed_durations
                .iter()
                .any(|d| *d as u64 == duration))
    {
        return Err("单元时长超出所选模型能力，请修订此单元，不会自动删减".into());
    }
    let refs = snapshot["references"]
        .as_array()
        .ok_or("冻结素材引用列表缺失")?;
    let count = |kind: &str| refs.iter().filter(|r| s(r, "kind") == kind).count();
    if refs
        .iter()
        .any(|r| !["image", "video", "audio"].contains(&s(r, "kind")))
        || count("image") > model.images
        || count("image") < model.required_images
        || count("video") > model.videos
        || count("audio") > model.audios
        || model
            .total_references
            .is_some_and(|limit| refs.len() > limit)
    {
        return Err("单元素材数量超出所选模型能力，请修订单元，不会自动删除素材".into());
    }
    Ok(())
}
fn open_authorization(value: &str) -> Result<()> {
    let url = authorization_url(value)?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(url)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|_| "无法自动打开即梦授权页，请使用设置中的打开授权页按钮。".to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|_| "无法打开即梦授权页".to_string())?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|_| "无法打开即梦授权页".to_string())?;
    }
    Ok(())
}
fn import_user_media(store: &Store, request: &Value, path: &Path) -> Result<Value> {
    if s(request, "kind") == "image" {
        if let Some(asset) = request["assetId"].as_str() {
            return store.import_image_as_current(path, asset, request["variantId"].as_str());
        }
    }
    store.import_media(
        path,
        s(request, "kind"),
        request["assetId"].as_str(),
        request["variantId"].as_str(),
    )
}
fn bundled_dreamina() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "dreamina.exe"
    } else {
        "dreamina"
    };
    let rel = PathBuf::from("tools/dreamina/1.4.19").join(name);
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
            roots.push(parent.join("resources"));
            #[cfg(target_os = "macos")]
            if let Some(contents) = parent.parent() {
                roots.push(contents.join("Resources"));
            }
        }
    }
    if let Some(project) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        roots.push(project.to_path_buf());
    }
    roots
        .into_iter()
        .map(|r| r.join(&rel))
        .find(|p| p.is_file())
        .and_then(|p| fs::canonicalize(p).ok())
}

fn image_dependency_ids(assets: &[Value], asset: &Value) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    if let Some(refs) = asset["design"]["referenceAssetIds"].as_array() {
        for r in refs {
            let key = r.as_str().ok_or("图片参考必须是稳定资产ID")?;
            if ids.iter().any(|id| id == key) {
                return Err("图片设计有重复参考".into());
            }
            ids.push(key.to_string());
        }
    }
    if let Some(parent) = pipeline::resolve_asset_dependency(assets, asset)? {
        if !ids.contains(&parent) {
            ids.insert(0, parent);
        }
    }
    for key in &ids {
        if key == s(asset, "id") {
            return Err("图片参考引用了自身".into());
        }
        if !assets.iter().any(|a| s(a, "id") == key) {
            return Err(format!("图片参考资产不存在：{key}"));
        }
    }
    Ok(ids)
}
fn image_references(store: &Store, assets: &[Value], asset: &Value) -> Result<Option<Vec<Value>>> {
    let ids = image_dependency_ids(assets, asset)?;
    let mut refs = Vec::new();
    let mut missing = false;
    for (order, key) in ids.iter().enumerate() {
        let a = assets
            .iter()
            .find(|a| s(a, "id") == key)
            .ok_or("图片依赖不存在")?;
        if let Some(mid) = store.adopted(key, s(a, "variantId"))? {
            let m = store.get("media", &mid)?;
            let path = store.verify_media(&m)?;
            refs.push(json!({"mediaId":mid,"kind":"image","path":path,"relativePath":m["relativePath"],"sha256":m["sha256"],"order":order,"usage":"source","assetId":key,"assetVersion":a["version"],"variantId":a["variantId"]}));
        } else {
            missing = true
        }
    }
    Ok(if missing { None } else { Some(refs) })
}
fn image_closure(assets: &[Value], selection: Option<&Vec<Value>>) -> (Vec<String>, Vec<Value>) {
    fn visit(
        key: &str,
        assets: &[Value],
        visiting: &mut HashSet<String>,
        done: &mut HashSet<String>,
        order: &mut Vec<String>,
    ) -> Result<()> {
        if done.contains(key) {
            return Ok(());
        }
        if !visiting.insert(key.to_string()) {
            return Err(format!("图片依赖循环：{key}"));
        }
        let a = assets
            .iter()
            .find(|a| s(a, "id") == key)
            .ok_or_else(|| format!("图片资产不存在：{key}"))?;
        if a.pointer("/preparation/mode").and_then(Value::as_str)==Some("UNRESOLVED") {
            return Err(format!("形象「{}」的素材制作方式尚未明确",s(a,"name")));
        }
        for parent in image_dependency_ids(assets, a)? {
            visit(&parent, assets, visiting, done, order)?;
        }
        visiting.remove(key);
        done.insert(key.to_string());
        if independent_image(a) {order.push(key.to_string());}
        Ok(())
    }
    let selected: Vec<_> = selection
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_else(|| assets.iter().map(|a| s(a, "id").to_string()).collect());
    let mut done = HashSet::new();
    let mut order = Vec::new();
    let mut errors = Vec::new();
    for key in selected {
        if let Err(e) = visit(&key, assets, &mut HashSet::new(), &mut done, &mut order) {
            errors.push(json!({"assetId":key,"reason":e}));
        }
    }
    (order, errors)
}
fn independent_image(asset:&Value)->bool {
    !matches!(asset.pointer("/preparation/mode").and_then(Value::as_str),Some("INLINE"|"AUDIO"|"UNRESOLVED"))
}
fn compile_image_prompt(body:&str,style:&str)->String {
    let body=body.trim();let style=style.trim();
    if style.is_empty() || style=="未选择" || body.starts_with(style) {return body.to_owned();}
    format!("{style}，\n{body}")
}
fn self_capabilities(store: &Store) -> Result<Value> {
    let settings = store.settings()?;
    let provider = s(&settings, "videoProvider");
    let model = s(&settings, "videoModel");
    if model.trim().is_empty() {
        // An explicit versioned writing specification, not a claim of live channel availability.
        return Ok(
            json!({"profileId":"storyboard-planning/seedance2.5","version":"storyboard-planning/seedance2.5/v1","planningOnly":true,"source":"versioned_planning_profile","model":"seedance2.5","provider":"planning","minDuration":4,"maxDuration":30,"imageLimit":30,"videoLimit":10,"audioLimit":10,"totalReferenceLimit":50,"maxTotalReferences":50,"basis":"official_cli_1.4.19_help_verified_2026-10-04","requiresLivePreflightAtStage4":true}),
        );
    }
    let raw: String = store
        .conn()?
        .query_row(
            "SELECT data FROM catalogs WHERE provider=?1",
            [provider],
            |r| r.get(0),
        )
        .map_err(|_| "请先刷新所选视频渠道能力，再生成分镜")?;
    let caps: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let m = caps["models"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|m| s(m, "id") == model && s(m, "kind") == "video")
        })
        .ok_or("所选视频模型没有已核实能力")?;
    if m["adapted"].as_bool() != Some(true) {
        return Err("模型尚未完成参数适配".into());
    }
    let min = m["minDuration"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or("所选视频模型没有已核实最小时长")?;
    let max = m["maxDuration"]
        .as_u64()
        .filter(|n| *n >= min)
        .ok_or("所选视频模型没有已核实最大时长")?;
    if s(&caps, "version").is_empty()
        || ["images", "videos", "audios"]
            .iter()
            .any(|key| m[*key].as_u64().is_none())
    {
        return Err("所选视频模型能力版本或素材容量尚未核实".into());
    }
    Ok(
        json!({"minDuration":min,"maxDuration":max,"imageLimit":m["images"],"videoLimit":m["videos"],"audioLimit":m["audios"],"totalReferenceLimit":m["totalReferences"],"maxTotalReferences":m["totalReferences"],"allowedDurations":m["allowedDurations"],"model":model,"provider":provider,"version":caps["version"],"planningOnly":false,"requiresLivePreflightAtStage4":true}),
    )
}

/// Validate a frozen rule set before resuming. The sole compatibility exception
/// is the desktop transport footer of restored foundation F2/Q1 rules; their
/// original methods and every other rule remain byte-for-byte immutable.
pub fn workflow_resume_rule_audit(job: &Value, current_rules: &Value) -> Result<Option<Value>> {
    const CHANGED: &str = "制作规则已更新，旧流程与成果已保留；请按新规则启动阶段";
    let snapshot = &job["snapshot"];
    let frozen = &snapshot["rules"];
    if frozen == current_rules {
        return Ok(None);
    }
    if s(job, "kind") != "workflow"
        || s(job, "entityId") != "foundation.run"
        || s(snapshot, "stage") != "foundation.run"
        || snapshot["runnerVersion"] != "desktop-runner/v1"
        || snapshot["foundationMethod"] != "foundation-delivery/v2"
    {
        return Err(CHANGED.into());
    }
    let old = frozen.as_array().ok_or(CHANGED)?;
    let current = current_rules.as_array().ok_or(CHANGED)?;
    if old.is_empty() || old.len() != current.len() {
        return Err(CHANGED.into());
    }
    let mut ids = HashSet::new();
    let mut changed_rules = Vec::new();
    let mut old_digests = Vec::new();
    let mut current_digests = Vec::new();
    for (before, after) in old.iter().zip(current) {
        let id = s(before, "id");
        let version = s(before, "version");
        if id.is_empty()
            || version.is_empty()
            || !ids.insert(id)
            || before["id"] != after["id"]
            || before["version"] != after["version"]
        {
            return Err(CHANGED.into());
        }
        let old_content = before["content"].as_str().ok_or(CHANGED)?;
        let new_content = after["content"].as_str().ok_or(CHANGED)?;
        if s(before, "sha256") != pipeline::digest(old_content)
            || s(after, "sha256") != pipeline::digest(new_content)
        {
            return Err(CHANGED.into());
        }
        old_digests.push(json!({"id":id,"version":version,"sha256":before["sha256"]}));
        current_digests.push(json!({"id":id,"version":version,"sha256":after["sha256"]}));
        if before == after {
            continue;
        }
        if !matches!(id, "foundation-asset-catalog" | "foundation-finishing-editor") {
            return Err(CHANGED.into());
        }
        // Only content and its digest may differ, including any future metadata.
        let mut old_identity = before.as_object().ok_or(CHANGED)?.clone();
        let mut new_identity = after.as_object().ok_or(CHANGED)?.clone();
        for key in ["content", "sha256"] {
            old_identity.remove(key);
            new_identity.remove(key);
        }
        if old_identity != new_identity {
            return Err(CHANGED.into());
        }
        let old_body = foundation_method_before_transport(old_content).ok_or(CHANGED)?;
        let new_body = foundation_method_before_transport(new_content).ok_or(CHANGED)?;
        if old_body != new_body {
            return Err(CHANGED.into());
        }
        changed_rules.push(json!({"id":id,"version":version,"oldSha256":before["sha256"],"currentSha256":after["sha256"],"originalBodySha256":pipeline::digest(old_body)}));
    }
    if changed_rules.is_empty() {
        return Err(CHANGED.into());
    }
    Ok(Some(json!({
        "policy":"foundation-transport-footer/v1",
        "stage":"foundation.run",
        "foundationMethod":"foundation-delivery/v2",
        "frozenSnapshotSha256":pipeline::digest(&snapshot.to_string()),
        "sourceVersion":snapshot["sourceVersion"],
        "sourceSha256":snapshot["input"]["source"]["sha256"],
        "oldRules":old_digests,
        "currentRules":current_digests,
        "changedRules":changed_rules,
        "originalSnapshotPreserved":true
    })))
}

// An exact, standalone heading distinguishes the appendix from a phrase inside
// the original method. Ambiguous duplicate appendix headings fail closed.
fn foundation_method_before_transport(content: &str) -> Option<&str> {
    const HEADING: &str = "## 桌面运输契约";
    let mut headings = content.match_indices(HEADING).filter(|(offset, _)| {
        let suffix = &content[offset + HEADING.len()..];
        (*offset == 0 || content.as_bytes()[offset - 1] == b'\n')
            && (suffix.is_empty() || suffix.starts_with('\n') || suffix.starts_with("\r\n"))
    });
    let (offset, _) = headings.next()?;
    if headings.next().is_some() {
        return None;
    }
    Some(&content[..offset])
}

fn production_rules(stage: &str) -> Value {
    let ids: Vec<&str> = if stage == "foundation.run" {
        vec!["screenplay-fidelity", "foundation-asset-catalog", "foundation-finishing-editor"]
    } else {
        vec![
            "screenplay-fidelity",
            "episode-emotion-planner",
            "unit-performance-director",
            "episode-finishing-editor",
            "acting-blocking",
            "camera-emotion",
            "lighting-space",
            "sound-rhythm",
            "fantasy-expression",
            "storyboard-common",
            "storyboard-source-context",
            "storyboard-card-camera-path-repair",
            "storyboard-card-comic-contrast",
            "storyboard-card-danger-rescue",
            "storyboard-card-editing-integrity",
            "storyboard-card-expressive-emphasis",
            "storyboard-card-joy-acceptance",
            "storyboard-card-long-voice",
            "storyboard-card-quiet-nonhuman",
            "storyboard-card-scale-silence",
            "storyboard-card-spatial-contact",
            "storyboard-card-status-conflict",
        ]
    };
    json!(pipeline::rule_snapshots()
        .into_iter()
        .filter(|r| ids.contains(&r.id.as_str()))
        .collect::<Vec<_>>())
}
// A previously started run keeps its actual rules and requests. It may finish or
// resume its accepted steps; a new run uses the restored F2 → Q1 method.
fn production_rules_for_snapshot(snapshot: &Value) -> Result<Value> {
    if s(snapshot, "stage") != "foundation.run" {
        return Ok(production_rules(s(snapshot, "stage")));
    }
    match snapshot["foundationMethod"].as_str() {
        Some("foundation-delivery/v2") => Ok(production_rules("foundation.run")),
        None => Ok(json!(pipeline::rule_snapshots().into_iter()
            .filter(|r| ["screenplay-fidelity", "story-foundation"].contains(&r.id.as_str()))
            .collect::<Vec<_>>())),
        _ => Err("制作基础执行方法版本不受支持，已保留原记录".into()),
    }
}
fn production_input(store: &Store, request: &Value) -> Result<Value> {
    let mut request = request.clone();
    if let Some(selection) = request["options"]["selection"].as_object().cloned() {
        for (k, v) in selection {
            request[k] = v;
        }
    }
    if s(&request, "action") == "foundation.run" && request.get("episodeIds").is_none() {
        request["episodeIds"] = json!(store.source()?["episodes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|e| e["id"].clone())
            .collect::<Vec<_>>());
    }
    let mut input =
        storyboard_input_inner(store, &request, s(&request, "action") != "foundation.run")?;
    if let Some(ids) = request.get("unitIds") {
        let ids = ids.as_array().ok_or("单元选择必须为数组")?;
        if ids.is_empty()
            || ids.iter().any(|id| {
                !input["existingUnits"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|u| u["id"] == *id)
            })
        {
            return Err("所选单元不存在于当前成果中".into());
        }
        input["selection"]["unitIds"] = json!(ids);
        input["revisionInstruction"] = request["revisionInstruction"].clone();
    }
    Ok(input)
}
#[cfg(test)]
fn storyboard_input(store: &Store, request: &Value) -> Result<Value> {
    storyboard_input_inner(store, request, true)
}
fn storyboard_input_inner(store: &Store, request: &Value, writing: bool) -> Result<Value> {
    let raw_source = store.source()?;
    let source: pipeline::LockedSource =
        serde_json::from_value(raw_source.clone()).map_err(|_| "请先导入并锁定剧本原文")?;
    let source = pipeline::upgrade_source_dialogues(&source)?;
    pipeline::validate_source(&source)?;
    if source.episodes.is_empty() {
        return Err("锁定原文尚未包含可制作的集数".into());
    }
    let selection = if let Some(ids) = request.get("episodeIds") {
        ids.as_array()
            .ok_or("分镜选择episodeIds必须为数组")?
            .clone()
    } else if let Some(id) = request
        .get("episodeId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
    {
        vec![json!(id)]
    } else {
        return Err("请从锁定原文中选择要生成分镜的集数".into());
    };
    if selection.is_empty() {
        return Err("请至少选择一集生成分镜".into());
    }
    let mut selected = HashSet::new();
    for episode in &selection {
        let id = episode
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .ok_or("分镜选择必须使用有效集数ID")?;
        if !source.episodes.iter().any(|episode| episode.id == id) {
            return Err(format!("所选集数不在当前锁定原文中：{id}"));
        }
        if !selected.insert(id) {
            return Err("所选集数不能重复".into());
        }
    }
    // Source order, never checkbox click order, governs the continuity chain.
    let episodes: Vec<Value> = source
        .episodes
        .iter()
        .filter(|episode| selected.contains(episode.id.as_str()))
        .map(|episode| json!(episode.id))
        .collect();
    let first = source
        .episodes
        .iter()
        .position(|episode| selected.contains(episode.id.as_str()))
        .ok_or("制作集数为空")?;
    let preceding: HashSet<&str> = source.episodes[..first]
        .iter()
        .map(|episode| episode.id.as_str())
        .collect();
    let previous = store
        .values("units")?
        .into_iter()
        .filter(|unit| preceding.contains(s(unit, "episodeId")))
        .max_by_key(|unit| {
            unit["sourceRefs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(|id| {
                    source
                        .rows
                        .iter()
                        .find(|row| row.id == id)
                        .map(|row| row.range.end)
                })
                .max()
                .unwrap_or(0)
        });
    let mut source_json = serde_json::to_value(source).map_err(|e| e.to_string())?;
    source_json["version"] = raw_source["version"].clone();
    Ok(
        json!({"source":source_json,"foundation":store.foundation()?,"assets":store.values("assets")?,"existingUnits":store.values("units")?,"settings":store.settings()?,"selection":{"episodeIds":episodes},"capabilities":if writing{self_capabilities(store)?}else{Value::Null},"previousBoundary":previous}),
    )
}
pub fn merge(mut base: Value, changes: &Value) -> Value {
    if let (Some(b), Some(c)) = (base.as_object_mut(), changes.as_object()) {
        for (k, v) in c {
            b.insert(k.clone(), v.clone());
        }
    }
    base
}
fn adopt_video(store: &Store, unit_id: &str, media_id: &str) -> Result<()> {
    let media = store.get("media", media_id)?;
    if s(&media, "kind") != "video" {
        return Err("只能采用视频".into());
    }
    if media["metadataVerified"].as_bool() != Some(true)
        || !media["streams"]
            .as_array()
            .map(|streams| {
                streams.iter().any(|stream| {
                    s(stream, "kind") == "video"
                        && stream["attachedPicture"].as_bool() != Some(true)
                })
            })
            .unwrap_or(false)
    {
        return Err("视频容器尚未可靠核验；请检查下载文件与媒体探测工具后再采用".into());
    }
    store.verify_media(&media)?;
    let mut c = store.conn()?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let version: i64 = tx
        .query_row("SELECT version FROM units WHERE id=?1", [unit_id], |r| {
            r.get(0)
        })
        .map_err(|_| "分镜单元不存在")?;
    let job_id:String=tx.query_row("SELECT j.id FROM job_media jm JOIN jobs j ON j.id=jm.job_id WHERE jm.media_id=?1 AND j.entity_id=?2 AND j.kind='video' AND json_extract(j.snapshot,'$.unitVersion')=?3 ORDER BY j.created_at DESC LIMIT 1",rusqlite::params![media_id,unit_id,version],|r|r.get(0)).map_err(|_|"视频结果不属于当前分镜版本；请查看对应历史任务")?;
    let adopted_at = now();
    tx.execute("INSERT INTO video_adoptions VALUES(?1,?2,?3) ON CONFLICT(unit_id) DO UPDATE SET media_id=excluded.media_id,created_at=excluded.created_at",rusqlite::params![unit_id,media_id,adopted_at]).map_err(|e|e.to_string())?;
    let proof = json!({"unitId":unit_id,"unitVersion":version,"mediaId":media_id,"jobId":job_id,"adoptedAt":adopted_at,"humanAdopted":true});
    tx.execute(
        "INSERT INTO metadata VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![format!("video_adoption:{unit_id}"), proof.to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    store.dirty()?;
    Ok(())
}
fn choose_files(r: &Value) -> Result<Value> {
    #[cfg(feature = "desktop")]
    {
        let dialog = rfd::FileDialog::new();
        let paths = if s(r, "kind") == "directory" {
            dialog.pick_folder().into_iter().collect::<Vec<_>>()
        } else if r["multiple"].as_bool() == Some(true) {
            dialog.pick_files().unwrap_or_default()
        } else {
            dialog.pick_file().into_iter().collect()
        };
        Ok(json!(paths))
    }
    #[cfg(not(feature = "desktop"))]
    {
        let _ = r;
        Err("文件选择需要桌面客户端；核心CLI请传绝对路径".into())
    }
}

#[cfg(test)]
mod account_tests {
    use super::*;
    #[test]
    fn auth_preflight_failure_preserves_unknown_submit_until_explicit_reconciliation() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(temp.path().join("project")).unwrap();
        store.create("验证", "project").unwrap();
        let unknown = store
            .add_job(
                "image",
                "asset",
                "dreamina",
                "original",
                &json!({"requestId":"unknown-request"}),
                "submission_unknown",
            )
            .unwrap();
        Engine::pause_for_auth(&store, &unknown, "登录已过期").unwrap();
        let job = store.job(&unknown).unwrap();
        assert_eq!(job["status"], "submission_unknown");
        assert_eq!(job["snapshot"]["requestId"], "unknown-request");
        let engine =
            Engine::with_channels(temp.path().join("home"), Arc::new(RealChannels)).unwrap();
        engine
            .resume_authenticated_dreamina(
                &store,
                &json!({"ready":true,"identityVerified":true,"accountKey":"original"}),
            )
            .unwrap();
        assert_eq!(store.job(&unknown).unwrap()["status"], "submission_unknown");
        assert!(store.pending_jobs().unwrap().is_empty());
    }
}

#[cfg(test)]
#[path = "engine_repair_tests.rs"]
mod repair_tests;

#[cfg(test)]
#[path = "project_lifecycle_tests.rs"]
mod project_lifecycle_tests;
