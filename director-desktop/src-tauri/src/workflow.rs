//! A small durable runner boundary shared by foundation and storyboard production.
//! Model rules remain versioned inputs; accepted steps and publication are Rust-owned.
use crate::store::{
    mark_changed, now, parse, s, same_content, save_asset_tx, save_unit_tx, Result, Store,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

fn has_steps(store: &Store) -> Result<bool> {
    store.conn()?.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_steps')",[],|r|r.get(0)).map_err(|e|e.to_string())
}
impl Store {
    /// Additive tables are created only when starting an explicitly requested local run.
    /// Merely opening an old project remains read-only; project v2 media/task contracts stay intact.
    pub fn ensure_workflow_storage(&self) -> Result<()> {
        self.conn()?.execute_batch("CREATE TABLE IF NOT EXISTS workflow_steps(workflow_id TEXT NOT NULL REFERENCES jobs(id),node_key TEXT NOT NULL,stage TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,text_job_id TEXT REFERENCES jobs(id),result TEXT,error TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(workflow_id,node_key));CREATE INDEX IF NOT EXISTS workflow_step_hash_idx ON workflow_steps(workflow_id,request_hash,state);CREATE TABLE IF NOT EXISTS unit_dependencies(unit_id TEXT NOT NULL REFERENCES units(id),dependency_id TEXT NOT NULL REFERENCES units(id),PRIMARY KEY(unit_id,dependency_id));CREATE INDEX IF NOT EXISTS unit_dependency_reverse_idx ON unit_dependencies(dependency_id);") .map_err(|e|e.to_string())
    }
    pub fn checkpoint(
        &self,
        run: &str,
        key: &str,
        stage: &str,
        hash: &str,
        state: &str,
        text_job: Option<&str>,
        result: Option<&Value>,
        error: Option<&str>,
    ) -> Result<()> {
        self.conn()?.execute("INSERT INTO workflow_steps VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(workflow_id,node_key) DO UPDATE SET stage=excluded.stage,request_hash=excluded.request_hash,state=excluded.state,text_job_id=excluded.text_job_id,result=excluded.result,error=excluded.error,updated_at=excluded.updated_at",params![run,key,stage,hash,state,text_job,result.map(Value::to_string),error,now()]).map_err(|e|e.to_string())?;
        self.dirty()
    }
    pub fn accepted_step(&self, run: &str, hash: &str) -> Result<Option<Value>> {
        let raw:Option<String>=self.conn()?.query_row("SELECT result FROM workflow_steps WHERE workflow_id=?1 AND request_hash=?2 AND state='accepted' ORDER BY updated_at DESC LIMIT 1",params![run,hash],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        raw.map(parse).transpose()
    }
    pub fn workflow_progress(&self) -> Result<Vec<Value>> {
        if !has_steps(self)? {
            return Ok(vec![]);
        }
        let c = self.conn()?;
        let mut q=c.prepare("SELECT id,entity_id,state,result FROM jobs WHERE kind='workflow' AND json_extract(snapshot,'$.runnerVersion')='desktop-runner/v1' ORDER BY created_at DESC,rowid DESC LIMIT 12").map_err(|e|e.to_string())?;
        let runs = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut values = vec![];
        for (id, stage, status, result) in runs {
            // Read only small progress fields; full input/source/results remain lazy.
            let mut steps=c.prepare("SELECT w.node_key,w.stage,w.state,w.error,json_extract(j.snapshot,'$.input.delivery'),json_extract(j.snapshot,'$.input.scope'),json_extract(j.snapshot,'$.input.episodeId'),json_extract(j.snapshot,'$.input.episode.id') FROM workflow_steps w LEFT JOIN jobs j ON j.id=w.text_job_id WHERE w.workflow_id=?1 ORDER BY w.rowid").map_err(|e|e.to_string())?;
            let nodes=steps.query_map([&id],|r| {
                let stage=r.get::<_,String>(1)?;
                let delivery=r.get::<_,Option<String>>(4)?.and_then(|v|serde_json::from_str::<Value>(&v).ok());
                let scope=r.get::<_,Option<String>>(5)?.and_then(|v|serde_json::from_str::<Value>(&v).ok());
                let episode=r.get::<_,Option<String>>(6)?.or(r.get::<_,Option<String>>(7)?);
                Ok(json!({"id":r.get::<_,String>(0)?,"title":step_title(&stage),"stage":stage,"status":r.get::<_,String>(2)?,"error":r.get::<_,Option<String>>(3)?,"input":{"delivery":delivery,"scope":scope,"episodeId":episode}}))
            }).map_err(|e|e.to_string())?.collect::<std::result::Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
            let result = result
                .and_then(|v| serde_json::from_str::<Value>(&v).ok())
                .unwrap_or(Value::Null);
            values.push(json!({"workflowId":id,"stage":stage,"status":status,"completedSteps":nodes.iter().filter(|n|n["status"]=="accepted").count(),"totalSteps":nodes.len(),"nodes":nodes,"waitingDecision":result["waitingDecision"],"blocked":result["blocked"]}));
        }
        Ok(values)
    }
    pub fn unit_versions(&self, id: &str) -> Result<Value> {
        self.get("units", id)?;
        let c = self.conn()?;
        let mut q = c
            .prepare(
                "SELECT version,data FROM unit_versions WHERE unit_id=?1 ORDER BY version DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut values = vec![];
        for row in rows {
            let (v, data) = row.map_err(|e| e.to_string())?;
            values.push(json!({"version":v,"data":parse(data)?}));
        }
        Ok(json!({"versions":values}))
    }
    pub fn restore_unit_version(&self, id: &str, version: i64, expected: i64) -> Result<Value> {
        let raw: String = self
            .conn()?
            .query_row(
                "SELECT data FROM unit_versions WHERE unit_id=?1 AND version=?2",
                params![id, version],
                |r| r.get(0),
            )
            .map_err(|_| "历史单元版本不存在")?;
        let mut data = parse(raw)?;
        data["expectedVersion"] = json!(expected);
        data["retired"] = json!(false);
        let result = self.save_unit(data)?;
        self.invalidate_unit_dependents(id)?;
        Ok(result)
    }
    pub fn save_production_direction(
        &self,
        direction: &str,
        source_version: i64,
        foundation_version: Option<i64>,
    ) -> Result<()> {
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let current_source: i64 = tx
            .query_row("SELECT COALESCE(MAX(version),0) FROM sources", [], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        if current_source != source_version || current_source == 0 {
            return Err("原文已经更新，请刷新后再保存制作方向".into());
        }
        let (old_version, raw) = latest_foundation(&tx)?;
        if foundation_version.is_some_and(|v| v != old_version) {
            return Err("制作基础已经更新，请刷新后再保存方向".into());
        }
        let mut foundation=raw.unwrap_or(json!({"schemaVersion":"foundation/v1","episodes":[],"assets":[],"facts":[],"issues":[],"overview":"","direction":""}));
        foundation["productionDirection"] = json!(direction.trim());
        foundation["directionConfirmed"] = json!(true);
        write_foundation(&tx, foundation, current_source)?;
        mark_changed(&tx)?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn publish_foundation(
        &self,
        guard: &Value,
        foundation: Value,
        assets: Vec<Value>,
        run: Option<&str>,
    ) -> Result<Value> {
        self.publish_foundation_with_source(guard, foundation, assets, run, None)
    }
    /// Q1 changes scene projections and foundation together; original source bytes
    /// and all submitted cloud tasks remain immutable.
    pub fn publish_foundation_with_source(
        &self, guard: &Value, mut foundation: Value, assets: Vec<Value>,
        run: Option<&str>, revised_source: Option<Value>,
    ) -> Result<Value> {
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        verify_guard(&tx, guard)?;
        let mut source_version = guard["sourceVersion"].as_i64().ok_or("冻结源版本缺失")?;
        if let Some(mut revised) = revised_source {
            let locked: crate::pipeline::LockedSource = serde_json::from_value(revised.clone()).map_err(|e|e.to_string())?;
            crate::pipeline::validate_source(&locked)?;
            let original: String = tx.query_row("SELECT data FROM sources WHERE version=?1", [source_version], |r|r.get(0)).map_err(|e|e.to_string())?;
            let original = parse(original)?;
            if revised["text"] != original["text"] || revised["sha256"] != original["sha256"] {
                return Err("场次修订不能改写原文".into());
            }
            revised["version"] = json!(source_version);
            if revised != original {
                source_version += 1;
                revised["version"] = json!(source_version);
                tx.execute("INSERT INTO sources VALUES(?1,?2,?3,?4,?5)",params![source_version,s(&revised,"text"),s(&revised,"sha256"),revised.to_string(),now()]).map_err(|e|e.to_string())?;
                tx.execute("UPDATE jobs SET state='stale',error='集场结构已更新',updated_at=?1,next_attempt_at=0 WHERE task_id IS NULL AND state IN ('ready','queued','preparing','waiting_dependency') AND kind IN ('video','image','text')",[now()]).map_err(|e|e.to_string())?;
            }
        }
        if let (_, Some(current)) = latest_foundation(&tx)? {
            for key in ["productionDirection", "directionConfirmed"] {
                if !current[key].is_null() {
                    foundation[key] = current[key].clone();
                }
            }
            if current["sourceSha256"]==foundation["sourceSha256"] && !current["visualFactBatches"].is_null() {
                foundation["visualFactBatches"]=current["visualFactBatches"].clone();
            }
        }
        let foundation = write_foundation(
            &tx,
            foundation,
            source_version,
        )?;
        for proposal in assets {
            let raw: Option<String> = tx
                .query_row(
                    "SELECT data FROM assets WHERE id=?1",
                    [s(&proposal, "id")],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let mut value = raw.map(parse).transpose()?.unwrap_or(json!({}));
            if crate::store::asset_deleted(&value) {
                // An earlier foundation remains historical evidence, not permission to
                // restore an asset the user removed from current production.
                continue;
            }
            for (k, v) in proposal.as_object().ok_or("资产提案必须为对象")? {
                if [
                    "prompt",
                    "design",
                    "designStatus",
                    "designDirection",
                    "designVersion",
                    "designSource",
                    "viewPrompt",
                ]
                .contains(&k.as_str())
                    && !value[k].is_null()
                {
                    continue;
                }
                value[k] = v.clone();
            }
            save_asset_tx(&tx, value)?;
        }
        if let Some(run) = run {
            tx.execute("UPDATE jobs SET state='completed',result=?1,error=NULL,updated_at=?2 WHERE id=?3 AND kind='workflow'",params![foundation.to_string(),now(),run]).map_err(|e|e.to_string())?;
        }
        mark_changed(&tx)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(foundation)
    }
    pub fn publish_asset_design(&self, source_version: i64, foundation_version: i64, output: &Value) -> Result<()> {
        let mut c=self.conn()?;
        let tx=c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
        let (current_version,source_raw):(i64,String)=tx.query_row("SELECT version,data FROM sources ORDER BY version DESC LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
        let (current_foundation,previous)=latest_foundation(&tx)?;
        if current_version!=source_version || current_foundation!=foundation_version { return Err("原文或制作基础已更新，设计结果保留，未覆盖当前版本".into()); }
        let source:crate::pipeline::LockedSource=serde_json::from_str(&source_raw).map_err(|e|e.to_string())?;
        let mut seen=HashSet::new();
        for design in output["assets"].as_array().ok_or("设计结果缺少资产列表")? {
            let aid=s(design,"id");
            if aid.is_empty() || !seen.insert(aid) {return Err("设计结果资产身份为空或重复".into());}
            let raw:String=tx.query_row("SELECT data FROM assets WHERE id=?1",[aid],|r|r.get(0)).map_err(|_|"设计资产已经不存在")?;
            let mut current=parse(raw)?;
            if current["version"]!=design["version"] {return Err(format!("资产 {} 在设计期间已经编辑，结果保留供核对",aid));}
            let expected=current["version"].clone();
            for (key,value) in design.as_object().ok_or("设计资产须为对象")? {current[key]=value.clone();}
            current["expectedVersion"]=expected;
            save_asset_tx(&tx,current)?;
        }
        let mut foundation=previous.unwrap_or(json!({"schemaVersion":"foundation/v1","sourceSha256":source.sha256,"episodes":[],"assets":[],"facts":[],"issues":[],"overview":"","direction":""}));
        if let Some(facts)=output["facts"].as_array() {
            let mut safe=vec![];
            for fact in facts {
                let mut fact:crate::pipeline::FoundationFact=serde_json::from_value(fact.clone()).map_err(|e|e.to_string())?;
                if fact.source_refs.is_empty() {return Err("视觉事实没有原文依据".into());}
                fact.quotes=fact.source_refs.iter().map(|id|source.rows.iter().find(|r|&r.id==id).map(|r|r.text.clone()).ok_or("视觉事实源引用已失效")).collect::<std::result::Result<Vec<_>,_>>()?.into_iter().collect();
                safe.push(json!(fact));
            }
            foundation["facts"]=json!(safe);
        }
        if let Some(receipts)=output["visualFactBatches"].as_array() {
            let mut all=foundation["visualFactBatches"].as_array().cloned().unwrap_or_default();
            for receipt in receipts {
                if receipt["sourceSha256"]!=source.sha256 || receipt["status"]!="accepted" {return Err("视觉事实缓存回执身份无效".into());}
                all.retain(|old|old["inputFingerprint"]!=receipt["inputFingerprint"]);
                all.push(receipt.clone());
            }
            foundation["visualFactBatches"]=json!(all);
        }
        write_foundation(&tx,foundation,source_version)?;
        mark_changed(&tx)?;tx.commit().map_err(|e|e.to_string())
    }
    pub fn publish_storyboard(
        &self,
        guard: &Value,
        output: &Value,
        input: &Value,
        run: Option<&str>,
    ) -> Result<()> {
        self.ensure_workflow_storage()?;
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        verify_guard(&tx, guard)?;
        let authored = output["units"].as_array().ok_or("创作结果缺少单元数组")?;
        // A successful transport group is a saved draft, not proof that the
        // episode is complete. Failed later groups must retain the old units.
        let units:Vec<_>=authored.iter().filter(|unit| {
            output["scope"]!="episodes" || output.get("updatedEpisodeIds").is_none() ||
                output["updatedEpisodeIds"].as_array().is_some_and(|ids|ids.iter().any(|eid|eid==&unit["episodeId"]))
        }).cloned().collect();
        if units.is_empty() {return Ok(());}
        let published: HashSet<_> = units.iter().map(|u| s(u, "id").to_owned()).collect();
        if published.len() != units.len() || published.contains("") {
            return Err("单元ID重复或为空，未发布成果".into());
        }
        let episodes: HashSet<_> = units.iter().map(|u| s(u, "episodeId").to_owned()).collect();
        let replaced: HashSet<_> = output["replacedUnitIds"]
            .as_array()
            .filter(|v| !v.is_empty())
            .or_else(|| input["selection"]["unitIds"].as_array())
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let mut q = tx
            .prepare("SELECT data FROM units WHERE COALESCE(json_extract(data,'$.retired'),0)<>1")
            .map_err(|e| e.to_string())?;
        let current = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(q);
        let current: Vec<Value> = current.into_iter().map(parse).collect::<Result<_>>()?;
        let in_scope = |old: &Value| {
            if replaced.is_empty() {
                episodes.contains(s(old, "episodeId"))
            } else {
                replaced.contains(s(old, "id"))
            }
        };
        let scoped: HashSet<String> = current
            .iter()
            .filter(|old| in_scope(old))
            .map(|old| s(old, "id").to_owned())
            .collect();
        let mut external_successors = HashSet::new();
        for old in current.iter().filter(|old| in_scope(old)) {
            let id = s(old, "id");
            let replacement = units.iter().find(|u| s(u, "id") == id);
            if replacement.is_none_or(|u| u["exitState"] != old["exitState"]) {
                mark_dependents_tx(&tx, id, &published)?;
            }
            let mut successors = tx
                .prepare("SELECT unit_id FROM unit_dependencies WHERE dependency_id=?1")
                .map_err(|e| e.to_string())?;
            for row in successors
                .query_map([id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
            {
                let next = row.map_err(|e| e.to_string())?;
                if !scoped.contains(&next) && !published.contains(&next) {
                    external_successors.insert(next);
                }
            }
            if !published.contains(id) {
                let mut retired = old.clone();
                retired["retired"] = json!(true);
                save_unit_tx(&tx, retired)?;
            }
        }
        let mut prior = input
            .get("previousBoundary")
            .filter(|v| !v.is_null())
            .map(|u| s(u, "id").to_owned())
            .filter(|s| !s.is_empty());
        if !replaced.is_empty() {
            if let Some(first) = input["existingUnits"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|u| scoped.contains(s(u, "id")))
            {
                prior = tx
                    .query_row(
                        "SELECT dependency_id FROM unit_dependencies WHERE unit_id=?1 LIMIT 1",
                        [s(first, "id")],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?
                    .filter(|id| !scoped.contains(id))
                    .or(prior);
            }
        }
        for unit in units {
            let mut value = unit.clone();
            value["retired"] = json!(false);
            value["continuityStale"] = json!(false);
            value["planningProfile"] = input["capabilities"].clone();
            value["sourceVersion"] = guard["sourceVersion"].clone();
            value["foundationVersion"] = guard["foundationVersion"].clone();
            let saved = save_unit_tx(&tx, value)?;
            let uid = s(&saved, "id");
            tx.execute("DELETE FROM unit_dependencies WHERE unit_id=?1", [uid])
                .map_err(|e| e.to_string())?;
            if let Some(ref previous) = prior {
                if previous != uid {
                    tx.execute(
                        "INSERT OR IGNORE INTO unit_dependencies VALUES(?1,?2)",
                        params![uid, previous],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            prior = Some(uid.to_owned());
        }
        if let Some(last) = prior.as_deref() {
            for next in external_successors {
                for old in &scoped {
                    tx.execute(
                        "DELETE FROM unit_dependencies WHERE unit_id=?1 AND dependency_id=?2",
                        params![next, old],
                    )
                    .map_err(|e| e.to_string())?;
                }
                tx.execute(
                    "INSERT OR IGNORE INTO unit_dependencies VALUES(?1,?2)",
                    params![next, last],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        for impact in output["continuityImpacts"].as_array().into_iter().flatten() {
            let id = s(impact, "nextUnitId");
            if !id.is_empty() && !published.contains(id) {
                mark_unit_stale_tx(&tx, id)?;
                mark_dependents_tx(&tx, id, &published)?;
            }
        }
        if let Some(run) = run {
            let mut next_guard = guard.clone();
            let mut versions = serde_json::Map::new();
            let scopes: HashSet<_> = guard["episodeIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            let mut q=tx.prepare("SELECT id,episode_id,version FROM units WHERE COALESCE(json_extract(data,'$.retired'),0)<>1").map_err(|e|e.to_string())?;
            for row in q
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })
                .map_err(|e| e.to_string())?
            {
                let (id, ep, v) = row.map_err(|e| e.to_string())?;
                if scopes.contains(ep.as_str()) || !guard["units"][&id].is_null() {
                    versions.insert(id, json!(v));
                }
            }
            drop(q);
            next_guard["units"] = json!(versions);
            let raw: Option<String> = tx
                .query_row("SELECT prepared FROM jobs WHERE id=?1", [run], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            let mut prepared = raw.map(parse).transpose()?.unwrap_or(json!({}));
            prepared["publicationGuard"] = next_guard;
            let status = match s(output, "status") {
                "waiting_decision" => "waiting_decision",
                "partially_blocked" => "partially_blocked",
                _ => "completed",
            };
            tx.execute("UPDATE jobs SET state=?1,prepared=?2,result=?3,error=NULL,updated_at=?4 WHERE id=?5 AND kind='workflow'",params![status,prepared.to_string(),output.to_string(),now(),run]).map_err(|e|e.to_string())?;
        }
        mark_changed(&tx)?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn invalidate_unit_dependents(&self, id: &str) -> Result<()> {
        if !has_steps(self)? {
            return Ok(());
        }
        let mut c = self.conn()?;
        let tx = c
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        mark_dependents_tx(&tx, id, &HashSet::new())?;
        mark_changed(&tx)?;
        tx.commit().map_err(|e| e.to_string())
    }
}
pub fn guard_from_input(input: &Value) -> Value {
    let assets: BTreeMap<_, _> = input["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| !crate::store::asset_deleted(a))
        .map(|a| (s(a, "id").to_owned(), a["version"].clone()))
        .collect();
    let scope: HashSet<_> = input["selection"]["episodeIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let mut units: BTreeMap<_, _> = input["existingUnits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|u| scope.contains(s(u, "episodeId")))
        .map(|u| (s(u, "id").to_owned(), u["version"].clone()))
        .collect();
    let previous = &input["previousBoundary"];
    if !s(previous, "id").is_empty() {
        units.insert(s(previous, "id").to_owned(), previous["version"].clone());
    }
    json!({"sourceVersion":input["source"]["version"],"foundationVersion":input["foundation"]["version"].as_i64().unwrap_or(0),"assets":assets,"units":units,"episodeIds":input["selection"]["episodeIds"]})
}
pub fn verify_guard(tx: &Transaction<'_>, guard: &Value) -> Result<()> {
    let source: i64 = tx
        .query_row("SELECT COALESCE(MAX(version),0) FROM sources", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let foundation: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(version),0) FROM foundations",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if guard["sourceVersion"].as_i64() != Some(source)
        || guard["foundationVersion"].as_i64() != Some(foundation)
    {
        return Err("原文或制作基础已更新；本次成果已保留，未覆盖当前版本".into());
    }
    for table in ["assets", "units"] {
        for (id, expected) in guard[table].as_object().ok_or("冻结版本清单缺失")? {
            let actual: Option<i64> = tx
                .query_row(
                    &format!("SELECT version FROM {table} WHERE id=?1"),
                    [id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if actual != expected.as_i64() {
                return Err(format!("{table}中的{id}已更新；未覆盖当前成果"));
            }
        }
    }
    let asset_count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM assets WHERE COALESCE(json_extract(data,'$.deletedAt'),'')=''",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if guard["assets"].as_object().map(|m| m.len() as i64) != Some(asset_count) {
        return Err("资产目录已新增或移除，请刷新后继续制作；本次不会覆盖当前目录".into());
    }
    let scope: HashSet<_> = guard["episodeIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if !scope.is_empty() {
        let mut q=tx.prepare("SELECT id,episode_id FROM units WHERE COALESCE(json_extract(data,'$.retired'),0)<>1").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, ep) = row.map_err(|e| e.to_string())?;
            if scope.contains(ep.as_str()) && guard["units"][&id].is_null() {
                return Err("所选集的单元集合已更新，请刷新后重新制作".into());
            }
        }
    }
    Ok(())
}
fn latest_foundation(tx: &Transaction<'_>) -> Result<(i64, Option<Value>)> {
    let raw: Option<(i64, String)> = tx
        .query_row(
            "SELECT version,data FROM foundations ORDER BY version DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match raw {
        Some((v, data)) => Ok((v, Some(parse(data)?))),
        None => Ok((0, None)),
    }
}
fn mark_unit_stale_tx(tx: &Transaction<'_>, id: &str) -> Result<()> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT data FROM units WHERE id=?1 AND COALESCE(json_extract(data,'$.retired'),0)<>1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(raw) = raw {
        let mut value = parse(raw)?;
        value["continuityStale"] = json!(true);
        save_unit_tx(tx, value)?;
    }
    Ok(())
}
fn mark_dependents_tx(tx: &Transaction<'_>, id: &str, skip: &HashSet<String>) -> Result<()> {
    let mut q=tx.prepare("WITH RECURSIVE affected(id) AS (SELECT unit_id FROM unit_dependencies WHERE dependency_id=?1 UNION SELECT d.unit_id FROM unit_dependencies d JOIN affected a ON d.dependency_id=a.id) SELECT id FROM affected WHERE id<>?1").map_err(|e|e.to_string())?;
    let affected = q
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(q);
    for dependent in affected {
        if !skip.contains(&dependent) {
            mark_unit_stale_tx(tx, &dependent)?;
        }
    }
    Ok(())
}
fn write_foundation(tx: &Transaction<'_>, mut data: Value, source_version: i64) -> Result<Value> {
    let (version, old) = latest_foundation(tx)?;
    data["sourceVersion"] = json!(source_version);
    if old.as_ref().is_some_and(|old| same_content(old, &data)) {
        return Ok(old.unwrap());
    }
    data["version"] = json!(version + 1);
    tx.execute(
        "INSERT INTO foundations VALUES(?1,?2,?3,?4)",
        params![version + 1, source_version, data.to_string(), now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(data)
}
fn step_title(stage: &str) -> &str {
    match stage {
        "foundation:F2" => "资产整理",
        "foundation:Q1" => "资料整编",
        "foundationExtract" => "提取制作基础",
        "storyboardPlan" => "情绪与事件规划",
        "storyboardCreate" => "完整单元主创",
        "storyboardFinish" => "关联范围整编",
        _ => "整理制作内容",
    }
}
