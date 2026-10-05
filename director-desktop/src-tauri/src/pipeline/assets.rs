use super::*;
use std::collections::{BTreeMap, HashSet};

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Repeated display variants such as base and legacy are legal; ambiguous parent identity is not.
pub fn resolve_asset_dependency(assets: &[Value], asset: &Value) -> Result<Option<String>, String> {
    if let Some(id) = asset
        .get("sourceAssetId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        return assets
            .iter()
            .find(|a| text(a, "id") == id)
            .map(|a| Some(text(a, "id").to_string()))
            .ok_or_else(|| format!("明确来源资产不存在：{id}"));
    }
    let parent = asset
        .get("sourceVariantId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    parent
        .map(|id| resolve_reference(assets, asset, id).map(Some))
        .unwrap_or(Ok(None))
}
fn resolve_reference(assets: &[Value], asset: &Value, parent: &str) -> Result<String, String> {
    if let Some(exact) = assets.iter().find(|a| text(a, "id") == parent) {
        return Ok(text(exact, "id").to_string());
    }
    let candidates: Vec<_> = assets
        .iter()
        .filter(|a| text(a, "variantId") == parent)
        .collect();
    let identity = text(asset, "baseAssetId");
    let same_subject: Vec<_> = candidates
        .iter()
        .copied()
        .filter(|a| !identity.is_empty() && text(a, "baseAssetId") == identity)
        .collect();
    let matches = if same_subject.is_empty() {
        candidates
    } else {
        same_subject
    };
    match matches.as_slice() {
        [one] => Ok(text(one, "id").to_string()),
        [] => Err(format!("来源形象不存在：{parent}")),
        _ => Err(format!(
            "来源形象 {parent} 有多个身份，请指定 sourceAssetId"
        )),
    }
}
fn exact_strings(value: &Value, key: &str) -> Result<Vec<String>, String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("缺少 {key}"))?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("{key} 含非字符串引用"))
        })
        .collect()
}

fn asset_identity(asset: &Value) -> &str {
    if text(asset, "baseAssetId").is_empty() {
        text(asset, "id")
    } else {
        text(asset, "baseAssetId")
    }
}

/// The old C/D input contract inherits only this subject's explicit version facts.
/// A child replaces the same attribute, not another subject or a later state.
fn design_facts(
    input: &Value,
    asset: &Value,
    by_id: &BTreeMap<&str, &Value>,
    parents: &BTreeMap<String, Option<String>>,
    known_rows: &HashSet<&str>,
) -> Result<(Vec<Value>, Vec<Value>), String> {
    let identity = asset_identity(asset);
    let owned: Vec<_> = input
        .pointer("/foundation/facts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|fact| text(fact, "assetId") == identity)
        .collect();
    if let Some(fact) = owned.iter().find(|fact| {
        text(fact, "variantId").is_empty() && ["STATE", "TRANSITION"].contains(&text(fact, "scope"))
    }) {
        return Err(format!(
            "{} 的适用形象尚未确定，请先修正制作基础",
            text(fact, "attribute")
        ));
    }
    let mut chain = Vec::new();
    let mut cursor = Some(text(asset, "id"));
    let mut seen = HashSet::new();
    while let Some(id) = cursor {
        if !seen.insert(id) {
            return Err("形象依赖循环，需修订来源关系".into());
        }
        chain.push(*by_id.get(id).ok_or("来源形象不存在")?);
        cursor = parents.get(id).and_then(|parent| parent.as_deref());
    }
    chain.reverse();
    let mut selected: Vec<&Value> = owned
        .iter()
        .copied()
        .filter(|fact| text(fact, "variantId").is_empty() && text(fact, "scope") == "STABLE")
        .collect();
    for version in chain {
        if asset_identity(version) != identity {
            continue;
        }
        let explicit: Vec<_> = owned
            .iter()
            .copied()
            .filter(|fact| text(fact, "variantId") == text(version, "variantId"))
            .collect();
        let attributes: HashSet<_> = explicit
            .iter()
            .map(|fact| text(fact, "attribute"))
            .collect();
        selected.retain(|fact| !attributes.contains(text(fact, "attribute")));
        selected.extend(explicit);
    }
    let mut ids = HashSet::new();
    let mut facts = Vec::new();
    let mut delta = Vec::new();
    for fact in selected {
        let refs = exact_strings(fact, "sourceRefs")?;
        if refs.is_empty() || refs.iter().any(|row| !known_rows.contains(row.as_str())) {
            return Err("视觉事实引用不属于当前锁定原文".into());
        }
        if text(fact, "id").is_empty() || text(fact, "attribute").is_empty() {
            return Err("视觉事实缺少稳定身份或属性".into());
        }
        if !ids.insert(text(fact, "id")) {
            continue;
        }
        let mut fact = fact.clone();
        fact.as_object_mut()
            .ok_or("视觉事实必须为对象")?
            .remove("quotes");
        if text(&fact, "variantId") == text(asset, "variantId") {
            delta.push(fact.clone());
        }
        facts.push(fact);
    }
    Ok((facts, delta))
}

fn has_program_source_scope(asset: &Value) -> bool {
    text(asset, "sourceRefsPurpose") == "SOURCE_SCOPE"
        && asset.pointer("/sourceScope/kind").and_then(Value::as_str) == Some("PROGRAM_SCOPE")
}

const SOURCE_SCOPE_POLICY: &str = "SOURCE_SCOPE/PROGRAM_SCOPE引用仅用于定位原文阅读范围，不是这些行已证明属于该资产的外观事实。facts/deltaFacts才是已按主体和版本登记的视觉提取记录，仍须对照其引用原文；claim保留原层次，CHARACTER_CLAIM不得升级为SOURCE。目录名称、description和preparation.note是身份/制作资料，不自动成为视觉事实；原文中的其它主体和后续状态不得套入当前形象。";

fn asset_design_card(asset: &Value) -> Value {
    let mut card = json!({
        "id":asset["id"],"baseAssetId":asset["baseAssetId"],"variantId":asset["variantId"],
        "name":asset["name"],"kind":asset.get("kind").or_else(||asset.get("type")),
        "description":asset["description"],"sourceRefs":asset["sourceRefs"],
        "scope":asset["scope"],"applicability":asset["applicability"],"preparation":asset["preparation"]
    });
    if has_program_source_scope(asset) {
        card["sourceRefsPurpose"] = asset["sourceRefsPurpose"].clone();
        card["sourceScope"] = asset["sourceScope"].clone();
    }
    card
}

fn reference_design_card(asset: &Value, design: Option<&Value>) -> Value {
    json!({
        "assetId":asset["id"],"variantId":asset["variantId"],"assetVersion":asset["version"],
        "prompt":asset["prompt"],
        "origin":if text(asset,"promptOrigin")=="MANUAL" {"MANUAL"} else if design.is_some() {"AI"} else {"UNVERIFIED"},
        "sourceRefs":design.and_then(|value|value.get("sourceRefs")),
        "evidencePolicy":"已保存来源设计是外观一致性约束，不是新的原文事实；未提供图片像素。"
    })
}

fn reusable_parent_design<'a>(
    asset: &'a Value,
    assets: &[Value],
    source_sha: &str,
    known_rows: &HashSet<&str>,
    evidence_ids: &HashSet<&str>,
    parent: Option<&str>,
) -> Option<&'a Value> {
    let design = asset.get("design")?;
    if text(design, "schemaVersion") != "asset-design/v1"
        || text(design, "sourceSha256") != source_sha
        || text(design, "assetId") != text(asset, "id")
        || text(design, "variantId") != text(asset, "variantId")
        || text(design, "prompt").trim().is_empty()
        || text(design, "prompt") != text(asset, "prompt")
    {
        return None;
    }
    let source_refs = exact_strings(design, "sourceRefs").ok()?;
    if source_refs.is_empty()
        || source_refs
            .iter()
            .any(|r| !known_rows.contains(r.as_str()) || !evidence_ids.contains(r.as_str()))
    {
        return None;
    }
    let references = exact_strings(design, "referenceAssetIds").ok()?;
    let resolved = exact_strings(design, "referenceVariantIds")
        .ok()?
        .iter()
        .map(|r| resolve_reference(assets, asset, r))
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let mut seen = HashSet::new();
    if references != resolved
        || references
            .iter()
            .any(|r| r == text(asset, "id") || !seen.insert(r))
        || parent
            .map(|p| !references.iter().any(|r| r == p))
            .unwrap_or(false)
    {
        return None;
    }
    Some(design)
}

