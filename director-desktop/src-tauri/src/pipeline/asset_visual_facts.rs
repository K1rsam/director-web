//! Old A15_A: one bounded source pass, program validation, accepted checkpoints.
use super::*;
use std::collections::{BTreeMap, HashSet};

const CAPACITY: usize = 24_000;
const WIRE_PROFILE: &str = "asset-visual-facts-compact/v1";
const WIRE_RESULT: &str = "asset-visual-facts-wire/v1";
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn subject(asset: &Value) -> &str {
    if text(asset, "baseAssetId").is_empty() {
        text(asset, "id")
    } else {
        text(asset, "baseAssetId")
    }
}
fn strings(value: &Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

/// The cache identity is the original domain packet, never its transport.
fn canonical_packet(source: &LockedSource, identities: &[Value], rows: &[&SourceRow]) -> Value {
    json!({"sourceSha256":source.sha256,"identities":identities,"rows":rows.iter().map(|row|json!({"id":row.id,"number":row.number,"text":row.text,"kind":row.kind,"episodeId":row.episode_id,"sceneId":row.scene_id})).collect::<Vec<_>>()})
}

struct PacketWire {
    input: Value,
    row_ids: Vec<String>,
    row_aliases: Vec<String>,
    rows_by_alias: BTreeMap<String, String>,
    packet_hash: String,
}

fn aliases<'a>(
    prefix: char,
    ids: impl IntoIterator<Item = &'a str>,
    occupied: &mut HashSet<String>,
) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    let mut number = 0;
    for id in ids {
        if result.contains_key(id) {
            continue;
        }
        let alias = loop {
            number += 1;
            let candidate = format!("{prefix}{number}");
            if occupied.insert(candidate.clone()) {
                break candidate;
            }
        };
        result.insert(id.to_string(), alias);
    }
    result
}

impl PacketWire {
    fn compile(source: &LockedSource, identities: &[Value], rows: &[&SourceRow]) -> Self {
        let packet = canonical_packet(source, identities, rows);
        let packet_hash = digest(&packet.to_string());
        // An alias cannot be confused with any real source/subject identity,
        // including a legacy identity that already happens to be named r1.
        let mut occupied: HashSet<String> = source
            .rows
            .iter()
            .map(|r| r.id.clone())
            .chain(source.episodes.iter().map(|e| e.id.clone()))
            .chain(source.scenes.iter().map(|s| s.id.clone()))
            .collect();
        let mut episode_ids: HashSet<String> =
            rows.iter().filter_map(|r| r.episode_id.clone()).collect();
        let mut scene_ids: HashSet<String> =
            rows.iter().filter_map(|r| r.scene_id.clone()).collect();
        for identity in identities {
            occupied.insert(text(identity, "assetId").into());
            for version in identity["versions"].as_array().into_iter().flatten() {
                occupied.insert(text(version, "assetRowId").into());
                occupied.insert(text(version, "variantId").into());
                episode_ids.extend(strings(&version["applicability"], "episodes"));
                scene_ids.extend(strings(&version["applicability"], "scenes"));
            }
        }
        episode_ids.extend(
            source
                .scenes
                .iter()
                .filter(|s| scene_ids.contains(&s.id))
                .map(|s| s.episode_id.clone()),
        );
        // Source order determines aliases; neither names nor text are rewritten.
        let episode_aliases = aliases(
            'e',
            source
                .episodes
                .iter()
                .filter(|e| episode_ids.contains(&e.id))
                .map(|e| e.id.as_str()),
            &mut occupied,
        );
        let scene_aliases = aliases(
            's',
            source
                .scenes
                .iter()
                .filter(|s| scene_ids.contains(&s.id))
                .map(|s| s.id.as_str()),
            &mut occupied,
        );
        let row_map = aliases('r', rows.iter().map(|r| r.id.as_str()), &mut occupied);
        let row_ids: Vec<_> = rows.iter().map(|r| r.id.clone()).collect();
        let row_aliases: Vec<_> = row_ids.iter().map(|id| row_map[id].clone()).collect();
        let rows_by_alias = row_map
            .iter()
            .map(|(id, alias)| (alias.clone(), id.clone()))
            .collect();
        let mut compact_identities = identities.to_vec();
        for identity in &mut compact_identities {
            for version in identity["versions"].as_array_mut().into_iter().flatten() {
                for (key, map) in [("episodes", &episode_aliases), ("scenes", &scene_aliases)] {
                    if let Some(ids) = version["applicability"]
                        .get_mut(key)
                        .and_then(Value::as_array_mut)
                    {
                        for id in ids {
                            if let Some(alias) = id.as_str().and_then(|id| map.get(id)) {
                                *id = json!(alias);
                            }
                        }
                    }
                }
            }
        }
        let episodes: Vec<_> = source.episodes.iter().filter_map(|episode| {
            let alias = episode_aliases.get(&episode.id)?;
            Some(json!({"id":alias,"number":episode.number,"sourceNumber":episode.source_number,"title":episode.title}))
        }).collect();
        let scenes: Vec<_> = source
            .scenes
            .iter()
            .filter_map(|scene| {
                let alias = scene_aliases.get(&scene.id)?;
                let mut value = serde_json::to_value(scene).expect("source scene is serializable");
                value.as_object_mut().unwrap().remove("rowIds");
                value["id"] = json!(alias);
                value["episodeId"] = json!(episode_aliases
                    .get(&scene.episode_id)
                    .unwrap_or(&scene.episode_id));
                Some(value)
            })
            .collect();
        let input = json!({"sourceSha256":source.sha256,"referenceEncoding":WIRE_PROFILE,"domain":if rows.iter().all(|r|r.episode_id.is_none()){"AUTHOR"}else{"EPISODE"},"coveredPacketRef":packet_hash,"identities":compact_identities,"episodes":episodes,"scenes":scenes,"rows":rows.iter().map(|row|json!({"id":row_map[&row.id],"number":row.number,"text":row.text,"kind":row.kind,"episodeId":row.episode_id.as_ref().map(|id|episode_aliases.get(id).unwrap_or(id)),"sceneId":row.scene_id.as_ref().map(|id|scene_aliases.get(id).unwrap_or(id))})).collect::<Vec<_>>(),"transportInstructions":"原版A15_A岗位方法不变，仅替换Skill末尾的桌面运输外壳。rows的text和number是锁定原文与真实行号，id为本包短行引用；episodes/scenes提供只读集场名称、原集号和权威信息，identities仍仅为主体及已有版本定位，不能充当外观证据。AUTHOR与EPISODE按本包domain分别处理，不提升角色陈述为客观事实。输出严格asset-visual-facts-wire/v1：schemaVersion、coveredPacketRef、facts、issues；coveredPacketRef原样返回输入值，确认处理本包全部rows一次。facts仍为assetId/variantId/attribute/value/scope/claim/sourceRefs，sourceRefs只用本包row.id短引用，至少一项且不重复；Rust还原到锁定原文。issues为空；无明确事实允许facts为空。不要回抄coveredRowIds、原文、行坐标或集场坐标，不创造范围外证据。"});
        Self {
            input,
            row_ids,
            row_aliases,
            rows_by_alias,
            packet_hash,
        }
    }

