//! Old A15_A: one bounded source pass, program validation, accepted checkpoints.
use super::*;
use std::collections::{BTreeMap, HashSet};

const CAPACITY: usize = 24_000;
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
        let packet = json!({"sourceSha256":source.sha256,"identities":identities,"rows":rows.iter().map(|row|json!({"id":row.id,"number":row.number,"text":row.text,"kind":row.kind,"episodeId":row.episode_id,"sceneId":row.scene_id})).collect::<Vec<_>>()});
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
        let owner_ids: Vec<_> = identities
            .iter()
            .map(|identity| text(identity, "assetId").to_string())
            .collect();
        let variant_ids: Vec<_> = identities
            .iter()
            .flat_map(|identity| {
                identity["versions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|v| text(v, "variantId").to_string())
            })
            .collect();
        let schema = obj(
            json!({"schemaVersion":choices(&["asset-visual-facts/v1"]),"coveredRowIds":refs(&ids),"facts":array(obj(json!({"assetId":{"type":"string","enum":owner_ids},"variantId":{"type":["string","null"],"enum":variant_ids.iter().map(|v|json!(v)).chain(std::iter::once(Value::Null)).collect::<Vec<_>>()},"attribute":string(),"value":string(),"scope":choices(&["STABLE","STATE","TRANSITION"]),"claim":choices(&["SOURCE","CHARACTER_CLAIM"]),"sourceRefs":refs(&ids)}))),"issues":{"type":"array","maxItems":0,"items":{"type":"string"}}}),
        );
        let result = call_validated(
            executor,
            "assetVisualFacts",
            "asset-visual-facts-extractor",
            model,
            reasoning,
            packet,
            schema,
            &[],
            |output| {
                if text(output, "schemaVersion") != "asset-visual-facts/v1"
                    || strings(output, "coveredRowIds") != ids
                    || output["issues"]
                        .as_array()
                        .map(|v| !v.is_empty())
                        .unwrap_or(true)
                {
                    return Err("视觉事实包范围或回执不完整".into());
                }
                let found = output["facts"]
                    .as_array_mut()
                    .ok_or("视觉事实包缺少facts")?;
                for fact in found.iter_mut() {
                    validate_fact(fact, &identities, &ids_set)?;
                    *fact=json!({"assetId":fact["assetId"],"variantId":fact["variantId"],"attribute":fact["attribute"],"value":fact["value"],"scope":fact["scope"],"claim":fact["claim"],"sourceRefs":fact["sourceRefs"]});
                    let id = digest(&serde_json::to_string(fact).unwrap());
                    fact["id"] = json!(format!("visual-{id}"));
                    fact["sourceSha256"] = json!(source.sha256);
                }
                Ok(())
            },
        )
        .await;
        match result {
            Ok(result) => {
                let found = result["facts"].as_array().unwrap();
                facts.extend(found.iter().cloned());
                receipts.push(json!({"schemaVersion":"asset-visual-facts-cache/v1","status":"accepted","sourceSha256":source.sha256,"inputFingerprint":packet_hash,"ruleSha256":rule_snapshot("asset-visual-facts-extractor")?["sha256"],"rowIds":ids,"facts":found,"batchIndex":index}));
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
    }
    impl Extractor {
        fn new(mode: &'static str) -> Self {
            Self {
                mode,
                calls: Mutex::new(Vec::new()),
                accepted: Mutex::new(Vec::new()),
                rejected: Mutex::new(Vec::new()),
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
                json!({"schemaVersion":"asset-visual-facts/v1","coveredRowIds":rows.iter().map(|row|row["id"].clone()).collect::<Vec<_>>(),"facts":if self.mode=="empty"||self.mode=="partial"{json!([])}else{json!([fact])},"issues":[]}),
            )
        }
        async fn accept(&self, _request: &TextRequest, value: &Value) -> Result<(), String> {
            self.accepted.lock().unwrap().push(value.clone());
            Ok(())
        }
        async fn reject(
            &self,
            _request: &TextRequest,
            _value: &Value,
            reason: &str,
        ) -> Result<(), String> {
            self.rejected.lock().unwrap().push(reason.into());
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
}