pub async fn run_asset_design(
    input: &Value,
    executor: &dyn TextExecutor,
    model: &str,
    reasoning: &str,
) -> Result<Value, String> {
    let assets = input
        .get("assets")
        .and_then(Value::as_array)
        .ok_or("资产设计输入缺少 assets")?;
    if assets.is_empty() {
        return Err("没有可设计的资产形象".into());
    }
    let source: LockedSource =
        serde_json::from_value(input.get("source").cloned().ok_or("缺少锁定原文")?)
            .map_err(|e| format!("原文结构无效：{e}"))?;
    validate_source(&source)?;
    let known_rows: HashSet<_> = source.rows.iter().map(|r| r.id.as_str()).collect();
    let mut by_id = BTreeMap::new();
    for asset in assets {
        let id = text(asset, "id");
        if id.is_empty() || text(asset, "variantId").is_empty() || by_id.insert(id, asset).is_some()
        {
            return Err("资产形象行 id 为空或重复，不能按姓名推断".into());
        }
    }
    let selected_assets = input
        .pointer("/selection/assetIds")
        .and_then(Value::as_array);
    let selected_variants = input
        .pointer("/selection/variantIds")
        .and_then(Value::as_array);
    let mut wanted: HashSet<String> = assets
        .iter()
        .filter(|a| {
            selected_assets
                .map(|ids| ids.iter().any(|id| id.as_str() == Some(text(a, "id"))))
                .unwrap_or_else(|| {
                    selected_variants
                        .map(|ids| {
                            ids.iter()
                                .any(|id| id.as_str() == Some(text(a, "variantId")))
                        })
                        .unwrap_or(true)
                })
        })
        .map(|a| text(a, "id").to_string())
        .collect();
    let explicitly_selected = wanted.clone();
    let mut parents = BTreeMap::new();
    let mut parent_errors = BTreeMap::new();
    for asset in assets {
        match resolve_asset_dependency(assets, asset) {
            Ok(parent) => {
                parents.insert(text(asset, "id").to_string(), parent);
            }
            Err(reason) => {
                parent_errors.insert(text(asset, "id").to_string(), reason);
            }
        }
    }
    let mut next = wanted.clone();
    while !next.is_empty() {
        let mut added = HashSet::new();
        for id in next {
            if let Some(Some(parent)) = parents.get(&id) {
                if wanted.insert(parent.clone()) {
                    added.insert(parent.clone());
                }
            }
        }
        next = added;
    }
    let visual_assets: Vec<_> = assets
        .iter()
        .filter(|asset| {
            if !wanted.contains(text(asset, "id")) {
                return false;
            }
            let mut seen = HashSet::new();
            let mut cursor = Some(text(asset, "id"));
            while let Some(id) = cursor {
                if !seen.insert(id) || parent_errors.contains_key(id) {
                    return false;
                }
                cursor = parents.get(id).and_then(|p| p.as_deref());
            }
            exact_strings(asset, "sourceRefs")
                .map(|refs| {
                    !refs.is_empty() && refs.iter().all(|row| known_rows.contains(row.as_str()))
                })
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    let visual = if visual_assets.is_empty() {
        json!({"facts":input.pointer("/foundation/facts").cloned().unwrap_or(json!([])),"blocked":[],"visualFactBatches":[]})
    } else {
        let mut visual_input = input.clone();
        visual_input["assets"] = json!(visual_assets);
        super::asset_visual_facts::run_asset_visual_facts(&visual_input, executor, model, reasoning)
            .await?
    };
    let mut design_basis = input.clone();
    if !design_basis["foundation"].is_object() {
        design_basis["foundation"] = json!({});
    }
    design_basis["foundation"]["facts"] = visual["facts"].clone();
    let mut pending: BTreeMap<_, _> = by_id
        .iter()
        .filter(|(key, _)| wanted.contains(**key))
        .map(|(k, v)| ((*k).to_string(), *v))
        .collect();
    let mut blocked = visual["blocked"].as_array().cloned().unwrap_or_default();
    let mut failed: HashSet<String> = blocked
        .iter()
        .map(|item| text(item, "assetId").to_string())
        .collect();
    pending.retain(|id, _| !failed.contains(id));
    let mut designs: Vec<Value> = Vec::new();
    let mut available_designs: BTreeMap<String, Value> = BTreeMap::new();
    while !pending.is_empty() {
        let mut progress = false;
        let keys: Vec<_> = pending.keys().cloned().collect();
        for id in keys {
            let asset = pending[&id];
            let variant = text(asset, "variantId");
            let parent = parents.get(&id).and_then(|p| p.as_deref());
            if let Some(reason) = parent_errors.get(&id) {
                blocked.push(json!({"assetId":id,"variantId":variant,"reason":reason}));
                failed.insert(id.clone());
                pending.remove(&id);
                progress = true;
                continue;
            }
            if let Some(parent) = parent {
                if failed.contains(parent) {
                    blocked.push(json!({"assetId":id,"variantId":variant,"reason":"来源形象设计失败","sourceAssetId":parent}));
                    failed.insert(id.clone());
                    pending.remove(&id);
                    progress = true;
                    continue;
                }
                if pending.contains_key(parent) {
                    continue;
                }
            }
            if !explicitly_selected.contains(&id) && !text(asset, "prompt").trim().is_empty() {
                let manual = text(asset, "promptOrigin") == "MANUAL";
                let no_ai_design = asset.get("design").map(Value::is_null).unwrap_or(true);
                if manual || no_ai_design {
                    // A direct saved reference is usable without pretending it is
                    // an accepted AI result. Never rewrite an implicit dependency.
                    available_designs.insert(id.clone(), reference_design_card(asset, None));
                    pending.remove(&id);
                    progress = true;
                    continue;
                }
            }
            let source_refs = match exact_strings(asset, "sourceRefs") {
                Ok(refs)
                    if !refs.is_empty() && refs.iter().all(|r| known_rows.contains(r.as_str())) =>
                {
                    refs
                }
                _ => {
                    blocked.push(json!({"assetId":id,"variantId":variant,"reason":"形象缺少当前锁定来源引用"}));
                    failed.insert(id.clone());
                    pending.remove(&id);
                    progress = true;
                    continue;
                }
            };
            let (facts, delta_facts) =
                match design_facts(&design_basis, asset, &by_id, &parents, &known_rows) {
                    Ok(facts) => facts,
                    Err(reason) => {
                        blocked.push(json!({"assetId":id,"variantId":variant,"reason":reason}));
                        failed.insert(id.clone());
                        pending.remove(&id);
                        progress = true;
                        continue;
                    }
                };
            let mut evidence_ids: HashSet<&str> = source_refs.iter().map(String::as_str).collect();
            for fact in &facts {
                if let Some(rs) = fact.get("sourceRefs").and_then(Value::as_array) {
                    for r in rs.iter().filter_map(Value::as_str) {
                        evidence_ids.insert(r);
                    }
                }
            }
            if !explicitly_selected.contains(&id) {
                if let Some(design) = reusable_parent_design(
                    asset,
                    assets,
                    &source.sha256,
                    &known_rows,
                    &evidence_ids,
                    parent,
                ) {
                    available_designs
                        .insert(id.clone(), reference_design_card(asset, Some(design)));
                    pending.remove(&id);
                    progress = true;
                    continue;
                }
                if !text(asset, "prompt").trim().is_empty() {
                    blocked.push(json!({"assetId":id,"variantId":variant,"reason":"来源形象的旧自动设计已失效，请先核对或明确重新设计；当前提示词已保留"}));
                    failed.insert(id.clone());
                    pending.remove(&id);
                    progress = true;
                    continue;
                }
            }
            let evidence: Vec<_> = source
                .rows
                .iter()
                .filter(|r| evidence_ids.contains(r.id.as_str()))
                .collect();
            let parent_design = parent.and_then(|p| available_designs.get(p));
            let mode = if parent.is_some() { "DERIVED" } else { "BASE" };
            let production_direction = input
                .pointer("/foundation/directionConfirmed")
                .and_then(Value::as_bool)
                .filter(|confirmed| *confirmed)
                .and_then(|_| input.pointer("/foundation/productionDirection"));
            let allowed_references: Vec<String> = parent.into_iter().map(str::to_string).collect();
            let output_schema = obj(
                json!({"schemaVersion":choices(&["asset-design/v1"]),"assetId":{"type":"string","enum":[id]},"variantId":{"type":"string","enum":[variant]},"prompt":string(),"freeDesignScope":string(),"sourceRefs":refs(&evidence.iter().map(|r|r.id.clone()).collect::<Vec<_>>()),"referenceVariantIds":refs(&allowed_references)}),
            );
            let mut design_input = json!({"sourceSha256":source.sha256,"designMode":mode,"asset":asset_design_card(asset),"facts":facts,"deltaFacts":delta_facts,"evidence":evidence,"parentDesign":parent_design,"parentAsset":parent.and_then(|p|by_id.get(p)).map(|asset|asset_design_card(asset)),"referenceCatalog":parent.and_then(|p|by_id.get(p)).map(|asset|vec![asset_design_card(asset)]).unwrap_or_default(),"productionDirection":production_direction,"imageEvidence":"NO_PIXELS_READ","instruction":"执行designMode确定的C基础/D派生岗位。referenceVariantIds只使用指定直接来源资产行id；基础形象为空。名称只作显示，不推断身份。原文仅在evidence物化一次；facts与deltaFacts不重抄原句。未提供当前旧提示词与历史候选，不以历史代替证据。"});
            if has_program_source_scope(asset)
                || parent
                    .and_then(|id| by_id.get(id))
                    .is_some_and(|asset| has_program_source_scope(asset))
            {
                design_input["sourceEvidencePolicy"] = json!(SOURCE_SCOPE_POLICY);
                let scope_ids: HashSet<_> = if has_program_source_scope(asset) {
                    source_refs.iter().map(String::as_str).collect()
                } else {
                    HashSet::new()
                };
                let fact_ids: HashSet<_> = design_input["facts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .flat_map(|fact| {
                        fact["sourceRefs"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                    })
                    .map(str::to_string)
                    .collect();
                for row in design_input["evidence"]
                    .as_array_mut()
                    .into_iter()
                    .flatten()
                {
                    let id = text(row, "id");
                    let mut uses = Vec::new();
                    if scope_ids.contains(id) {
                        uses.push("SOURCE_SCOPE");
                    }
                    if fact_ids.contains(id) {
                        uses.push("VISUAL_FACT_REFERENCE");
                    }
                    row["evidenceUses"] = json!(uses);
                }
            }
            let fingerprint = digest(&serde_json::to_string(&design_input).unwrap());
            let response = call_validated(
                executor,
                "assetDesign",
                "asset-art-director",
                model,
                reasoning,
                design_input,
                output_schema,
                &[],
                |output| {
                    if text(output, "schemaVersion") != "asset-design/v1"
                        || text(output, "assetId") != id
                        || text(output, "variantId") != variant
                        || text(output, "prompt").trim().is_empty()
                        || text(output, "prompt").chars().count() > 14_000
                        || output
                            .get("freeDesignScope")
                            .and_then(Value::as_str)
                            .is_none()
                    {
                        return Err("模型回包身份不匹配或缺少有效提示词".into());
                    }
                    let rs = exact_strings(output, "sourceRefs")?;
                    let mut seen_refs = HashSet::new();
                    if rs.is_empty()
                        || rs
                            .iter()
                            .any(|r| !evidence_ids.contains(r.as_str()) || !seen_refs.insert(r))
                    {
                        return Err("资产设计引用越出当前提供源证据或重复".into());
                    }
                    let resolved = exact_strings(output, "referenceVariantIds")?
                        .iter()
                        .map(|r| resolve_reference(assets, asset, r))
                        .collect::<Result<Vec<_>, _>>()?;
                    if resolved != allowed_references {
                        return Err("图片依赖必须与指定直接来源一致，不能扩大或省略".into());
                    }
                    let map = output.as_object_mut().ok_or("资产设计回包必须为对象")?;
                    map.insert("referenceAssetIds".into(), json!(resolved));
                    map.insert("sourceSha256".into(), json!(source.sha256));
                    map.insert("status".into(), json!("candidate"));
                    map.insert("designMode".into(), json!(mode));
                    map.insert("inputFingerprint".into(), json!(fingerprint));
                    Ok(())
                },
            )
            .await;
            match response {
                Ok(output) => {
                    let mut updated_asset = (*asset).clone();
                    updated_asset["prompt"] = output["prompt"].clone();
                    updated_asset["promptOrigin"] = json!("AI");
                    available_designs.insert(
                        id.clone(),
                        reference_design_card(&updated_asset, Some(&output)),
                    );
                    designs.push(output);
                }
                Err(reason) => {
                    blocked.push(json!({"assetId":id,"variantId":variant,"reason":reason}));
                    failed.insert(id.clone());
                }
            }
            pending.remove(&id);
            progress = true;
        }
        if !progress {
            for (id, asset) in &pending {
                blocked.push(json!({"assetId":id,"variantId":text(asset,"variantId"),"reason":"形象依赖循环，需修订来源关系"}));
            }
            break;
        }
    }
    let trial_approved = input
        .pointer("/settings/trialApproved")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let image_plan:Vec<_>=designs.iter().map(|design|{let id=text(design,"assetId");let dependencies=design["referenceAssetIds"].clone();let missing:Vec<_>=dependencies.as_array().unwrap().iter().filter_map(Value::as_str).filter(|parent|by_id.get(parent).and_then(|a|a.get("adoptedMediaId")).and_then(Value::as_str).map(|id|id.is_empty()).unwrap_or(true)).collect();json!({"assetId":id,"variantId":design["variantId"],"dependencies":dependencies,"prompt":design["prompt"],"status":if !trial_approved{"awaitingTrial"}else if !missing.is_empty(){"waitingAdoption"}else{"ready"},"missingAdoption":missing,"candidateCount":if trial_approved{input.pointer("/settings/imageCount").and_then(Value::as_u64).unwrap_or(1)}else{1}})}).collect();
    let updated: Vec<_> = designs
        .iter()
        .map(|design| {
            let mut asset = (*by_id[text(design, "assetId")]).clone();
            asset["prompt"] = design["prompt"].clone();
            asset["promptOrigin"] = json!("AI");
            asset["designStatus"] = json!("candidate");
            asset["design"] = design.clone();
            if let Some(Some(parent)) = parents.get(text(design, "assetId")) {
                asset["sourceAssetId"] = json!(parent);
            }
            asset
        })
        .collect();
    Ok(
        json!({"schemaVersion":"asset-design-batch/v1","sourceSha256":source.sha256,"assets":updated,"designs":designs,"imagePlan":image_plan,"facts":visual["facts"],"visualFactBatches":visual["visualFactBatches"],"blocked":blocked,"trialApproved":trial_approved,"ruleSnapshots":[rule_snapshot("asset-visual-facts-extractor")?,rule_snapshot("asset-art-director")?,rule_snapshot("asset-image-production")?]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn empty_visual(request: &TextRequest) -> Value {
        json!({"schemaVersion":"asset-visual-facts/v1","coveredRowIds":request.input["rows"].as_array().unwrap().iter().map(|row|row["id"].clone()).collect::<Vec<_>>(),"facts":[],"issues":[]})
    }
    struct Never;
    #[async_trait]
    impl TextExecutor for Never {
        async fn execute(&self, _request: TextRequest) -> Result<Value, String> {
            panic!("循环/缺失来源不得调用模型")
        }
    }
    #[tokio::test]
    async fn cyclic_or_missing_dependency_blocks_locally_without_model_call() {
        let s = prepare_source("第一集\n场景：门口\n△小王出现。\n").unwrap();
        let row = &s.rows[2].id;
        let result=run_asset_design(&json!({"source":s,"assets":[{"id":"a:1","variantId":"a1","sourceVariantId":"a2","sourceRefs":[row]},{"id":"a:2","variantId":"a2","sourceVariantId":"a1","sourceRefs":[row]},{"id":"b:1","variantId":"b1","sourceVariantId":"missing","sourceRefs":[row]}]}),&Never,"gpt-6.1-sol","medium").await.unwrap();
        assert_eq!(result["blocked"].as_array().unwrap().len(), 3);
        assert!(result["designs"].as_array().unwrap().is_empty());
    }
    #[test]
    fn repeated_base_variant_resolves_by_subject_or_explicit_identity() {
        let assets = vec![
            json!({"id":"王:base","baseAssetId":"王","variantId":"base"}),
            json!({"id":"李:base","baseAssetId":"李","variantId":"base"}),
            json!({"id":"王:伤态","baseAssetId":"王","variantId":"hurt","sourceVariantId":"base"}),
        ];
        assert_eq!(
            resolve_asset_dependency(&assets, &assets[2]).unwrap(),
            Some("王:base".into())
        );
        assert!(resolve_asset_dependency(
            &assets,
            &json!({"id":"new","variantId":"legacy","sourceVariantId":"base"})
        )
        .is_err());
        assert_eq!(
            resolve_asset_dependency(
                &assets,
                &json!({"id":"new","variantId":"legacy","sourceAssetId":"李:base"})
            )
            .unwrap(),
            Some("李:base".into())
        );
    }
    struct Designer;
    #[async_trait]
    impl TextExecutor for Designer {
        async fn execute(&self, request: TextRequest) -> Result<Value, String> {
            if request.stage == "assetVisualFacts" {
                return Ok(empty_visual(&request));
            }
            let asset = &request.input["asset"];
            Ok(
                json!({"schemaVersion":"asset-design/v1","assetId":asset["id"],"variantId":asset["variantId"],"prompt":format!("{}全身设定图，白衣，纯色背景。",text(asset,"name")),"freeDesignScope":"背景灰度","sourceRefs":asset["sourceRefs"],"referenceVariantIds":[]}),
            )
        }
    }
    #[tokio::test]
    async fn multiple_legacy_or_base_variants_are_designed_as_distinct_assets() {
        let s = prepare_source("第一集\n场景：门口\n△小王和小李穿白衣出现。\n").unwrap();
        let row = &s.rows[2].id;
        let result=run_asset_design(&json!({"source":s,"assets":[{"id":"a","variantId":"base","name":"小王","sourceRefs":[row]},{"id":"b","variantId":"base","name":"小李","sourceRefs":[row]}]}),&Designer,"gpt-6.1-sol","medium").await.unwrap();
        assert!(result["blocked"].as_array().unwrap().is_empty());
        assert_eq!(result["designs"].as_array().unwrap().len(), 2);
        assert_ne!(result["assets"][0]["id"], result["assets"][1]["id"]);
        assert!(result["imagePlan"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["status"] == "awaitingTrial"));
    }
    struct CountingDesigner {
        requests: std::sync::Mutex<Vec<Value>>,
    }
    #[async_trait]
    impl TextExecutor for CountingDesigner {
        async fn execute(&self, request: TextRequest) -> Result<Value, String> {
            if request.stage == "assetVisualFacts" {
                return Ok(empty_visual(&request));
            }
            self.requests.lock().unwrap().push(request.input.clone());
            let asset = &request.input["asset"];
            let references = request.input["parentAsset"]["id"]
                .as_str()
                .map(|id| vec![id])
                .unwrap_or_default();
            Ok(
                json!({"schemaVersion":"asset-design/v1","assetId":asset["id"],"variantId":asset["variantId"],"prompt":"新设计完整提示词","freeDesignScope":"背景灰度","sourceRefs":asset["sourceRefs"],"referenceVariantIds":references}),
            )
        }
    }
    #[tokio::test]
    async fn designing_only_a_missing_child_reuses_the_valid_parent_without_returning_a_parent_update(
    ) {
        let source =
            prepare_source("第一集\n场景：门口\n△小王穿白衣出现，随后衣服破损。\n").unwrap();
        let row = source.rows[2].id.clone();
        let design = json!({"schemaVersion":"asset-design/v1","assetId":"parent","variantId":"base","sourceSha256":source.sha256,"prompt":"已确认白衣完整设定","sourceRefs":[row],"referenceVariantIds":[],"referenceAssetIds":[]});
        let parent = json!({"id":"parent","baseAssetId":"person","variantId":"base","version":7,"prompt":"已确认白衣完整设定","sourceRefs":[row],"design":design});
        let child = json!({"id":"child","baseAssetId":"person","variantId":"hurt","prompt":"","sourceAssetId":"parent","sourceRefs":[row]});
        let mut input =
            json!({"source":source,"assets":[parent,child],"selection":{"assetIds":["child"]}});
        let executor = CountingDesigner {
            requests: std::sync::Mutex::new(Vec::new()),
        };
        let result = run_asset_design(&input, &executor, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert!(result["blocked"].as_array().unwrap().is_empty());
        assert_eq!(executor.requests.lock().unwrap().len(), 1);
        assert_eq!(
            executor.requests.lock().unwrap()[0]["parentDesign"]["prompt"],
            design["prompt"]
        );
        assert_eq!(
            executor.requests.lock().unwrap()[0]["parentDesign"]["origin"],
            "AI"
        );
        assert_eq!(
            executor.requests.lock().unwrap()[0]["parentDesign"]["assetId"],
            "parent"
        );
        assert_eq!(input["assets"][0], parent);
        for key in ["assets", "designs", "imagePlan"] {
            assert_eq!(result[key].as_array().unwrap().len(), 1);
        }
        assert_eq!(result["assets"][0]["id"], "child");
        assert_eq!(result["designs"][0]["referenceAssetIds"], json!(["parent"]));
        input["selection"]["assetIds"] = json!(["parent"]);
        let explicit = run_asset_design(&input, &executor, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(executor.requests.lock().unwrap().len(), 2);
        assert_eq!(explicit["assets"][0]["id"], "parent");
    }

    fn visual_fact(
        id: &str,
        subject: &str,
        variant: Option<&str>,
        attribute: &str,
        value: &str,
        scope: &str,
        row: &str,
    ) -> Value {
        json!({"id":id,"assetId":subject,"variantId":variant,"attribute":attribute,"value":value,"scope":scope,"claim":"SOURCE","sourceRefs":[row],"quotes":["不能发回模型的重复原文"]})
    }

    #[test]
    fn legacy_exact_reference_cards_keep_their_existing_wire_shape() {
        let legacy = json!({"id":"row-a","baseAssetId":"person","variantId":"base","name":"小王","kind":"CH","sourceRefs":["exact-row"]});
        assert_eq!(
            asset_design_card(&legacy),
            json!({
                "id":"row-a","baseAssetId":"person","variantId":"base","name":"小王","kind":"CH",
                "description":null,"sourceRefs":["exact-row"],"scope":null,"applicability":null,"preparation":null
            })
        );
        assert!(!has_program_source_scope(&legacy));
    }

    struct ScopeDesigner {
        requests: std::sync::Mutex<Vec<Value>>,
    }
    #[async_trait]
    impl TextExecutor for ScopeDesigner {
        async fn execute(&self, request: TextRequest) -> Result<Value, String> {
            if request.stage != "assetDesign" {
                return Err("已有有效事实，本测试不得新增视觉提取或其它模型调用".into());
            }
            self.requests.lock().unwrap().push(request.input.clone());
            let asset = &request.input["asset"];
            let references = request.input["parentAsset"]["id"]
                .as_str()
                .map(|id| vec![id])
                .unwrap_or_default();
            Ok(
                json!({"schemaVersion":"asset-design/v1","assetId":asset["id"],"variantId":asset["variantId"],"prompt":"原文约束与可编辑设计","freeDesignScope":"未限定的背景灰度","sourceRefs":asset["sourceRefs"],"referenceVariantIds":references}),
            )
        }
    }

    #[tokio::test]
    async fn program_scope_is_labeled_in_base_and_derived_inputs_without_becoming_facts() {
        let source = prepare_source(
            "第一集\n场景：门口\n△小王黑发白衣，小李穿红衣。\n小李：小王的右手受伤了。\n",
        )
        .unwrap();
        let appearance = source
            .rows
            .iter()
            .find(|row| row.text.contains("小王黑发"))
            .unwrap();
        let claim = source
            .rows
            .iter()
            .find(|row| row.text.contains("右手受伤"))
            .unwrap();
        let scope_refs: Vec<_> = source
            .rows
            .iter()
            .filter(|row| row.scene_id == appearance.scene_id)
            .map(|row| row.id.clone())
            .collect();
        let scope = json!({"sourceSha256":source.sha256,"kind":"PROGRAM_SCOPE"});
        let mut hurt = visual_fact(
            "hurt",
            "person",
            Some("hurt"),
            "右手",
            "伤口",
            "STATE",
            &claim.id,
        );
        hurt["claim"] = json!("CHARACTER_CLAIM");
        let facts = json!([
            visual_fact(
                "hair",
                "person",
                Some("base"),
                "头发",
                "黑发",
                "STABLE",
                &appearance.id
            ),
            hurt,
            visual_fact(
                "other",
                "other-person",
                Some("base"),
                "衣服",
                "红衣",
                "STATE",
                &appearance.id
            )
        ]);
        let assets = json!([
            {"id":"base-row","baseAssetId":"person","variantId":"base","name":"小王基础形象","prompt":"已保存基础设计","promptOrigin":"MANUAL","sourceRefs":scope_refs,"sourceRefsPurpose":"SOURCE_SCOPE","sourceScope":scope},
            {"id":"hurt-row","baseAssetId":"person","variantId":"hurt","name":"小王伤态","sourceAssetId":"base-row","sourceRefs":scope_refs,"sourceRefsPurpose":"SOURCE_SCOPE","sourceScope":scope}
        ]);
        let executor = ScopeDesigner {
            requests: std::sync::Mutex::new(Vec::new()),
        };
        for (selected, mode, expected_ids) in [
            ("base-row", "BASE", vec!["hair"]),
            ("hurt-row", "DERIVED", vec!["hair", "hurt"]),
        ] {
            let input = json!({"source":source,"assets":assets,"selection":{"assetIds":[selected]},"foundation":{"sourceSha256":source.sha256,"facts":facts}});
            let before = executor.requests.lock().unwrap().len();
            let result = run_asset_design(&input, &executor, "gpt-6.1-sol", "medium")
                .await
                .unwrap();
            assert!(result["blocked"].as_array().unwrap().is_empty(), "{result}");
            assert_eq!(result["facts"], facts);
            let requests = executor.requests.lock().unwrap();
            assert_eq!(requests.len(), before + 1);
            let request = requests.last().unwrap();
            assert_eq!(request["designMode"], mode);
            assert_eq!(request["asset"]["sourceRefsPurpose"], "SOURCE_SCOPE");
            assert_eq!(request["asset"]["sourceScope"], scope);
            assert!(request["sourceEvidencePolicy"]
                .as_str()
                .unwrap()
                .contains("不是这些行已证明属于该资产的外观事实"));
            let ids: Vec<_> = request["facts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|fact| text(fact, "id"))
                .collect();
            assert_eq!(ids, expected_ids);
            assert!(request["facts"]
                .as_array()
                .unwrap()
                .iter()
                .all(|fact| text(fact, "assetId") == "person"));
            assert!(request["evidence"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["evidenceUses"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("SOURCE_SCOPE"))));
            let referenced = request["evidence"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == appearance.id)
                .unwrap();
            assert!(referenced["evidenceUses"]
                .as_array()
                .unwrap()
                .contains(&json!("VISUAL_FACT_REFERENCE")));
            if mode == "DERIVED" {
                assert_eq!(request["parentAsset"]["sourceScope"], scope);
                assert_eq!(
                    request["referenceCatalog"][0]["sourceRefsPurpose"],
                    "SOURCE_SCOPE"
                );
                assert_eq!(request["deltaFacts"][0]["variantId"], "hurt");
                assert_eq!(request["deltaFacts"][0]["claim"], "CHARACTER_CLAIM");
            } else {
                assert!(request["facts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|fact| fact["variantId"] == "base"));
            }
        }
        assert_eq!(executor.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn derived_input_inherits_only_its_ancestors_and_replaces_explicit_attributes() {
        let source = prepare_source("第一集\n场景：门口\n△小王黑发白衣，换蓝衣后右手受伤。\n第二集\n场景：河边\n△小王穿红衣出现。\n").unwrap();
        let row = source.rows[2].id.clone();
        let future_row = source.rows[5].id.clone();
        let assets = json!([
            {"id":"base","baseAssetId":"person","variantId":"base","prompt":"手写黑发白衣","promptOrigin":"MANUAL","sourceRefs":[row]},
            {"id":"blue","baseAssetId":"person","variantId":"blue","prompt":"手写蓝衣","sourceAssetId":"base","sourceRefs":[row]},
            {"id":"hurt","baseAssetId":"person","variantId":"hurt","prompt":"不能当新事实的旧提示词","sourceAssetId":"blue","sourceRefs":[row],"design":{"oldHistory":"不要发送"},"candidates":[{"private":"不要发送"}]}
        ]);
        let input = json!({"source":source,"assets":assets,"selection":{"assetIds":["hurt"]},"foundation":{"directionConfirmed":true,"productionDirection":"3D漫剧的克制写实表达","facts":[
            visual_fact("hair","person",None,"头发","黑发","STABLE",&row),
            visual_fact("white","person",Some("base"),"衣服","白衣","STABLE",&row),
            visual_fact("blue","person",Some("blue"),"衣服","蓝衣","STATE",&row),
            visual_fact("hurt","person",Some("hurt"),"右手","伤口","STATE",&row),
            visual_fact("future","person",Some("future"),"衣服","红衣","STATE",&future_row),
            visual_fact("other","other-person",Some("hurt"),"头发","红发","STABLE",&row)
        ]}});
        let executor = CountingDesigner {
            requests: std::sync::Mutex::new(Vec::new()),
        };
        let result = run_asset_design(&input, &executor, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert!(result["blocked"].as_array().unwrap().is_empty());
        let requests = executor.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request["designMode"], "DERIVED");
        assert_eq!(request["parentDesign"]["assetId"], "blue");
        assert_eq!(request["parentDesign"]["prompt"], "手写蓝衣");
        assert_eq!(request["parentDesign"]["origin"], "UNVERIFIED");
        assert_eq!(request["productionDirection"], "3D漫剧的克制写实表达");
        let ids: Vec<_> = request["facts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|fact| text(fact, "id"))
            .collect();
        assert_eq!(ids, vec!["hair", "blue", "hurt"]);
        assert_eq!(request["deltaFacts"][0]["id"], "hurt");
        assert_eq!(request["deltaFacts"].as_array().unwrap().len(), 1);
        assert!(request["facts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|fact| fact.get("quotes").is_none()));
        assert_eq!(request["evidence"].as_array().unwrap().len(), 1);
        assert!(request["asset"].get("prompt").is_none());
        assert!(request["asset"].get("design").is_none());
        assert!(request["asset"].get("candidates").is_none());
        assert_eq!(request["referenceCatalog"].as_array().unwrap().len(), 1);
        assert_eq!(result["assets"][0]["promptOrigin"], "AI");
    }

    #[tokio::test]
    async fn manual_parent_without_ai_design_or_source_facts_stays_a_direct_reference() {
        let source = prepare_source("第一集\n场景：门口\n△小王衣服破损。\n").unwrap();
        let row = source.rows[2].id.clone();
        let parent = json!({"id":"parent","variantId":"base","prompt":"用户确认手写服装设计","promptOrigin":"MANUAL"});
        let input = json!({"source":source,"assets":[parent,{"id":"child","variantId":"hurt","sourceAssetId":"parent","sourceRefs":[row]}],"selection":{"assetIds":["child"]},"foundation":{"directionConfirmed":false,"productionDirection":"尚未确认方向"}});
        let executor = CountingDesigner {
            requests: std::sync::Mutex::new(Vec::new()),
        };
        let result = run_asset_design(&input, &executor, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert!(result["blocked"].as_array().unwrap().is_empty());
        assert_eq!(executor.requests.lock().unwrap().len(), 1);
        assert_eq!(
            executor.requests.lock().unwrap()[0]["parentDesign"]["origin"],
            "MANUAL"
        );
        assert!(executor.requests.lock().unwrap()[0]["productionDirection"].is_null());
        assert_eq!(result["assets"].as_array().unwrap().len(), 1);
        assert_eq!(result["assets"][0]["id"], "child");
        assert_eq!(input["assets"][0], parent);
    }

    #[tokio::test]
    async fn stale_implicit_ai_parent_is_preserved_and_only_its_dependents_block() {
        let source = prepare_source("第一集\n场景：门口\n△小王与小李出现。\n").unwrap();
        let row = source.rows[2].id.clone();
        let parent = json!({"id":"parent","variantId":"base","prompt":"旧自动设计不得隐式覆盖","sourceRefs":[row],"design":{"sourceSha256":"stale","prompt":"旧自动设计不得隐式覆盖"}});
        let input = json!({"source":source,"assets":[parent,{"id":"child","variantId":"hurt","sourceAssetId":"parent","sourceRefs":[row]},{"id":"unrelated","variantId":"base","sourceRefs":[row]}],"selection":{"assetIds":["child","unrelated"]}});
        let executor = CountingDesigner {
            requests: std::sync::Mutex::new(Vec::new()),
        };
        let result = run_asset_design(&input, &executor, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(result["blocked"].as_array().unwrap().len(), 2);
        assert_eq!(result["designs"].as_array().unwrap().len(), 1);
        assert_eq!(result["designs"][0]["assetId"], "unrelated");
        assert_eq!(executor.requests.lock().unwrap().len(), 1);
        assert_eq!(input["assets"][0], parent);
    }

    #[tokio::test]
    async fn unresolved_state_and_invalid_fact_rows_do_not_call_the_model() {
        let source = prepare_source("第一集\n场景：门口\n△小王出现。\n").unwrap();
        let row = source.rows[2].id.clone();
        for fact in [
            visual_fact("unresolved", "person", None, "衣服", "伤态", "STATE", &row),
            visual_fact(
                "bad-source",
                "person",
                Some("base"),
                "衣服",
                "蓝衣",
                "STABLE",
                "unknown-row",
            ),
        ] {
            let input = json!({"source":source,"assets":[{"id":"a","baseAssetId":"person","variantId":"base","sourceRefs":[row]}],"foundation":{"facts":[fact]}});
            let result = run_asset_design(&input, &Never, "gpt-6.1-sol", "medium")
                .await
                .unwrap();
            assert_eq!(result["blocked"].as_array().unwrap().len(), 1);
            assert!(result["designs"].as_array().unwrap().is_empty());
        }
    }

    struct ValidatedDesigner {
        invalid: &'static str,
        accepted: std::sync::Mutex<Vec<Value>>,
        rejected: std::sync::Mutex<Vec<String>>,
    }
    #[async_trait]
    impl TextExecutor for ValidatedDesigner {
        async fn execute(&self, request: TextRequest) -> Result<Value, String> {
            if request.stage == "assetVisualFacts" {
                return Ok(empty_visual(&request));
            }
            assert!(request.rule_snapshot["primary"]["content"]
                .as_str()
                .unwrap()
                .contains("# C 岗：基础资产形象设计"));
            assert!(request.rule_snapshot["primary"]["content"]
                .as_str()
                .unwrap()
                .contains("# D 岗：派生形象图生图变化说明"));
            let asset = &request.input["asset"];
            Ok(
                json!({"schemaVersion":"asset-design/v1","assetId":if self.invalid=="identity"{"wrong"}else{text(asset,"id")},"variantId":asset["variantId"],"prompt":"完整资产外观","freeDesignScope":"非剧情背景补足","sourceRefs":if self.invalid=="source"{json!(["unknown-row"])}else{asset["sourceRefs"].clone()},"referenceVariantIds":if self.invalid=="reference"{json!([text(asset,"id")])}else{json!([])}}),
            )
        }
        async fn accept(&self, request: &TextRequest, value: &Value) -> Result<(), String> {
            if request.stage == "assetDesign" {
                self.accepted.lock().unwrap().push(value.clone());
            }
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
    #[tokio::test]
    async fn output_is_accepted_only_after_identity_source_and_dependency_validation() {
        let source = prepare_source("第一集\n场景：门口\n△小王出现。\n").unwrap();
        let row = source.rows[2].id.clone();
        let input =
            json!({"source":source,"assets":[{"id":"a","variantId":"base","sourceRefs":[row]}]});
        for invalid in ["identity", "source", "reference", ""] {
            let executor = ValidatedDesigner {
                invalid,
                accepted: std::sync::Mutex::new(Vec::new()),
                rejected: std::sync::Mutex::new(Vec::new()),
            };
            let result = run_asset_design(&input, &executor, "gpt-6.1-sol", "medium")
                .await
                .unwrap();
            assert_eq!(
                executor.accepted.lock().unwrap().len(),
                usize::from(invalid.is_empty())
            );
            assert_eq!(
                executor.rejected.lock().unwrap().len(),
                usize::from(!invalid.is_empty())
            );
            assert_eq!(
                result["blocked"].as_array().unwrap().len(),
                usize::from(!invalid.is_empty())
            );
            if invalid.is_empty() {
                let accepted = executor.accepted.lock().unwrap();
                assert_eq!(accepted[0]["sourceSha256"], source.sha256);
                assert_eq!(accepted[0]["designMode"], "BASE");
                assert_eq!(accepted[0]["referenceAssetIds"], json!([]));
                assert!(!text(&accepted[0], "inputFingerprint").is_empty());
            }
        }
        let missing_parent = json!({"source":source,"assets":[{"id":"parent","variantId":"base","prompt":"手写来源"},{"id":"child","variantId":"hurt","sourceAssetId":"parent","sourceRefs":[row]}],"selection":{"assetIds":["child"]}});
        let executor = ValidatedDesigner {
            invalid: "",
            accepted: std::sync::Mutex::new(Vec::new()),
            rejected: std::sync::Mutex::new(Vec::new()),
        };
        let result = run_asset_design(&missing_parent, &executor, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(executor.accepted.lock().unwrap().len(), 0);
        assert_eq!(executor.rejected.lock().unwrap().len(), 1);
        assert_eq!(result["blocked"].as_array().unwrap().len(), 1);
    }
}