    fn schema(&self, identities: &[Value]) -> Value {
        let owner_ids: Vec<_> = identities.iter().map(|i| text(i, "assetId")).collect();
        let variants: Vec<_> = identities
            .iter()
            .flat_map(|i| {
                i["versions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|v| json!(text(v, "variantId")))
            })
            .chain(std::iter::once(Value::Null))
            .collect();
        let mut schema = obj(
            json!({"schemaVersion":choices(&[WIRE_RESULT]),"coveredPacketRef":{"type":"string","enum":[self.packet_hash]},"facts":array(obj(json!({"assetId":{"type":"string","enum":owner_ids},"variantId":{"type":["string","null"],"enum":variants},"attribute":string(),"value":string(),"scope":choices(&["STABLE","STATE","TRANSITION"]),"claim":choices(&["SOURCE","CHARACTER_CLAIM"]),"sourceRefs":{"type":"array","items":{"$ref":"#/$defs/sourceRow"}}}))),"issues":{"type":"array","maxItems":0,"items":{"type":"string"}}}),
        );
        // A single enum belongs to sparse facts, not to a copied coverage table.
        schema["$defs"] = json!({"sourceRow":{"type":"string","enum":self.row_aliases}});
        schema
    }

    /// Legacy canonical replies/checkpoints remain valid. Wire replies must bind
    /// this exact domain packet before short references can be interpreted.
    /// Restore and validation are atomic; reject never changes the raw reply.
    fn materialize(
        &self,
        output: &mut Value,
        identities: &[Value],
        source_sha: &str,
    ) -> Result<(), String> {
        let compact = match text(output, "schemaVersion") {
            WIRE_RESULT => {
                if text(output, "coveredPacketRef") != self.packet_hash
                    || output.get("coveredRowIds").is_some()
                {
                    return Err("视觉事实包运输回执不匹配".into());
                }
                true
            }
            "asset-visual-facts/v1" => {
                if output["coveredRowIds"] != json!(self.row_ids)
                    || output.get("coveredPacketRef").is_some()
                {
                    return Err("旧视觉事实包范围或回执不完整".into());
                }
                false
            }
            _ => return Err("视觉事实包运输版本未知".into()),
        };
        if output["issues"]
            .as_array()
            .map(|v| !v.is_empty())
            .unwrap_or(true)
        {
            return Err("视觉事实包范围或回执不完整".into());
        }
        let mut facts = output["facts"]
            .as_array()
            .ok_or("视觉事实包缺少facts")?
            .clone();
        let known: HashSet<_> = self.row_ids.iter().map(String::as_str).collect();
        for fact in &mut facts {
            if compact {
                let refs = fact
                    .get_mut("sourceRefs")
                    .and_then(Value::as_array_mut)
                    .ok_or("视觉事实缺少源行引用")?;
                for reference in refs {
                    let id = reference
                        .as_str()
                        .and_then(|alias| self.rows_by_alias.get(alias))
                        .ok_or("视觉事实短行引用未知、越包或类型错误")?;
                    *reference = json!(id);
                }
            }
            validate_fact(fact, identities, &known)?;
            *fact = json!({"assetId":fact["assetId"],"variantId":fact["variantId"],"attribute":fact["attribute"],"value":fact["value"],"scope":fact["scope"],"claim":fact["claim"],"sourceRefs":fact["sourceRefs"]});
            let id = digest(&fact.to_string());
            fact["id"] = json!(format!("visual-{id}"));
            fact["sourceSha256"] = json!(source_sha);
        }
        *output = json!({"schemaVersion":"asset-visual-facts/v1","coveredRowIds":self.row_ids,"facts":facts,"issues":[]});
        Ok(())
    }
}

fn affected(
    source: &LockedSource,
    assets: &[&Value],
    rows: &[&SourceRow],
    reason: &str,
) -> Vec<Value> {
    assets.iter().filter(|asset|{
        let explicit:HashSet<_>=strings(asset,"sourceRefs").into_iter().collect();
        let episodes:HashSet<_>=strings(&asset["applicability"],"episodes").into_iter().chain(source.rows.iter().filter(|row|explicit.contains(&row.id)).filter_map(|row|row.episode_id.clone())).collect();
        rows.iter().any(|row|explicit.contains(&row.id)||row.kind!="format"&&row.episode_id.as_ref().map(|id|episodes.contains(id)).unwrap_or(true))
    }).map(|asset|json!({"assetId":asset["id"],"variantId":asset["variantId"],"reason":format!("视觉事实批次需要处理：{reason}")})).collect()
}

fn validate_fact(
    fact: &Value,
    identities: &[Value],
    row_ids: &HashSet<&str>,
) -> Result<(), String> {
    let identity = identities
        .iter()
        .find(|identity| text(identity, "assetId") == text(fact, "assetId"))
        .ok_or("视觉事实主体不属于本次明确目录")?;
    let variant = fact.get("variantId").and_then(Value::as_str);
    if variant
        .map(|variant| {
            !identity["versions"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|v| text(v, "variantId") == variant)
        })
        .unwrap_or(false)
    {
        return Err("视觉事实版本不属于其主体".into());
    }
    if !["STABLE", "STATE", "TRANSITION"].contains(&text(fact, "scope"))
        || (text(fact, "scope") != "STABLE" && variant.is_none())
    {
        return Err("局部视觉状态未绑定明确版本".into());
    }
    if !["SOURCE", "CHARACTER_CLAIM"].contains(&text(fact, "claim"))
        || text(fact, "attribute").trim().is_empty()
        || text(fact, "value").trim().is_empty()
    {
        return Err("视觉事实缺少有效属性、值或来源层次".into());
    }
    let refs = fact
        .get("sourceRefs")
        .and_then(Value::as_array)
        .ok_or("视觉事实缺少源行引用")?;
    let mut seen = HashSet::new();
    if refs.is_empty()
        || refs.iter().any(|value| {
            value
                .as_str()
                .map(|row| !row_ids.contains(row) || !seen.insert(row))
                .unwrap_or(true)
        })
    {
        return Err("视觉事实引用越界、重复或为空".into());
    }
    Ok(())
}

pub async fn run_asset_visual_facts(
    input: &Value,
    executor: &dyn TextExecutor,
    model: &str,
    reasoning: &str,
) -> Result<Value, String> {
    let source: LockedSource =
        serde_json::from_value(input.get("source").cloned().ok_or("视觉事实缺少锁定原文")?)
            .map_err(|e| e.to_string())?;
    validate_source(&source)?;
    let assets = input["assets"]
        .as_array()
        .ok_or("视觉事实缺少明确资产范围")?;
    let mut grouped: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for asset in assets {
        grouped
            .entry(subject(asset).into())
            .or_default()
            .push(asset);
    }
    let identities:Vec<_>=grouped.into_iter().map(|(id,versions)|{
        let foundation=input.pointer("/foundation/assets").and_then(Value::as_array).into_iter().flatten().find(|a|text(a,"id")==id);
        json!({"assetId":id,"name":foundation.and_then(|a|a.get("name")).or_else(||versions[0].get("name")),"aliases":foundation.and_then(|a|a.get("aliases")),"kind":versions[0].get("kind").or_else(||versions[0].get("type")),"versions":versions.iter().map(|a|json!({"assetRowId":a["id"],"variantId":a["variantId"],"name":a["name"],"applicability":a["applicability"]})).collect::<Vec<_>>()})
    }).collect();
    let known: HashSet<_> = source.rows.iter().map(|row| row.id.as_str()).collect();
    let mut facts = input
        .pointer("/foundation/facts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut blocked = Vec::new();
    let mut missing = Vec::new();
    for asset in assets {
        let explicit = input
            .pointer("/selection/assetIds")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().any(|id| id.as_str() == Some(text(asset, "id"))))
            .unwrap_or(true);
        if !explicit && !text(asset, "prompt").trim().is_empty() {
            continue;
        }
        let relevant: Vec<_> = facts
            .iter()
            .filter(|fact| {
                text(fact, "assetId") == subject(asset)
                    && (text(fact, "variantId").is_empty()
                        || text(fact, "variantId") == text(asset, "variantId"))
            })
            .collect();
        if let Some(reason) = relevant
            .iter()
            .find_map(|fact| validate_fact(fact, &identities, &known).err())
        {
            blocked.push(
                json!({"assetId":asset["id"],"variantId":asset["variantId"],"reason":reason}),
            );
            continue;
        }
        let derived =
            !text(asset, "sourceAssetId").is_empty() || !text(asset, "sourceVariantId").is_empty();
        let current_fact = relevant.iter().any(|fact| {
            text(fact, "variantId") == text(asset, "variantId")
                || !derived && text(fact, "scope") == "STABLE" && text(fact, "variantId").is_empty()
        });
        if input
            .pointer("/foundation/sourceSha256")
            .and_then(Value::as_str)
            == Some(&source.sha256)
            && current_fact
        {
            continue;
        }
        missing.push(asset);
    }
    if missing.is_empty() {
        return Ok(json!({"facts":facts,"blocked":blocked,"visualFactBatches":[]}));
    }
    let explicit_rows: HashSet<_> = missing
        .iter()
        .flat_map(|asset| strings(asset, "sourceRefs"))
        .collect();
    let episodes: HashSet<String> = missing
        .iter()
        .flat_map(|asset| {
            asset
                .pointer("/applicability/episodes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
        })
        .chain(
            source
                .rows
                .iter()
                .filter(|row| explicit_rows.contains(&row.id))
                .filter_map(|row| row.episode_id.clone()),
        )
        .collect();
    let rows: Vec<_> = source
        .rows
        .iter()
        .filter(|row| {
            explicit_rows.contains(&row.id)
                || row
                    .episode_id
                    .as_ref()
                    .map(|id| episodes.contains(id))
                    .unwrap_or(row.kind == "context")
        })
        .collect();
    if rows.is_empty() {
        return Ok(json!({"facts":facts,"blocked":blocked,"visualFactBatches":[]}));
    }
    let mut groups: Vec<Vec<&SourceRow>> = Vec::new();
    let mut current = Vec::new();
    let mut chars = 0;
    let mut author = false;
    for row in rows {
        let size = row.text.encode_utf16().count() + 1;
        let is_author = row.episode_id.is_none();
        if !current.is_empty() && (chars + size > CAPACITY || author != is_author) {
            groups.push(std::mem::take(&mut current));
            chars = 0;
        }
        author = is_author;
        chars += size;
        current.push(row);
    }
    if !current.is_empty() {
        groups.push(current)
    }
    let mut receipts = Vec::new();
    for (index, rows) in groups.iter().enumerate() {
        let ids: Vec<_> = rows.iter().map(|row| row.id.clone()).collect();
        let ids_set: HashSet<_> = ids.iter().map(String::as_str).collect();
        let packet = canonical_packet(&source, &identities, rows);
        let packet_hash = digest(&serde_json::to_string(&packet).unwrap());
        if let Some(cache) = input
            .pointer("/foundation/visualFactBatches")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|cache| {
                text(cache, "inputFingerprint") == packet_hash
                    && text(cache, "status") == "accepted"
                    && text(cache, "ruleSha256")
                        == rule_snapshot("asset-visual-facts-extractor")
                            .ok()
                            .as_ref()
                            .map(|r| text(r, "sha256"))
                            .unwrap_or("")
            })
        {
            let validation = (|| {
                let cached = cache["facts"].as_array().ok_or("视觉事实缓存缺少facts")?;
                for fact in cached {
                    validate_fact(fact, &identities, &ids_set)?;
                }
                Ok::<_, String>(cached)
            })();
            match validation {
                Ok(cached) => {
                    facts.extend(cached.iter().cloned());
                    receipts.push(cache.clone());
                }
                Err(reason) => blocked.extend(affected(
                    &source,
                    &missing,
                    rows,
                    &format!("旧缓存无效：{reason}，未重发提取"),
                )),
            }
            continue;
        }
        let wire = PacketWire::compile(&source, &identities, rows);
        debug_assert_eq!(wire.packet_hash, packet_hash);
        let schema = wire.schema(&identities);
        let result = call_validated(
            executor,
            "assetVisualFacts",
            "asset-visual-facts-extractor",
            model,
            reasoning,
            wire.input.clone(),
            schema,
            &[],
            |output| wire.materialize(output, &identities, &source.sha256),
        )
        .await;
        match result {
            Ok(result) => {
                let found = result["facts"].as_array().unwrap();
                facts.extend(found.iter().cloned());
                receipts.push(json!({"schemaVersion":"asset-visual-facts-cache/v1","status":"accepted","sourceSha256":source.sha256,"inputFingerprint":packet_hash,"ruleSha256":rule_snapshot("asset-visual-facts-extractor")?["sha256"],"rowIds":ids,"facts":found,"batchIndex":index,"referenceEncoding":WIRE_PROFILE,"coveredPacketRef":packet_hash}));
            }
            Err(reason) => {
                blocked.extend(affected(&source, &missing, rows, &reason));
            }
        }
    }
    let mut signatures = HashSet::new();
    facts.retain(|fact| signatures.insert(digest(&serde_json::to_string(&json!({"assetId":fact["assetId"],"variantId":fact["variantId"],"attribute":fact["attribute"],"value":fact["value"],"scope":fact["scope"],"claim":fact["claim"],"sourceRefs":fact["sourceRefs"]})).unwrap())));
    Ok(json!({"facts":facts,"blocked":blocked,"visualFactBatches":receipts}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    struct Extractor {
        mode: &'static str,
        calls: Mutex<Vec<Value>>,
        accepted: Mutex<Vec<Value>>,
        rejected: Mutex<Vec<String>>,
        rejected_values: Mutex<Vec<Value>>,
    }
    impl Extractor {
        fn new(mode: &'static str) -> Self {
            Self {
                mode,
                calls: Mutex::new(Vec::new()),
                accepted: Mutex::new(Vec::new()),
                rejected: Mutex::new(Vec::new()),
                rejected_values: Mutex::new(Vec::new()),
            }
        }
    }
    #[async_trait]
    impl TextExecutor for Extractor {
        async fn execute(&self, request: TextRequest) -> Result<Value, String> {
            assert_eq!(request.stage, "assetVisualFacts");
            assert_eq!(request.skill, "asset-visual-facts-extractor");
            self.calls.lock().unwrap().push(request.input.clone());
            let rows = request.input["rows"].as_array().unwrap();
            if self.mode == "partial"
                && rows
                    .iter()
                    .any(|row| text(row, "text").contains("失败标记"))
            {
                return Err("模拟首包失败".into());
            }
            let identity = &request.input["identities"][0];
            let row = rows
                .iter()
                .find(|row| text(row, "kind") != "format")
                .unwrap_or(&rows[0]);
            let fact = json!({"assetId":if self.mode=="owner"{"unknown"}else{text(identity,"assetId")},"variantId":if self.mode=="variant"{json!("not-owned")}else{Value::Null},"attribute":"hair.color","value":"黑发","scope":"STABLE","claim":"SOURCE","sourceRefs":if self.mode=="source"{json!(["foreign-row"])}else{json!([row["id"]])},"quotes":["模型多余重抄不得保留"]});
            Ok(
                json!({"schemaVersion":WIRE_RESULT,"coveredPacketRef":request.input["coveredPacketRef"],"facts":if self.mode=="empty"||self.mode=="partial"{json!([])}else{json!([fact])},"issues":[]}),
            )
        }
        async fn accept(&self, _request: &TextRequest, value: &Value) -> Result<(), String> {
            self.accepted.lock().unwrap().push(value.clone());
            Ok(())
        }
        async fn reject(
            &self,
            _request: &TextRequest,
            value: &Value,
            reason: &str,
        ) -> Result<(), String> {
            self.rejected.lock().unwrap().push(reason.into());
            self.rejected_values.lock().unwrap().push(value.clone());
            Ok(())
        }
    }
    struct Never;
    #[async_trait]
    impl TextExecutor for Never {
        async fn execute(&self, _request: TextRequest) -> Result<Value, String> {
            panic!("有效或空结果缓存不应重复调用")
        }
    }
    fn basis() -> Value {
        let source = prepare_source("第一集\n场景：门口\n△小王和小李黑发出现。\n").unwrap();
        let row = source.rows[2].id.clone();
        json!({"source":source,"assets":[{"id":"王:base","baseAssetId":"王","variantId":"base","name":"王","sourceRefs":[row],"prompt":"旧历史不应发给提取岗"},{"id":"李:base","baseAssetId":"李","variantId":"base","name":"李","sourceRefs":[row]}],"foundation":{"sourceSha256":source.sha256,"facts":[]}})
    }
    #[tokio::test]
    async fn one_packet_reads_source_once_for_all_subjects_and_program_attaches_fact_identity() {
        let input = basis();
        let exec = Extractor::new("valid");
        let output = run_asset_visual_facts(&input, &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert!(output["blocked"].as_array().unwrap().is_empty());
        assert_eq!(exec.calls.lock().unwrap().len(), 1);
        assert_eq!(exec.accepted.lock().unwrap().len(), 1);
        let calls = exec.calls.lock().unwrap();
        assert_eq!(calls[0]["identities"].as_array().unwrap().len(), 2);
        assert!(!serde_json::to_string(&calls[0]).unwrap().contains("旧历史"));
        let rows = calls[0]["rows"].as_array().unwrap();
        assert_eq!(
            rows.len(),
            input["source"]["rows"].as_array().unwrap().len()
        );
        assert!(rows.iter().all(|row| row.get("dialogue").is_none()));
        assert!(output["facts"][0].get("quotes").is_none());
        assert!(text(&output["facts"][0], "id").starts_with("visual-"));
        assert_eq!(
            output["facts"][0]["sourceSha256"],
            input["source"]["sha256"]
        );
    }
    #[tokio::test]
    async fn invalid_owner_version_or_source_is_rejected_without_success_cache() {
        for mode in ["owner", "variant", "source"] {
            let exec = Extractor::new(mode);
            let output = run_asset_visual_facts(&basis(), &exec, "gpt-6.1-sol", "medium")
                .await
                .unwrap();
            assert_eq!(exec.accepted.lock().unwrap().len(), 0);
            assert_eq!(exec.rejected.lock().unwrap().len(), 1);
            assert!(output["facts"].as_array().unwrap().is_empty());
            assert!(output["visualFactBatches"].as_array().unwrap().is_empty());
            assert_eq!(output["blocked"].as_array().unwrap().len(), 2);
        }
    }
    #[tokio::test]
    async fn successful_empty_packet_is_reused_without_another_extraction() {
        let mut input = basis();
        let exec = Extractor::new("empty");
        let first = run_asset_visual_facts(&input, &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(first["visualFactBatches"].as_array().unwrap().len(), 1);
        input["foundation"]["visualFactBatches"] = first["visualFactBatches"].clone();
        let second = run_asset_visual_facts(&input, &Never, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert!(second["blocked"].as_array().unwrap().is_empty());
        assert!(second["facts"].as_array().unwrap().is_empty());
        assert_eq!(second["visualFactBatches"], first["visualFactBatches"]);
    }
    struct Replay(Value);
    #[async_trait]
    impl TextExecutor for Replay {
        async fn execute(&self, _request: TextRequest) -> Result<Value, String> {
            Ok(self.0.clone())
        }
    }
    #[tokio::test]
    async fn checkpoint_replay_does_not_change_program_fact_ids_or_keep_model_quotes() {
        let input = basis();
        let exec = Extractor::new("valid");
        let first = run_asset_visual_facts(&input, &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        let replay = Replay(exec.accepted.lock().unwrap()[0].clone());
        let second = run_asset_visual_facts(&input, &replay, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(second["facts"], first["facts"]);
        assert!(second["facts"][0].get("quotes").is_none());
    }
    #[tokio::test]
    async fn valid_existing_current_facts_are_preserved_without_reading_source_again() {
        let mut input = basis();
        let row = input["source"]["rows"][2]["id"].clone();
        input["foundation"]["facts"] = json!([{"id":"王-fact","assetId":"王","variantId":null,"attribute":"hair.color","value":"黑发","scope":"STABLE","claim":"SOURCE","sourceRefs":[row]},{"id":"李-fact","assetId":"李","variantId":null,"attribute":"hair.color","value":"黑发","scope":"STABLE","claim":"SOURCE","sourceRefs":[row]}]);
        let output = run_asset_visual_facts(&input, &Never, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(output["facts"], input["foundation"]["facts"]);
        assert!(output["blocked"].as_array().unwrap().is_empty());
    }
    #[tokio::test]
    async fn tampered_cached_fact_blocks_locally_without_automatic_reextraction() {
        let mut input = basis();
        let exec = Extractor::new("empty");
        let first = run_asset_visual_facts(&input, &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        input["foundation"]["visualFactBatches"] = first["visualFactBatches"].clone();
        input["foundation"]["visualFactBatches"][0]["facts"] = json!([{"assetId":"王","variantId":null,"attribute":"hair.color","value":"黑发","scope":"STABLE","claim":"SOURCE","sourceRefs":["foreign-row"]}]);
        let output = run_asset_visual_facts(&input, &Never, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(output["blocked"].as_array().unwrap().len(), 2);
        assert!(output["facts"].as_array().unwrap().is_empty());
    }
    #[tokio::test]
    async fn capacity_packs_keep_successful_results_and_only_block_affected_subjects() {
        let text = format!(
            "第一集\n场景：门口\n△王：失败标记{}\n第二集\n场景：河边\n△李：{}\n",
            "甲".repeat(18_000),
            "乙".repeat(18_000)
        );
        let source = prepare_source(&text).unwrap();
        let a = source.rows[2].id.clone();
        let b = source.rows[5].id.clone();
        let input = json!({"source":source,"assets":[{"id":"a","variantId":"base","sourceRefs":[a]},{"id":"b","variantId":"base","sourceRefs":[b]}]});
        let exec = Extractor::new("partial");
        let output = run_asset_visual_facts(&input, &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(exec.calls.lock().unwrap().len(), 2);
        assert_eq!(output["visualFactBatches"].as_array().unwrap().len(), 1);
        assert_eq!(output["blocked"].as_array().unwrap().len(), 1);
        assert_eq!(output["blocked"][0]["assetId"], "a");
    }

    fn identities(source: &LockedSource) -> Vec<Value> {
        vec![
            json!({"assetId":"person","name":"e1 r1 苏远","aliases":["s1"],"versions":[{"assetRowId":"person:base","variantId":"base","name":"r1 默认","applicability":{"scope":"SCENES","episodes":source.episodes.iter().map(|e|&e.id).collect::<Vec<_>>(),"scenes":source.scenes.iter().map(|s|&s.id).collect::<Vec<_>>()}}]}),
        ]
    }
    fn wire_reply(wire: &PacketWire, reference: &str) -> Value {
        json!({"schemaVersion":WIRE_RESULT,"coveredPacketRef":wire.packet_hash,"facts":[{"assetId":"person","variantId":null,"attribute":"hair.color","value":"原文黑发；r1 e1是原样说明","scope":"STABLE","claim":"SOURCE","sourceRefs":[reference]}],"issues":[]})
    }

    #[test]
    fn compact_transport_preserves_source_text_order_and_authority_without_identity_leak() {
        let mut source = prepare_source(
            "第一集\n场景：e1门口\n△r1和e1黑发出现。\n第二集\n场景：河边\n△苏远白衣。\n",
        )
        .unwrap();
        source.scenes[0].metadata.insert(
            "authority".into(),
            json!({"level":"SOURCE","note":"r1 e1原样"}),
        );
        let identities = identities(&source);
        let rows: Vec<_> = source.rows.iter().collect();
        let wire = PacketWire::compile(&source, &identities, &rows);
        let packet = canonical_packet(&source, &identities, &rows);
        assert_eq!(wire.packet_hash, digest(&packet.to_string()));
        assert_eq!(wire.input["domain"], "EPISODE");
        for (original, compact) in rows.iter().zip(wire.input["rows"].as_array().unwrap()) {
            for key in ["number", "text", "kind"] {
                assert_eq!(compact[key], packet["rows"][original.number - 1][key]);
            }
            assert_eq!(wire.rows_by_alias[text(compact, "id")], original.id);
            assert!(compact.get("range").is_none());
        }
        assert_eq!(wire.input["identities"][0]["name"], "e1 r1 苏远");
        assert_eq!(
            wire.input["identities"][0]["versions"][0]["name"],
            "r1 默认"
        );
        assert_eq!(
            wire.input["episodes"][0]["sourceNumber"],
            source.episodes[0].source_number
        );
        assert_eq!(wire.input["scenes"][0]["title"], source.scenes[0].title);
        assert_eq!(
            wire.input["scenes"][0]["authority"],
            source.scenes[0].metadata["authority"]
        );
        assert_eq!(
            wire.input["identities"][0]["versions"][0]["applicability"]["episodes"][0],
            wire.input["episodes"][0]["id"]
        );
        assert_eq!(
            wire.input["identities"][0]["versions"][0]["applicability"]["scenes"][0],
            wire.input["scenes"][0]["id"]
        );
        let mut raw = wire_reply(&wire, &wire.row_aliases[2]);
        let original = raw.clone();
        wire.materialize(&mut raw, &identities, &source.sha256)
            .unwrap();
        assert_eq!(
            raw["coveredRowIds"],
            json!(rows.iter().map(|r| &r.id).collect::<Vec<_>>())
        );
        assert_eq!(raw["facts"][0]["sourceRefs"], json!([source.rows[2].id]));
        assert_eq!(raw["facts"][0]["value"], original["facts"][0]["value"]);
        assert_eq!(
            original["facts"][0]["sourceRefs"],
            json!([wire.row_aliases[2]]),
            "raw wire was not rewritten"
        );
        let accepted = raw.clone();
        wire.materialize(&mut raw, &identities, &source.sha256)
            .unwrap();
        assert_eq!(
            raw, accepted,
            "accepted canonical checkpoint replay is idempotent"
        );
    }

    #[test]
    fn packet_receipt_and_sparse_references_are_strict_and_restore_is_atomic() {
        let source = prepare_source("作者：苏远黑发。\n第一集\n场景：门口\n△苏远白衣。\n").unwrap();
        let identities = identities(&source);
        let author: Vec<_> = source
            .rows
            .iter()
            .filter(|r| r.episode_id.is_none())
            .collect();
        let body: Vec<_> = source
            .rows
            .iter()
            .filter(|r| r.episode_id.is_some())
            .collect();
        assert!(!author.is_empty() && !body.is_empty());
        let a = PacketWire::compile(&source, &identities, &author);
        let b = PacketWire::compile(&source, &identities, &body);
        assert_ne!(a.packet_hash, b.packet_hash);
        assert_eq!(
            a.row_aliases[0], b.row_aliases[0],
            "short IDs are task local; receipt prevents cross-packet reuse"
        );
        let valid = wire_reply(&b, &b.row_aliases[0]);
        let mut cases = Vec::new();
        let mut wrong = valid.clone();
        wrong["coveredPacketRef"] = json!(a.packet_hash);
        cases.push(wrong);
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove("coveredPacketRef");
        cases.push(missing);
        let mut duplicate = valid.clone();
        duplicate["facts"][0]["sourceRefs"] = json!([b.row_aliases[0], b.row_aliases[0]]);
        cases.push(duplicate);
        for reference in ["r99999", "e1", &author[0].id, &body[0].id] {
            let mut unknown = valid.clone();
            unknown["facts"][0]["sourceRefs"] = json!([reference]);
            cases.push(unknown);
        }
        let mut coords = valid.clone();
        coords["coveredRowIds"] = json!([b.row_aliases[0]]);
        cases.push(coords);
        let mut nonstring = valid.clone();
        nonstring["facts"][0]["sourceRefs"] = json!([7]);
        cases.push(nonstring);
        let mut empty = valid.clone();
        empty["facts"][0]["sourceRefs"] = json!([]);
        cases.push(empty);
        let mut issue = valid.clone();
        issue["issues"] = json!(["新增审查"]);
        cases.push(issue);
        for mut reply in cases {
            let original = reply.clone();
            assert!(
                b.materialize(&mut reply, &identities, &source.sha256)
                    .is_err(),
                "{original}"
            );
            assert_eq!(reply, original, "rejected raw stays byte-equivalent");
        }
        let mut partial = valid.clone();
        partial["facts"]
            .as_array_mut()
            .unwrap()
            .push(json!({"assetId":"foreign"}));
        let original = partial.clone();
        assert!(b
            .materialize(&mut partial, &identities, &source.sha256)
            .is_err());
        assert_eq!(partial, original);
    }

    #[test]
    fn legacy_raw_is_still_source_bound_and_produces_the_same_fact_identity() {
        let source = prepare_source("第一集\n场景：门口\n△苏远黑发。\n").unwrap();
        let identities = identities(&source);
        let rows: Vec<_> = source.rows.iter().collect();
        let wire = PacketWire::compile(&source, &identities, &rows);
        let mut compact = wire_reply(&wire, &wire.row_aliases[2]);
        let mut legacy = json!({"schemaVersion":"asset-visual-facts/v1","coveredRowIds":wire.row_ids,"facts":compact["facts"],"issues":[]});
        legacy["facts"][0]["sourceRefs"] = json!([source.rows[2].id]);
        legacy["facts"][0]["quotes"] = json!(["模型引文不采用"]);
        wire.materialize(&mut compact, &identities, &source.sha256)
            .unwrap();
        let old = legacy.clone();
        wire.materialize(&mut legacy, &identities, &source.sha256)
            .unwrap();
        assert_eq!(legacy, compact);
        for mode in ["partial", "duplicate", "nonstring", "foreign", "alias"] {
            let mut invalid = old.clone();
            match mode {
                "partial" => {
                    invalid["coveredRowIds"].as_array_mut().unwrap().pop();
                }
                "duplicate" => invalid["coveredRowIds"][1] = invalid["coveredRowIds"][0].clone(),
                "nonstring" => invalid["coveredRowIds"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(1)),
                "foreign" => invalid["facts"][0]["sourceRefs"] = json!(["outside"]),
                "alias" => invalid["facts"][0]["sourceRefs"] = json!([wire.row_aliases[2]]),
                _ => unreachable!(),
            }
            let original = invalid.clone();
            assert!(
                wire.materialize(&mut invalid, &identities, &source.sha256)
                    .is_err(),
                "{mode}"
            );
            assert_eq!(invalid, original);
        }
    }

    #[tokio::test]
    async fn accepted_precompact_cache_uses_unchanged_packet_and_rule_hash_without_a_call() {
        let mut input = basis();
        let exec = Extractor::new("valid");
        let first = run_asset_visual_facts(&input, &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        let source: LockedSource = serde_json::from_value(input["source"].clone()).unwrap();
        let rows: Vec<_> = source.rows.iter().collect();
        let calls = exec.calls.lock().unwrap();
        // This fixture has no applicability aliases, so its subjects are exactly
        // the pre-transport identity table used to calculate the old hash.
        let packet = canonical_packet(&source, calls[0]["identities"].as_array().unwrap(), &rows);
        assert_eq!(
            first["visualFactBatches"][0]["inputFingerprint"],
            digest(&packet.to_string())
        );
        let mut old = first["visualFactBatches"].clone();
        old[0].as_object_mut().unwrap().remove("referenceEncoding");
        old[0].as_object_mut().unwrap().remove("coveredPacketRef");
        input["foundation"]["visualFactBatches"] = old.clone();
        let replay = run_asset_visual_facts(&input, &Never, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(replay["visualFactBatches"], old);
        assert_eq!(replay["facts"], first["facts"]);
        assert!(replay["blocked"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn author_and_episode_domains_keep_two_requests_and_exact_disjoint_materialized_coverage()
    {
        let source = prepare_source(
            "作者：苏远黑发。\n第一集\n场景：门口\n△苏远白衣。\n第二集\n场景：河边\n△苏远出现。\n",
        )
        .unwrap();
        let explicit: Vec<_> = source
            .rows
            .iter()
            .filter(|r| r.kind == "body")
            .map(|r| &r.id)
            .collect();
        let input = json!({"source":source,"assets":[{"id":"a","baseAssetId":"person","variantId":"base","sourceRefs":explicit}],"foundation":{"facts":[]}});
        let exec = Extractor::new("empty");
        let output = run_asset_visual_facts(&input, &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        let calls = exec.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["domain"], "AUTHOR");
        assert_eq!(calls[1]["domain"], "EPISODE");
        let covered: Vec<_> = output["visualFactBatches"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|b| strings(b, "rowIds"))
            .collect();
        assert_eq!(covered.iter().collect::<HashSet<_>>().len(), covered.len());
        assert_eq!(
            covered,
            source.rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>()
        );
        assert_eq!(
            calls
                .iter()
                .map(|c| c["rows"].as_array().unwrap().len())
                .sum::<usize>(),
            covered.len()
        );
    }

    #[test]
    fn three_hundred_sixty_six_rows_have_one_receipt_and_one_short_reference_schema() {
        let text = format!(
            "第一集\n场景：门口\n{}",
            (1..=364)
                .map(|i| format!("△苏远第{i}行，e1 r1。\n"))
                .collect::<String>()
        );
        let source = prepare_source(&text).unwrap();
        assert_eq!(source.rows.len(), 366);
        let identities = identities(&source);
        let rows: Vec<_> = source.rows.iter().collect();
        let wire = PacketWire::compile(&source, &identities, &rows);
        let schema = wire.schema(&identities);
        assert!(schema["properties"].get("coveredRowIds").is_none());
        assert_eq!(
            schema["$defs"]["sourceRow"]["enum"]
                .as_array()
                .unwrap()
                .len(),
            366
        );
        assert_eq!(
            schema["properties"]["coveredPacketRef"]["enum"],
            json!([wire.packet_hash])
        );
        let packet = canonical_packet(&source, &identities, &rows);
        let old_ref_bytes = json!(wire.row_ids).to_string().len();
        let ack_bytes = json!({"coveredPacketRef":wire.packet_hash})
            .to_string()
            .len();
        assert!(
            ack_bytes * 50 < old_ref_bytes,
            "{ack_bytes} vs {old_ref_bytes}"
        );
        assert!(
            wire.input.to_string().len() < packet.to_string().len(),
            "names and instructions still outweigh aliases on short fixtures only"
        );
        assert!(
            schema.to_string().len() < old_ref_bytes,
            "schema no longer repeats hundreds of canonical IDs"
        );
        let mut empty = json!({"schemaVersion":WIRE_RESULT,"coveredPacketRef":wire.packet_hash,"facts":[],"issues":[]});
        wire.materialize(&mut empty, &identities, &source.sha256)
            .unwrap();
        assert_eq!(empty["coveredRowIds"].as_array().unwrap().len(), 366);
        println!("A15 366 rows: canonical_input_bytes={} compact_input_bytes={} old_coverage_bytes={} packet_ack_bytes={} compact_schema_bytes={}",packet.to_string().len(),wire.input.to_string().len(),old_ref_bytes,ack_bytes,schema.to_string().len());
    }
}
