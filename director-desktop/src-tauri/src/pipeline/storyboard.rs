use super::*;
use std::collections::{HashMap, HashSet};
#[path = "storyboard_original.rs"]
mod original;

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn strings(value: &Value, key: &str) -> Result<Vec<String>, String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("缺少数组 {key}"))?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("{key} 包含非字符串引用"))
        })
        .collect()
}
fn emotion_schema() -> Value {
    obj(
        json!({"subject":string(),"contextTone":string(),"audienceEffect":string(),"change":string(),"landing":string(),"retain":array(string())}),
    )
}
fn boundary_schema() -> Value {
    obj(
        json!({"kind":choices(&["episode_start","continuous","capacity","new_event","time_space_jump"]),"reason":string()}),
    )
}

fn plan_schema(
    rows: &[SourceRow],
    context: &[SourceRow],
    scenes: &[SourceScene],
    fantasy_mode: &str,
) -> Value {
    let source_ids: Vec<_> = rows.iter().map(|r| r.id.clone()).collect();
    let all_ids: Vec<_> = rows.iter().chain(context).map(|r| r.id.clone()).collect();
    let scene_ids: Vec<_> = scenes.iter().map(|s| s.id.clone()).collect();
    let fantasy = obj(
        json!({"id":string(),"sourceRefs":refs(&source_ids),"subject":string(),"emotionPurpose":string(),"recommended":{"type":"boolean"},"proposal":string(),"screenSecondsRange":{"type":"array","items":{"type":"number","minimum":0},"minItems":2,"maxItems":2},"extraSecondsRange":{"type":"array","items":{"type":"number","minimum":0},"minItems":2,"maxItems":2}}),
    );
    obj(
        json!({"schemaVersion":choices(&["storyboard-plan/v2"]),"unitPackingPolicy":choices(&["event-first-v1"]),"emotionArc":string(),
            "events":array(obj(json!({"id":string(),"sceneId":{"type":"string","enum":scene_ids},"sourceRefs":refs(&source_ids),"boundaryBefore":boundary_schema(),"emotionContract":emotion_schema()}))),
            "workPackages":array(obj(json!({"id":string(),"eventId":string(),"sourceRefs":refs(&source_ids),"contextRefs":refs(&all_ids),"entryFactIds":array(string()),"dependsOn":array(string()),"scenarioKeys":array(choices(original::SCENARIO_KEYS)),"emotionContract":emotion_schema()}))),
            "provisionalUnits":array(obj(json!({"id":string(),"packageId":string(),"sourceRefs":refs(&source_ids),"secondsRange":{"type":"array","items":{"type":"number","exclusiveMinimum":0},"minItems":2,"maxItems":2}}))),
            "entryFacts":array(obj(json!({"id":string(),"subject":string(),"statement":string(),"sourceRefs":refs(&all_ids),"evidenceMode":choices(&["source_rows"])}))),
            "fantasyCandidates":if fantasy_mode=="off"{json!({"type":"array","items":fantasy,"maxItems":0})}else{array(fantasy)}
        }),
    )
}

fn draft_schema(
    rows: &[SourceRow],
    context: &[SourceRow],
    assets: &[Value],
    event_ids: &[String],
    episode_id: &str,
) -> Value {
    let source_ids: Vec<_> = rows.iter().map(|r| r.id.clone()).collect();
    let all_ids: Vec<_> = rows.iter().chain(context).map(|r| r.id.clone()).collect();
    let dialogue_ids: Vec<_> = rows
        .iter()
        .filter_map(|r| r.dialogue.as_ref().map(|q| q.id.clone()))
        .collect();
    let asset_ids: Vec<_> = assets
        .iter()
        .filter_map(|a| a.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let variant_ids: Vec<_> = assets
        .iter()
        .filter_map(|a| {
            a.get("variantId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    let dialogue = obj(
        json!({"lineId":if dialogue_ids.is_empty(){string()}else{json!({"type":"string","enum":dialogue_ids})},"quoteStart":{"type":"integer","minimum":0},"quoteEnd":{"type":"integer","minimum":1},"presentation":choices(&["画内","画外","VO","OS","系统音","画外转画内","画内转画外"]),"delivery":string(),"voiceStart":{"type":"number"},"voiceEnd":{"type":"number"}}),
    );
    let shot = obj(
        json!({"id":string(),"duration":{"type":"number"},"camera":string(),"picture":string(),"lighting":string(),"sound":string(),"dialogueParts":if dialogue_ids.is_empty(){json!({"type":"array","items":dialogue,"maxItems":0})}else{array(dialogue)},"transition":string(),"sourceRefs":refs(&source_ids),"contextRefs":refs(&all_ids)}),
    );
    let asset_ref = obj(
        json!({"assetId":if asset_ids.is_empty(){string()}else{json!({"type":"string","enum":asset_ids})},"variantId":if variant_ids.is_empty(){string()}else{json!({"type":"string","enum":variant_ids})},"use":choices(&["character","scene","prop","style","audio","video"]),"order":{"type":"integer"},"sourceRefs":refs(&source_ids)}),
    );
    let unit = obj(
        json!({"id":string(),"episodeId":{"type":"string","enum":[episode_id]},"eventId":{"type":"string","enum":event_ids},"sceneId":string(),"boundaryBefore":boundary_schema(),"title":string(),"unitDirection":string(),"intent":obj(json!({"subject":string(),"change":string(),"landing":string(),"retain":array(string())})),"scene":string(),"participants":array(string()),"props":array(string()),"lighting":string(),"initialState":string(),"exitState":string(),"sourceRefs":refs(&source_ids),"assetRefs":if asset_ids.is_empty(){json!({"type":"array","items":asset_ref,"maxItems":0})}else{array(asset_ref)},"shots":array(shot)}),
    );
    obj(
        json!({"schemaVersion":choices(&["storyboard-draft/v2"]),"units":array(unit),"fantasyRealization":array(obj(json!({"candidateId":string(),"unitIds":array(string()),"shotIds":array(string()),"screenSeconds":{"type":"number"},"entry":string(),"exit":string(),"preservedFunction":string()}))),"revisionNotes":array(obj(json!({"coordinate":string(),"sourceRefs":refs(&source_ids),"change":string(),"preservedFunction":string()}))),"unresolved":array(obj(json!({"coordinate":string(),"problem":string()})))}),
    )
}

fn refs_valid(items: &[String], allowed: &HashSet<&str>, nonempty: bool) -> Result<(), String> {
    if nonempty && items.is_empty() {
        return Err("当前制作范围引用不能为空".into());
    }
    let mut seen = HashSet::new();
    if items
        .iter()
        .any(|id| !allowed.contains(id.as_str()) || !seen.insert(id))
    {
        return Err("引用未知、越界或重复".into());
    }
    Ok(())
}

fn normalize_coverage(source: &LockedSource, covered: &[String]) -> Result<Vec<String>, String> {
    let mut once = Vec::new();
    for id in covered {
        if once.last() == Some(id) {
            if source
                .rows
                .iter()
                .find(|r| &r.id == id)
                .and_then(|r| r.dialogue.as_ref())
                .filter(|quote| !spoken_ranges(quote).is_empty())
                .is_none()
            {
                return Err("非对白来源行在多个单元重复派用；需明确源动作的唯一负责范围".into());
            }
        } else {
            once.push(id.clone());
        }
    }
    Ok(once)
}

fn validate_plan(
    plan: &Value,
    rows: &[SourceRow],
    context: &[SourceRow],
    scenes: &[SourceScene],
) -> Result<(), String> {
    if text(plan, "schemaVersion") != "storyboard-plan/v2" {
        return Err("情绪计划协议版本不匹配".into());
    }
    let allowed: HashSet<_> = rows.iter().map(|r| r.id.as_str()).collect();
    let all: HashSet<_> = rows.iter().chain(context).map(|r| r.id.as_str()).collect();
    let events = plan
        .get("events")
        .and_then(Value::as_array)
        .ok_or("情绪计划缺少 events")?;
    let packages = plan
        .get("workPackages")
        .and_then(Value::as_array)
        .ok_or("情绪计划缺少 workPackages")?;
    if events.is_empty() || packages.is_empty() {
        return Err("情绪计划遗漏当前制作范围".into());
    }
    let mut event_ids = HashSet::new();
    let mut event_coverage = Vec::new();
    for event in events {
        if text(event, "id").is_empty()
            || !event_ids.insert(text(event, "id"))
            || !scenes.iter().any(|s| s.id == text(event, "sceneId"))
        {
            return Err("事件身份或场景无效".into());
        }
        let rs = strings(event, "sourceRefs")?;
        refs_valid(&rs, &allowed, true)?;
        if rs.iter().any(|id| {
            rows.iter()
                .find(|r| &r.id == id)
                .and_then(|r| r.scene_id.as_deref())
                != Some(text(event, "sceneId"))
        }) {
            return Err("事件跨入另一个真实场景".into());
        }
        event_coverage.extend(rs);
        validate_emotion(&event["emotionContract"])?;
    }
    let expected: Vec<_> = rows.iter().map(|r| r.id.clone()).collect();
    if event_coverage != expected {
        return Err("事件必须按源顺序覆盖当前正文恰好一次".into());
    }
    let facts = plan
        .get("entryFacts")
        .and_then(Value::as_array)
        .ok_or("计划缺少 entryFacts")?;
    let mut fact_ids = HashSet::new();
    for fact in facts {
        if text(fact, "id").is_empty() || !fact_ids.insert(text(fact, "id")) {
            return Err("入口事实 id 重复".into());
        }
        refs_valid(&strings(fact, "sourceRefs")?, &all, true)?;
        if text(fact, "subject").trim().is_empty()
            || text(fact, "statement").trim().is_empty()
            || text(fact, "evidenceMode") != "source_rows"
        {
            return Err("入口事实须有主体、状态与程序源证据模式".into());
        }
    }
    let mut package_ids = HashSet::new();
    let mut package_coverage = Vec::new();
    for package in packages {
        let id = text(package, "id");
        let eid = text(package, "eventId");
        if id.is_empty() || !event_ids.contains(eid) || !package_ids.insert(id) {
            return Err("工作包身份或事件归属无效".into());
        }
        let source_refs = strings(package, "sourceRefs")?;
        refs_valid(&source_refs, &allowed, true)?;
        let event = events.iter().find(|e| text(e, "id") == eid).unwrap();
        let event_refs = strings(event, "sourceRefs")?;
        if source_refs.iter().any(|r| !event_refs.contains(r)) {
            return Err("工作包越出所属事件".into());
        }
        package_coverage.extend(source_refs);
        validate_emotion(&package["emotionContract"])?;
        refs_valid(&strings(package, "contextRefs")?, &all, false)?;
        if strings(package, "entryFactIds")?
            .iter()
            .any(|r| !fact_ids.contains(r.as_str()))
        {
            return Err("工作包引用未知入口事实".into());
        }
        if strings(package, "dependsOn")?
            .iter()
            .any(|r| r == id || !package_ids.contains(r.as_str()))
        {
            return Err("承接依赖必须引用已在源顺序前面的工作包".into());
        }
    }
    if package_coverage != expected {
        return Err("工作包必须依源顺序覆盖正文恰好一次".into());
    }
    let mut fantasy_ids = HashSet::new();
    for candidate in plan
        .get("fantasyCandidates")
        .and_then(Value::as_array)
        .ok_or("缺少幻想选择目录")?
    {
        if text(candidate, "id").is_empty() || !fantasy_ids.insert(text(candidate, "id")) {
            return Err("幻想候选身份空或重复".into());
        }
        refs_valid(&strings(candidate, "sourceRefs")?, &allowed, true)?;
        for field in ["screenSecondsRange", "extraSecondsRange"] {
            let values = candidate[field]
                .as_array()
                .filter(|v| v.len() == 2)
                .ok_or("幻想机会须给实际占时/净增时长区间")?;
            let low = values[0].as_f64().ok_or("幻想区间无效")?;
            let high = values[1].as_f64().ok_or("幻想区间无效")?;
            if !low.is_finite() || !high.is_finite() || low < 0.0 || high < low {
                return Err("幻想占时/净增区间无效".into());
            }
        }
    }
    Ok(())
}

fn validate_emotion(contract: &Value) -> Result<(), String> {
    if [
        "subject",
        "contextTone",
        "audienceEffect",
        "change",
        "landing",
    ]
    .iter()
    .any(|key| text(contract, key).trim().is_empty())
        || strings(contract, "retain")?.is_empty()
    {
        return Err("完整情绪契约缺少主体、当拍基调、观众回报、变化、落点或保留项".into());
    }
    Ok(())
}

fn capabilities(input: &Value) -> Result<(f64, f64, usize), String> {
    let caps = input.get("capabilities").ok_or("缺少冻结的分镜制作规格")?;
    let max = caps
        .get("maxDuration")
        .and_then(Value::as_f64)
        .ok_or("视频模型最大时长未知，不能生成假定容量的分镜")?;
    let min = caps
        .get("minDuration")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let images = caps
        .get("imageLimit")
        .or_else(|| caps.get("maxImages"))
        .and_then(Value::as_u64)
        .ok_or("视频模型参考图片容量未知")? as usize;
    if !max.is_finite() || !min.is_finite() || max <= 0.0 || min < 0.0 || min > max {
        return Err("视频模型时长能力无效".into());
    }
    Ok((min, max, images))
}

fn spoken_ranges(quote: &SourceDialogue) -> Vec<SourceRange> {
    // Canonical source parsing owns these segments. Legacy source without either
    // segment collection can still be read, but never trusted as model output.
    let ranges: Vec<SourceRange> = quote
        .spoken_segments
        .iter()
        .map(|segment| segment.range.clone())
        .collect();
    if ranges.is_empty() && quote.performance_segments.is_empty() && !quote.quote.is_empty() {
        vec![quote.range.clone()]
    } else {
        ranges
    }
}

fn expected_spoken(source: &LockedSource, quote: &SourceDialogue) -> Result<String, String> {
    spoken_ranges(quote)
        .iter()
        .map(|range| slice_utf16(&source.text, range))
        .collect::<Result<Vec<_>, _>>()
        .map(|parts| parts.join(""))
}

/// Model output selects immutable absolute UTF-16 source intervals. Text,
/// speaker and channel are always filled by Rust before validation or caching.
fn spoken_position(quote: &SourceDialogue, offset: usize) -> Option<usize> {
    let mut consumed = 0;
    for range in spoken_ranges(quote) {
        let length = range.end - range.start;
        if offset >= consumed && offset < consumed + length {
            return Some(range.start + offset - consumed);
        }
        consumed += length;
    }
    None
}

fn materialize_dialogue(
    source: &LockedSource,
    draft: &mut Value,
    allow_legacy: bool,
) -> Result<(), String> {
    let quotes: HashMap<_, _> = source
        .rows
        .iter()
        .filter_map(|r| r.dialogue.as_ref().map(|q| (q.id.as_str(), q)))
        .collect();
    let mut cursors: HashMap<String, usize> = HashMap::new();
    for unit in draft
        .get_mut("units")
        .and_then(Value::as_array_mut)
        .ok_or("缺少单元数组")?
    {
        for shot in unit
            .get_mut("shots")
            .and_then(Value::as_array_mut)
            .ok_or("缺少镜表数组")?
        {
            for part in shot
                .get_mut("dialogueParts")
                .and_then(Value::as_array_mut)
                .ok_or("缺少对白数组")?
            {
                if !part.is_object() {
                    return Err("对白片段必须为结构对象".into());
                }
                let id = text(part, "lineId").to_string();
                let quote = quotes.get(id.as_str()).ok_or("对白引用未知源句")?;
                let ranges = spoken_ranges(quote);
                let selected =
                    match (part["quoteStart"].as_u64(), part["quoteEnd"].as_u64()) {
                        (Some(start), Some(end)) => SourceRange {
                            start: start as usize,
                            end: end as usize,
                        },
                        (None, None) if allow_legacy => {
                            let old = *cursors.get(&id).unwrap_or(&0);
                            let body = text(part, "text");
                            let count = body.encode_utf16().count();
                            let mut offset = 0;
                            let range = ranges
                                .iter()
                                .find_map(|range| {
                                    let length = range.end - range.start;
                                    let result = (old >= offset
                                        && old < offset + length
                                        && old + count <= offset + length)
                                        .then(|| SourceRange {
                                            start: range.start + old - offset,
                                            end: range.start + old - offset + count,
                                        });
                                    offset += length;
                                    result
                                })
                                .ok_or("旧对白片段跨演法区间或不是连续发声原话，请明确修订")?;
                            range
                        }
                        _ => return Err(
                            "对白必须选择 quoteStart/quoteEnd 原文UTF16半开区间；模型不能抄写台词"
                                .into(),
                        ),
                    };
                if selected.start >= selected.end
                    || !ranges
                        .iter()
                        .any(|range| selected.start >= range.start && selected.end <= range.end)
                {
                    return Err("发声区间越界或包含不发声演法；跨演法须分别选择连续原话区间".into());
                }
                let body = slice_utf16(&source.text, &selected)?;
                let old = *cursors.get(&id).unwrap_or(&0);
                if spoken_position(quote, old) != Some(selected.start) {
                    return Err("原话区间重复、跳过或乱序，不能靠相同文字掩盖来源错误".into());
                }
                if part.get("text").is_some() && text(part, "text") != body {
                    return Err("传入对白与原话区间不一致，禁止改词或把演法念出".into());
                }
                if part.get("speaker").is_some() && text(part, "speaker") != quote.speaker
                    || part.get("channel").is_some() && text(part, "channel") != quote.channel
                {
                    return Err("传入说者或声道不符合原话来源".into());
                }
                cursors.insert(id, old + body.encode_utf16().count());
                part["quoteStart"] = json!(selected.start);
                part["quoteEnd"] = json!(selected.end);
                part["text"] = json!(body);
                part["speaker"] = json!(quote.speaker);
                part["channel"] = json!(quote.channel);
            }
        }
    }
    Ok(())
}

fn creative_settings(settings: &Value) -> Value {
    let mut result = serde_json::Map::new();
    for key in [
        "visualStyle",
        "fantasyMode",
        "noSubtitles",
        "noBgm",
        "creativeDirection",
    ] {
        if let Some(value) = settings.get(key) {
            result.insert(key.into(), value.clone());
        }
    }
    Value::Object(result)
}

fn production_direction(input: &Value) -> Value {
    json!({"direction":input.pointer("/foundation/direction").and_then(Value::as_str).unwrap_or(""),
        "overview":input.pointer("/foundation/overview").and_then(Value::as_str).unwrap_or(""),
        "evidenceRule":"全剧方向统领表达，不改写源事实，不压平本拍情绪；本集原文决定事件及揭示时点。"})
}

/// Domain checks are deliberately independent of JSON-schema parsing and model self-assessment.
pub fn validate_storyboard(
    source: &LockedSource,
    draft: &Value,
    assets: &[Value],
    caps: &Value,
) -> Result<(), String> {
    let source = upgrade_source_dialogues(source)?;
    validate_storyboard_scope(&source, draft, assets, caps, None)
}

fn validate_storyboard_scope(
    source: &LockedSource,
    draft: &Value,
    assets: &[Value],
    caps: &Value,
    expected_refs: Option<&[String]>,
) -> Result<(), String> {
    validate_source(source)?;
    let (min, max, image_limit) = capabilities(&json!({"capabilities":caps}))?;
    let units = draft
        .get("units")
        .and_then(Value::as_array)
        .ok_or("分镜回包缺少 units")?;
    if units.is_empty() {
        return Err("分镜没有输出视频单元".into());
    }
    let mut unit_ids = HashSet::new();
    let mut shot_ids = HashSet::new();
    let mut covered = Vec::new();
    let all: HashSet<_> = source.rows.iter().map(|r| r.id.as_str()).collect();
    let quotes: HashMap<_, _> = source
        .rows
        .iter()
        .filter_map(|r| r.dialogue.as_ref().map(|q| (q.id.as_str(), q)))
        .collect();
    let source_dialogue_order: HashMap<_, _> = source
        .rows
        .iter()
        .enumerate()
        .filter_map(|(i, r)| r.dialogue.as_ref().map(|q| (q.id.as_str(), i)))
        .collect();
    let mut spoken: HashMap<&str, String> = HashMap::new();
    let mut prior_dialogue_order = 0;
    for unit in units {
        let uid = text(unit, "id");
        if uid.is_empty() || !unit_ids.insert(uid) {
            return Err("分镜单元 id 为空或重复".into());
        }
        let eid = text(unit, "episodeId");
        let sid = text(unit, "sceneId");
        if !source
            .scenes
            .iter()
            .any(|s| s.id == sid && s.episode_id == eid)
        {
            return Err("单元场景/制作集身份不成立".into());
        }
        for field in [
            "title",
            "unitDirection",
            "scene",
            "lighting",
            "initialState",
            "exitState",
        ] {
            if text(unit, field).trim().is_empty() {
                return Err(format!("单元 {uid} 缺少独立可读的 {field}"));
            }
        }
        if ["同上", "承接上一镜", "承接上一个单元"]
            .iter()
            .any(|s| text(unit, "initialState").trim() == *s)
        {
            return Err("单元初态不能依赖生成端回查上一个单元".into());
        }
        let source_refs = strings(unit, "sourceRefs")?;
        refs_valid(&source_refs, &all, true)?;
        if source_refs.iter().any(|id| {
            source
                .rows
                .iter()
                .find(|r| &r.id == id)
                .map(|r| {
                    r.kind != "body"
                        || r.episode_id.as_deref() != Some(eid)
                        || r.scene_id.as_deref() != Some(sid)
                })
                .unwrap_or(true)
        }) {
            return Err("单元来源跨集/跨场或包含非制作资料".into());
        }
        covered.extend(source_refs.clone());
        let references = unit
            .get("assetRefs")
            .and_then(Value::as_array)
            .ok_or("单元缺少结构化资产引用")?;
        let mut orders = HashSet::new();
        let mut asset_identities = HashSet::new();
        let mut image_identities = HashSet::new();
        for reference in references {
            let aid = text(reference, "assetId");
            let vid = text(reference, "variantId");
            let asset = assets
                .iter()
                .find(|a| text(a, "id") == aid && text(a, "variantId") == vid)
                .ok_or("分镜引用未知资产/形象，不能按同名匹配")?;
            if !asset_identities.insert((aid, vid)) {
                return Err("单元重复引用同一资产形象".into());
            }
            let order = reference
                .get("order")
                .and_then(Value::as_u64)
                .filter(|o| *o > 0)
                .ok_or("素材顺序必须从1开始")?;
            if !orders.insert(order) {
                return Err("素材顺序重复".into());
            }
            let use_kind = text(reference, "use");
            if !text(reference, "imageAssetId").is_empty()
                || !text(reference, "imageVariantId").is_empty()
            {
                let pair =
                    image_identity(asset, assets).ok_or("未找到 INLINE 形象明确的父图身份")?;
                if pair
                    != (
                        text(reference, "imageAssetId").to_string(),
                        text(reference, "imageVariantId").to_string(),
                    )
                {
                    return Err("分镜图片映射与已登记来源关系不一致".into());
                }
            }
            if asset.pointer("/preparation/mode").and_then(Value::as_str) == Some("AUDIO")
                && !["audio", "video"].contains(&use_kind)
            {
                return Err("声音来源不能要求人物/场景图片；纯 VO/OS 不证明角色入画".into());
            }
            if !["audio", "video"].contains(&use_kind) {
                image_identities.insert((
                    if text(reference, "imageAssetId").is_empty() {
                        aid
                    } else {
                        text(reference, "imageAssetId")
                    },
                    if text(reference, "imageVariantId").is_empty() {
                        vid
                    } else {
                        text(reference, "imageVariantId")
                    },
                ));
            }
            let scopes = asset.get("applicability");
            if let Some(obj) = scopes.and_then(Value::as_object) {
                if obj
                    .get("episodes")
                    .and_then(Value::as_array)
                    .filter(|v| !v.is_empty())
                    .map(|v| !v.iter().any(|e| e.as_str() == Some(eid)))
                    .unwrap_or(false)
                    || obj
                        .get("scenes")
                        .and_then(Value::as_array)
                        .filter(|v| !v.is_empty())
                        .map(|v| !v.iter().any(|s| s.as_str() == Some(sid)))
                        .unwrap_or(false)
                {
                    return Err("分镜引用的形象不适用于当前集场".into());
                }
            } else if let Some(list) = scopes.and_then(Value::as_array).filter(|v| !v.is_empty()) {
                if !list
                    .iter()
                    .any(|p| text(p, "episodeId") == eid && text(p, "sceneId") == sid)
                {
                    return Err("分镜引用的形象不适用于当前集场".into());
                }
            }
            let rs = strings(reference, "sourceRefs")?;
            refs_valid(&rs, &all, true)?;
            if rs.iter().any(|r| !source_refs.contains(r)) {
                return Err("单元资产引用越出本单元来源".into());
            }
        }
        if image_identities.len() > image_limit {
            return Err(format!("单元 {uid} 需要 {} 张图片，超出渠道 {image_limit} 张上限；须修订单元，不能自动删图",image_identities.len()));
        }
        if !orders.is_empty() && (1..=orders.len() as u64).any(|o| !orders.contains(&o)) {
            return Err("素材顺序存在空档".into());
        }
        let shots = unit
            .get("shots")
            .and_then(Value::as_array)
            .ok_or("单元缺少六栏镜表")?;
        if shots.is_empty() {
            return Err("单元镜表不能为空".into());
        }
        let mut duration = 0.0;
        for shot in shots {
            let id = text(shot, "id");
            if id.is_empty() || !shot_ids.insert(id) {
                return Err("镜号空或重复".into());
            }
            let seconds = shot
                .get("duration")
                .and_then(Value::as_f64)
                .filter(|s| s.is_finite() && *s > 0.0)
                .ok_or("镜长须为正数")?;
            duration += seconds;
            for field in ["camera", "picture", "lighting", "sound", "transition"] {
                if text(shot, field).trim().is_empty() {
                    return Err(format!("镜 {id} 缺少 {field}"));
                }
            }
            let rs = strings(shot, "sourceRefs")?;
            refs_valid(&rs, &all, true)?;
            if rs.iter().any(|r| !source_refs.contains(r)) {
                return Err("镜头引用越出本单元来源".into());
            }
            refs_valid(&strings(shot, "contextRefs")?, &all, false)?;
            for part in shot
                .get("dialogueParts")
                .and_then(Value::as_array)
                .ok_or("镜表缺少对白/声窗字段")?
            {
                let line_id = text(part, "lineId");
                let quote = quotes.get(line_id).ok_or("对白引用未知源句")?;
                let body = text(part, "text");
                if let (Some(start), Some(end)) =
                    (part["quoteStart"].as_u64(), part["quoteEnd"].as_u64())
                {
                    let range = SourceRange {
                        start: start as usize,
                        end: end as usize,
                    };
                    if start >= end
                        || !spoken_ranges(quote)
                            .iter()
                            .any(|segment| range.start >= segment.start && range.end <= segment.end)
                        || slice_utf16(&source.text, &range)? != body
                    {
                        return Err("对白原话区间与物化文字不一致或包含演法".into());
                    }
                } else if part.get("quoteStart").is_some() || part.get("quoteEnd").is_some() {
                    return Err("原话区间必须为完整UTF16半开区间".into());
                }
                let start = part
                    .get("voiceStart")
                    .and_then(Value::as_f64)
                    .ok_or("缺少声窗开始")?;
                let end = part
                    .get("voiceEnd")
                    .and_then(Value::as_f64)
                    .ok_or("缺少声窗结束")?;
                if !start.is_finite()
                    || !end.is_finite()
                    || start < 0.0
                    || end <= start
                    || end > seconds + 0.000001
                {
                    return Err("声窗越出镜长或为空，禁止机械裁窗过关".into());
                }
                if text(part, "speaker") != quote.speaker || text(part, "channel") != quote.channel
                {
                    return Err("说者或声道被改写".into());
                }
                if !source_refs.iter().any(|r| {
                    source
                        .rows
                        .iter()
                        .find(|p| &p.id == r)
                        .and_then(|p| p.dialogue.as_ref())
                        .map(|q| q.id == quote.id)
                        .unwrap_or(false)
                }) {
                    return Err("对白越出单元来源".into());
                }
                let position = source_dialogue_order[line_id];
                if position < prior_dialogue_order {
                    return Err("源原话顺序被改写".into());
                }
                prior_dialogue_order = position;
                if body.is_empty() {
                    return Err("对白原片段不能为空".into());
                }
                let accumulated = spoken.entry(line_id).or_default();
                if let Some(start) = part["quoteStart"].as_u64() {
                    if spoken_position(quote, accumulated.encode_utf16().count())
                        != Some(start as usize)
                    {
                        return Err("原话区间重复、跳过或乱序".into());
                    }
                }
                accumulated.push_str(body);
                if !expected_spoken(source, quote)?.starts_with(accumulated.as_str()) {
                    return Err("对白新增、遗漏、重放、标点规范化或非连续片段".into());
                }
            }
        }
        if duration > max + 0.000001 {
            return Err(format!(
                "单元 {uid} 时长 {duration:.2} 秒超过渠道 {max:.2} 秒；须修订而非截断"
            ));
        }
        // A naturally short ending is legal editorial content; the channel may reject generation later.
        if duration < min && unit.get("allowShortEnding").and_then(Value::as_bool) == Some(false) {
            return Err("当前渠道最小时长未满足".into());
        }
        if let Some(recorded) = unit.get("duration").and_then(Value::as_f64) {
            if (recorded - duration).abs() > 0.001 {
                return Err("单元总长与镜长合计不一致".into());
            }
        }
    }
    let expected: Vec<_> = source
        .rows
        .iter()
        .filter(|r| {
            r.kind == "body"
                && expected_refs
                    .map(|refs| refs.contains(&r.id))
                    .unwrap_or(true)
                && r.episode_id
                    .as_ref()
                    .map(|id| units.iter().any(|u| text(u, "episodeId") == id))
                    .unwrap_or(false)
        })
        .map(|r| r.id.clone())
        .collect();
    if normalize_coverage(source, &covered)? != expected {
        return Err(
            "单元须依源顺序完整覆盖制作正文；跨单元同句仅允许连续原片段且全句恰好一次".into(),
        );
    }
    for row in source.rows.iter().filter(|r| covered.contains(&r.id)) {
        if let Some(quote) = &row.dialogue {
            let expected = expected_spoken(source, quote)?;
            if !expected.is_empty()
                && spoken.get(quote.id.as_str()).map(String::as_str) != Some(expected.as_str())
            {
                return Err(format!("对白 {} 未完整出现一次", quote.id));
            }
        }
    }
    Ok(())
}

fn compile_prompt(unit: &Value, visual_style: &str) -> String {
    let mut parts = vec![];
    if !visual_style.trim().is_empty() {
        parts.push(format!("项目画风：{visual_style}"));
    }
    let mapping: Vec<_> = unit
        .get("assetRefs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|r| {
            format!(
                "{{{{asset:{}:{}}}}}：{}参考",
                text(r, "assetId"),
                text(r, "variantId"),
                text(r, "use")
            )
        })
        .collect();
    if !mapping.is_empty() {
        parts.push(format!("参考素材顺序：\n{}", mapping.join("\n")));
    }
    parts.push(format!(
        "演出总指令：{}\n场景：{}\n人物：{}\n道具：{}\n初态：{}\n光影：{}\n末态：{}",
        text(unit, "unitDirection"),
        text(unit, "scene"),
        unit.get("participants")
            .and_then(Value::as_array)
            .map(|v| v
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("、"))
            .unwrap_or_default(),
        unit.get("props")
            .and_then(Value::as_array)
            .map(|v| v
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("、"))
            .unwrap_or_default(),
        text(unit, "initialState"),
        text(unit, "lighting"),
        text(unit, "exitState")
    ));
    let mut offset = 0.0;
    for shot in unit
        .get("shots")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let duration = shot.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
        let dialogue: Vec<_> = shot
            .get("dialogueParts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|p| {
                format!(
                    "{}{}（{}；{:.2}–{:.2}秒）：{}；演法：{}",
                    if text(p, "speaker").is_empty() {
                        "原声"
                    } else {
                        text(p, "speaker")
                    },
                    if text(p, "channel").is_empty() {
                        String::new()
                    } else {
                        format!("—{}", text(p, "channel"))
                    },
                    text(p, "presentation"),
                    offset + p.get("voiceStart").and_then(Value::as_f64).unwrap_or(0.0),
                    offset + p.get("voiceEnd").and_then(Value::as_f64).unwrap_or(0.0),
                    text(p, "text"),
                    text(p, "delivery")
                )
            })
            .collect();
        parts.push(format!(
            "镜头 {:.2}–{:.2}秒\n机位：{}\n画面：{}\n光影：{}\n声音：{}\n台词：{}\n转场：{}",
            offset,
            offset + duration,
            text(shot, "camera"),
            text(shot, "picture"),
            text(shot, "lighting"),
            text(shot, "sound"),
            if dialogue.is_empty() {
                "无对白".into()
            } else {
                dialogue.join("\n")
            },
            text(shot, "transition")
        ));
        offset += duration;
    }
    parts.join("\n\n")
}

/// Legacy prose is copied from adopted unit fields. Asset mapping is intentionally external/manual.
pub fn render_legacy_unit(unit: &Value) -> String {
    compile_prompt(unit, text(unit, "visualStyle"))
}

fn add_delivery_fields(draft: &mut Value, style: &str) -> Result<(), String> {
    for unit in draft
        .get_mut("units")
        .and_then(Value::as_array_mut)
        .ok_or("缺少单元")?
    {
        let duration: f64 = unit
            .get("shots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|s| s.get("duration").and_then(Value::as_f64))
            .sum();
        let prompt = compile_prompt(unit, style);
        let map = unit.as_object_mut().ok_or("单元不是对象")?;
        map.insert("duration".into(), json!(duration));
        map.insert("prompt".into(), json!(prompt));
        if let Some(refs) = map.get_mut("assetRefs").and_then(Value::as_array_mut) {
            for r in refs {
                let usage = text(r, "use").to_string();
                r["role"] = json!(usage);
            }
        }
    }
    Ok(())
}

/// Mechanical port of episode-boundary-seed's last-scene/complete-node tail.
/// The budget is soft; an oversized final source row remains whole. This is
/// source evidence, not proof that the current episode inherits a prior state.
fn previous_source_boundary(source: &LockedSource, episode: &SourceEpisode) -> Value {
    let Some(position) = source
        .episodes
        .iter()
        .position(|e| e.id == episode.id)
        .filter(|p| *p > 0)
    else {
        return Value::Null;
    };
    let previous = &source.episodes[position - 1];
    let scene = source
        .scenes
        .iter()
        .filter(|s| s.episode_id == previous.id)
        .last();
    let mut nodes: Vec<_> = source
        .rows
        .iter()
        .filter(|r| {
            r.episode_id.as_ref() == Some(&previous.id)
                && r.kind != "format"
                && scene.map(|s| s.row_ids.contains(&r.id)).unwrap_or(true)
        })
        .collect();
    let original_count = nodes.len();
    let required = nodes
        .iter()
        .rposition(|r| r.kind == "body")
        .map(|i| nodes[i].id.clone());
    while nodes.iter().filter(|r| !r.text.trim().is_empty()).count() > 1
        && nodes
            .last()
            .map(|r| r.range.end)
            .unwrap_or(0)
            .saturating_sub(nodes.first().map(|r| r.range.start).unwrap_or(0))
            > 2400
    {
        if nodes
            .first()
            .is_some_and(|r| required.as_deref() == Some(r.id.as_str()))
        {
            break;
        }
        nodes.remove(0);
    }
    let clipped = nodes.len() != original_count;
    let width = nodes
        .last()
        .map(|r| r.range.end)
        .unwrap_or(0)
        .saturating_sub(nodes.first().map(|r| r.range.start).unwrap_or(0));
    json!({"version":"source-boundary-nodes/v1","episodeId":previous.id,"sceneId":scene.map(|s|&s.id),
        "selectionKind":if clipped {"TAIL_NODES"} else if scene.is_some() {"SAVED_SCENE"} else {"WHOLE_EPISODE_FALLBACK"},
        "sourceRefs":nodes.iter().map(|r| &r.id).collect::<Vec<_>>(),"sourceSha256":source.sha256,
        "sourceRange":{"start":nodes.first().map(|r|r.range.start),"end":nodes.last().map(|r|r.range.end)},
        "clipped":clipped,"budgetExceeded":width>2400,"currentApplicability":"UNKNOWN",
        "policy":"末场或完整尾部源节点是有坐标的历史证据；不自动继承状态，不把选段冒充完整前场。"})
}

fn relevant_context(
    source: &LockedSource,
    episode: &SourceEpisode,
    assets: &[Value],
    foundation: &Value,
) -> Vec<SourceRow> {
    let first = source
        .rows
        .iter()
        .filter(|r| r.episode_id.as_ref() == Some(&episode.id))
        .map(|r| r.range.start)
        .min()
        .unwrap_or(0);
    let identities: HashSet<_> = assets
        .iter()
        .map(|a| {
            if text(a, "baseAssetId").is_empty() {
                text(a, "id")
            } else {
                text(a, "baseAssetId")
            }
        })
        .collect();
    let mut selected = HashSet::new();
    let mut anonymous_utf16 = 0;
    let background_names: Vec<_> = assets
        .iter()
        .map(|a| text(a, "name").split('｜').next().unwrap_or(""))
        .filter(|n| !n.is_empty())
        .collect();
    for row in source.rows.iter().filter(|r| r.kind == "context") {
        let matched = background_names.iter().any(|name| row.text.contains(name));
        let explicit_global = ["世界规则", "世界观", "全局设定", "背景规则"]
            .iter()
            .any(|key| row.text.contains(key));
        let width = row.text.encode_utf16().count();
        if matched || explicit_global || anonymous_utf16 + width <= 12_000 {
            selected.insert(row.id.clone());
            if !matched && !explicit_global {
                anonymous_utf16 += width;
            }
        }
    }
    // Port of the old local historical retrieval: do not collapse distinct
    // claims to a guessed latest state. All relevant original evidence and its
    // same-episode neighbors are history, never current production coverage.
    let names: Vec<String> = assets
        .iter()
        .flat_map(|asset| {
            let mut names = vec![text(asset, "name")
                .split('｜')
                .next()
                .unwrap_or("")
                .to_string()];
            names.extend(
                asset["aliases"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string),
            );
            names
        })
        .filter(|name| !name.trim().is_empty())
        .collect();
    let mut historic = HashSet::new();
    for fact in foundation
        .get("facts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|f| {
            identities.contains(text(f, "assetId"))
                || names.iter().any(|name| text(f, "subject") == name)
        })
    {
        for id in strings(fact, "sourceRefs").unwrap_or_default() {
            if source
                .rows
                .iter()
                .any(|r| r.id == id && r.range.end <= first && r.kind == "body")
            {
                historic.insert(id);
            }
        }
    }
    for row in source.rows.iter().filter(|r| {
        r.kind == "body" && r.range.end <= first && names.iter().any(|name| r.text.contains(name))
    }) {
        historic.insert(row.id.clone());
    }
    for (index, row) in source
        .rows
        .iter()
        .enumerate()
        .filter(|(_, row)| historic.contains(&row.id))
    {
        for neighbor in source.rows
            [index.saturating_sub(1)..=(index + 1).min(source.rows.len() - 1)]
            .iter()
            .filter(|r| r.kind == "body" && r.episode_id == row.episode_id && r.range.end <= first)
        {
            selected.insert(neighbor.id.clone());
        }
    }
    selected.extend(
        strings(&previous_source_boundary(source, episode), "sourceRefs").unwrap_or_default(),
    );
    source
        .rows
        .iter()
        .filter(|r| selected.contains(&r.id))
        .cloned()
        .collect()
}

fn validate_event_bindings(draft: &Value, plan: &Value) -> Result<(), String> {
    let events = plan["events"].as_array().ok_or("缺少事件目录")?;
    for unit in draft["units"].as_array().ok_or("缺少单元")? {
        let event = events
            .iter()
            .find(|e| text(e, "id") == text(unit, "eventId"))
            .ok_or("单元引用未知事件")?;
        if text(unit, "sceneId") != text(event, "sceneId") {
            return Err("单元跨出事件所属场景".into());
        }
        let allowed = strings(event, "sourceRefs")?;
        if strings(unit, "sourceRefs")?
            .iter()
            .any(|r| !allowed.contains(r))
        {
            return Err("单元来源越出事件范围".into());
        }
        let boundary = unit.get("boundaryBefore").ok_or("单元缺少真实边界")?;
        if ![
            "episode_start",
            "continuous",
            "capacity",
            "new_event",
            "time_space_jump",
        ]
        .contains(&text(boundary, "kind"))
            || text(boundary, "reason").trim().is_empty()
        {
            return Err("单元边界类型/依据无效".into());
        }
    }
    Ok(())
}

/// Frozen input: source/foundation/assets/settings/capabilities/selection.
/// Decisions live separately at decisions[episodeId].selectedFantasyIds, so a
/// review continuation reuses the identical accepted planning request.
/// selection.unitIds + existingUnits + revisionInstruction selects local rework.
pub async fn run_storyboard(
    input: &Value,
    executor: &dyn TextExecutor,
    model: &str,
    reasoning: &str,
) -> Result<Value, String> {
    let source: LockedSource =
        serde_json::from_value(input.get("source").cloned().ok_or("缺少锁定原文")?)
            .map_err(|e| format!("原文结构无效：{e}"))?;
    let source = upgrade_source_dialogues(&source)?;
    validate_source(&source)?;
    if source.diagnostics.iter().any(|d| d.blocking) {
        return Err("原文仍有未定集场范围，不能创作假定来源的分镜".into());
    }
    if input
        .pointer("/selection/unitIds")
        .and_then(Value::as_array)
        .map(|ids| !ids.is_empty())
        .unwrap_or(false)
    {
        return run_storyboard_revision(&source, input, executor, model, reasoning).await;
    }
    let (minimum_duration, _, _) = capabilities(input)?;
    let caps = input.get("capabilities").unwrap();
    let assets = input
        .get("assets")
        .and_then(Value::as_array)
        .ok_or("缺少资产身份目录")?;
    let raw_settings = input.get("settings").cloned().unwrap_or_else(|| json!({}));
    let settings = creative_settings(&raw_settings);
    let fantasy_mode = text(&settings, "fantasyMode");
    let fantasy_mode = if fantasy_mode.is_empty() {
        "off"
    } else {
        fantasy_mode
    };
    if !["off", "recommend", "all", "review"].contains(&fantasy_mode) {
        return Err("幻想选择方式无效".into());
    }
    let style = text(&settings, "visualStyle");
    let direction = production_direction(input);
    let requested: Option<HashSet<&str>> = input
        .pointer("/selection/episodeIds")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect());
    let requested_one = input.get("episodeId").and_then(Value::as_str);
    if requested_one
        .map(|id| !source.episodes.iter().any(|e| e.id == id))
        .unwrap_or(false)
        || requested
            .as_ref()
            .map(|ids| {
                ids.iter()
                    .any(|id| !source.episodes.iter().any(|e| e.id == *id))
            })
            .unwrap_or(false)
    {
        return Err("指定制作集不存在".into());
    }
    let mut all_units = Vec::new();
    let mut plans = Vec::new();
    let mut blocked = Vec::new();
    let mut waiting = Vec::new();
    let mut unavailable = HashSet::new();
    let mut previous = input
        .get("previousBoundary")
        .cloned()
        .unwrap_or(Value::Null);
    let mut all_realizations = Vec::new();
    let mut all_revisions = Vec::new();
    let mut all_unresolved = Vec::new();
    let mut updated_episodes = Vec::new();
    for (position, episode) in source.episodes.iter().enumerate() {
        if requested_one.map(|id| id != episode.id).unwrap_or(false)
            || requested
                .as_ref()
                .map(|ids| !ids.contains(episode.id.as_str()))
                .unwrap_or(false)
        {
            continue;
        }
        let prior_id = position
            .checked_sub(1)
            .map(|index| source.episodes[index].id.as_str());
        if prior_id.map(|id| unavailable.contains(id)).unwrap_or(false) {
            blocked.push(json!({"episodeId":episode.id,"status":"waiting_dependency","code":"CONTINUITY_PREDECESSOR_UNAVAILABLE","dependsOn":prior_id,"reason":"连续前集尚未完成，保留原末态，处理前置后继续。"}));
            unavailable.insert(episode.id.clone());
            continue;
        }
        let rows: Vec<_> = source
            .rows
            .iter()
            .filter(|r| r.episode_id.as_ref() == Some(&episode.id) && r.kind == "body")
            .cloned()
            .collect();
        if rows.is_empty() {
            blocked.push(json!({"episodeId":episode.id,"reason":"当前集没有可制作正文"}));
            unavailable.insert(episode.id.clone());
            continue;
        }
        let scenes: Vec<_> = source
            .scenes
            .iter()
            .filter(|s| s.episode_id == episode.id)
            .cloned()
            .collect();
        let current_assets = episode_assets(assets, &episode.id);
        let context = relevant_context(
            &source,
            episode,
            &current_assets,
            input.get("foundation").unwrap_or(&Value::Null),
        );
        let foundation_episode = input
            .pointer("/foundation/episodes")
            .and_then(Value::as_array)
            .and_then(|items| items.iter().find(|e| text(e, "episodeId") == episode.id));
        if !previous.is_null() && prior_id != Some(text(&previous, "episodeId")) {
            previous = Value::Null;
        }
        let episode_facts = scoped_facts(input, &rows, &context);
        let decision = input
            .get("decisions")
            .and_then(|decisions| decisions.get(&episode.id))
            .and_then(|decision| decision.get("selectedFantasyIds"))
            .or_else(|| raw_settings.get("selectedFantasyIds"));
        let result: Result<Value, String> = async {
            let mut plan_methods=vec!["storyboard-common","storyboard-source-context","sound-rhythm"];
            if fantasy_mode!="off" || methods_for(&rows,&[],&[],false,&episode_facts)?.contains(&"fantasy-expression") {plan_methods.push("fantasy-expression");}
            let plan = call_validated(executor, "storyboardPlan", "episode-emotion-planner", model, reasoning,
                json!({"episode":episode,"productionDirection":direction,"foundationEpisode":foundation_episode,"sourceRows":rows,"contextRows":context,"facts":episode_facts,"assets":current_assets,"settings":settings,"capabilities":caps,"previousBoundary":previous,"previousSourceBoundary":previous_source_boundary(&source,episode),"availableScenarioKeys":original::SCENARIO_KEYS,"capacityBrief":original::capacity_brief(caps,None,input.get("voiceReference"),&rows),"historyEvidenceRule":"contextRows仅为历史或公共背景证据，currentApplicability=UNKNOWN；相同姓名/邻文不证明同一身份、当拍知情或状态自动延续。当前原文优先。"}),
                plan_schema(&rows, &context, &scenes, fantasy_mode), &plan_methods, |value| {
                    validate_plan(value, &rows, &context, &scenes)?;
                    original::normalize_event_plan(value,&rows)?;
                    for fact in value["entryFacts"].as_array_mut().ok_or("缺少入口事实")? {
                        let evidence:Vec<_>=strings(fact,"sourceRefs")?.iter().map(|id|rows.iter().chain(&context).find(|r|&r.id==id).map(|r|r.text.clone()).ok_or("未知源证据")).collect::<Result<_,_>>()?;
                        fact["evidence"]=json!(evidence);fact["currentApplicability"]=json!("SOURCE_ANCHORED");
                    }
                    value["sourceFingerprints"]=json!(rows.iter().chain(&context).map(|r|(r.id.clone(),digest(&r.text))).collect::<HashMap<_,_>>());
                    if fantasy_mode == "off" && !value["fantasyCandidates"].as_array().unwrap().is_empty() { return Err("关闭额外幻想时不得新增幻想候选".into()); }
                    Ok(())
                }).await?;
            if fantasy_mode == "review" && !plan["fantasyCandidates"].as_array().unwrap().is_empty() && decision.is_none() {
                return Ok(json!({"pendingPlan":plan}));
            }
            let selected_ids = match decision {
                Some(value) => Some(value.as_array().ok_or("幻想选择必须为id数组")?.iter().map(|id| id.as_str().ok_or("幻想选择id必须为字符串")).collect::<Result<HashSet<_>, _>>()?),
                None => None,
            };
            if selected_ids.as_ref().map(|ids| ids.iter().any(|id| !plan["fantasyCandidates"].as_array().unwrap().iter().any(|candidate| text(candidate, "id") == *id))).unwrap_or(false) {
                return Err("已选幻想机会不属于冻结计划，请重新核对选择".into());
            }
            let selected: Vec<_> = plan["fantasyCandidates"].as_array().unwrap().iter().filter(|candidate| if fantasy_mode!="off" && selected_ids.is_some() {selected_ids.as_ref().unwrap().contains(text(candidate,"id"))} else {match fantasy_mode {
                "all" => true,
                "recommend" => candidate["recommended"].as_bool() == Some(true),
                "review" => selected_ids.as_ref().map(|ids| ids.contains(text(candidate, "id"))).unwrap_or(false),
                _ => false,
            }}).cloned().collect();
            let events=plan["events"].as_array().unwrap();
            let event_ids:Vec<_>=events.iter().map(|e|text(e,"id").to_string()).collect();
            let packages=plan["workPackages"].as_array().unwrap();
            let batches=original::author_batches(&plan,&rows,&selected)?;
            let mut created=Vec::new();let mut realizations=Vec::new();let mut revision_notes=Vec::new();let mut unresolved=Vec::new();
            let mut local_blocked=Vec::new();let mut failed_owners=HashSet::new();
            let mut accepted_boundary=previous.clone();let mut previous_batch:Option<String>=None;
            let mut package_outputs:Vec<(String,Value)>=Vec::new();
            for batch in &batches {
                let owners:Vec<_>=packages.iter().filter(|p|batch.package_ids.iter().any(|id|id==text(p,"id"))).collect();
                let dependencies:HashSet<_>=owners.iter().flat_map(|p|strings(p,"dependsOn").unwrap_or_default()).filter(|id|!batch.package_ids.contains(id)).collect();
                if batch.package_ids.iter().any(|id|failed_owners.contains(id)) || dependencies.iter().any(|id|failed_owners.contains(id)) {
                    local_blocked.push(json!({"episodeId":episode.id,"executionBatchId":batch.id,"packageIds":batch.package_ids,"status":"waiting_dependency","reason":"必要前稿尚未完成，保留已有步骤，处理关联前置后继续。"}));
                    failed_owners.extend(batch.package_ids.iter().cloned());accepted_boundary=Value::Null;continue;
                }
                let package_rows:Vec<_>=rows.iter().filter(|r|batch.source_refs.contains(&r.id)).cloned().collect();
                let candidates:Vec<_>=selected.iter().filter(|c|strings(c,"sourceRefs").map(|rs|rs.iter().any(|r|batch.source_refs.contains(r))).unwrap_or(false)).cloned().collect();
                let entry_ids:HashSet<_>=owners.iter().flat_map(|p|strings(p,"entryFactIds").unwrap_or_default()).collect();
                let entry_facts:Vec<_>=plan["entryFacts"].as_array().unwrap().iter().filter(|f|entry_ids.contains(text(f,"id"))).cloned().collect();
                let mut context_ids:HashSet<_>=owners.iter().flat_map(|p|strings(p,"contextRefs").unwrap_or_default()).collect();
                context_ids.extend(entry_facts.iter().flat_map(|f|strings(f,"sourceRefs").unwrap_or_default()));
                if let Some(first)=rows.iter().position(|r|batch.source_refs.contains(&r.id)) {context_ids.extend(rows[first.saturating_sub(3)..first].iter().map(|r|r.id.clone()));}
                // An execution split sees the remainder only as context, never as new production coverage.
                for owner in &owners {context_ids.extend(strings(owner,"sourceRefs")?.into_iter().filter(|r|!batch.source_refs.contains(r)));}
                let package_context:Vec<_>=context.iter().chain(&rows).filter(|r|!batch.source_refs.contains(&r.id) && (r.kind=="context"||context_ids.contains(&r.id)||context.iter().any(|c|c.id==r.id))).cloned().collect();
                let scenario_keys:Vec<_>=owners.iter().flat_map(|p|strings(p,"scenarioKeys").unwrap_or_default()).collect();
                let dependency_outputs:Vec<_>=package_outputs.iter().filter(|(id,_)|dependencies.contains(id)).map(|(_,output)|output).collect();
                let accepted_continuity=if accepted_boundary.is_null(){Value::Null}else{json!({"version":"accepted-tail-v1","executionBatchId":previous_batch,"unit":accepted_boundary,"sourceRefs":accepted_boundary["sourceRefs"],"boundaryBefore":events.iter().find(|e|text(e,"id")==text(owners[0],"eventId")).map(|e|&e["boundaryBefore"]),"evidenceRole":"ACCEPTED_CREATIVE_STATE_ONLY"})};
                let plan_view=json!({"emotionArc":plan["emotionArc"],"unitPackingPolicy":"event-first-v1","events":events.iter().filter(|e|owners.iter().any(|p|text(p,"eventId")==text(e,"id"))).collect::<Vec<_>>(),"workPackages":owners,"provisionalUnits":plan["provisionalUnits"].as_array().unwrap().iter().filter(|u|batch.provisional_unit_ids.iter().any(|id|id==text(u,"id"))).collect::<Vec<_>>(),"fantasyCandidates":candidates,"acceptedContinuity":accepted_continuity,"dependencyExits":dependency_outputs,"executionBatch":batch.value()});
                let prefix=format!("{}:{}:",episode.id,batch.id);
                let batch_result:Result<Value,String>=async {
                    let methods=methods_for(&package_rows,&candidates,&scenario_keys,false,&entry_facts)?;
                    let authored=call_validated(executor,"storyboardCreate","unit-performance-director",model,reasoning,
                        json!({"episodeId":episode.id,"productionDirection":direction,"foundationEpisode":foundation_episode,"workPackage":owners.first(),"workPackages":owners,"plan":plan_view,"sourceRows":package_rows,"contextRows":package_context,"entryFacts":entry_facts,"facts":episode_facts,"assets":current_assets,"selectedFantasy":candidates,"acceptedContinuity":accepted_continuity,"dependencyOutputs":dependency_outputs,"executionBatch":batch.value(),"settings":settings,"capabilities":caps,"capacityBrief":original::capacity_brief(caps,None,input.get("voiceReference"),&package_rows),"instruction":"作者范围不是视频单元数量。对白只选择lineId及spokenSegments内绝对UTF16 quoteStart/quoteEnd，演法不发声；Rust物化台词/说者/声道。本批正文完整一次；上下文和已采用前稿不重演，不自动继承前包幻想许可。"}),
                        draft_schema(&package_rows,&package_context,&current_assets,&event_ids,&episode.id),&methods,|value| {
                            validate_authored(&source,value,&current_assets,caps,&batch.source_refs,style,&prefix)?;
                            validate_event_bindings(value,&plan)?;validate_fantasy(value,&candidates)
                        }).await?;
                    let methods=methods_for(&package_rows,&candidates,&scenario_keys,true,&entry_facts)?;
                    let finished=call_validated(executor,"storyboardFinish","episode-finishing-editor",model,reasoning,
                        json!({"episodeId":episode.id,"productionDirection":direction,"foundationEpisode":foundation_episode,"sourceRows":package_rows,"contextRows":package_context,"plan":plan_view,"draft":authored,"previousDraft":authored,"entryFacts":entry_facts,"facts":episode_facts,"assets":current_assets,"selectedFantasy":candidates,"acceptedContinuity":accepted_continuity,"settings":settings,"capabilities":caps,"executionBatch":batch.value(),"capacityBrief":original::capacity_brief(caps,Some(&authored),input.get("voiceReference"),&package_rows),"instruction":"直接交完整关联范围。无问题保留正文和已有id；实际拆合才改。原話只選原區間，Rust物化。按新切点重算声窗，不删图/截词/截提示词；情绪主次以本源范围核对，不以局部比例替整集审查。"}),
                        draft_schema(&package_rows,&package_context,&current_assets,&event_ids,&episode.id),&methods,|value| {
                            original::pack_event_units(value,&plan,caps["maxDuration"].as_f64().unwrap())?;
                            validate_authored(&source,value,&current_assets,caps,&batch.source_refs,style,&prefix)?;
                            validate_event_bindings(value,&plan)?;validate_fantasy(value,&candidates)?;mark_short_endings(value,minimum_duration);Ok(())
                        }).await?;
                    Ok(finished)
                }.await;
                match batch_result {
                    Ok(finished)=>{
                        accepted_boundary=finished["units"].as_array().unwrap().last().cloned().unwrap();previous_batch=Some(batch.id.clone());
                        created.extend(finished["units"].as_array().unwrap().iter().cloned());realizations.extend(finished["fantasyRealization"].as_array().unwrap().iter().cloned());
                        revision_notes.extend(finished["revisionNotes"].as_array().unwrap().iter().cloned());unresolved.extend(finished["unresolved"].as_array().unwrap().iter().cloned());
                        for id in &batch.package_ids {package_outputs.push((id.clone(),finished.clone()));}
                    }
                    Err(reason)=>{local_blocked.push(json!({"episodeId":episode.id,"executionBatchId":batch.id,"packageIds":batch.package_ids,"status":"blocked","reason":reason}));failed_owners.extend(batch.package_ids.iter().cloned());accepted_boundary=Value::Null;}
                }
            }
            Ok(json!({"draft":{"schemaVersion":"storyboard-draft/v2","units":created,"fantasyRealization":realizations,"revisionNotes":revision_notes,"unresolved":unresolved},"plan":plan,"localBlocked":local_blocked}))
        }.await;
        match result {
            Ok(done) if !done["pendingPlan"].is_null() => {
                plans.push(json!({"episodeId":episode.id,"plan":done["pendingPlan"]}));
                waiting.push(json!({"episodeId":episode.id,"selectionMode":"review","candidates":done["pendingPlan"]["fantasyCandidates"],"allowEmptySelection":true}));
                unavailable.insert(episode.id.clone());
            }
            Ok(done) => {
                let draft = &done["draft"];
                if let Some(last) = draft["units"].as_array().unwrap().last() {
                    previous = last.clone();
                }
                all_units.extend(draft["units"].as_array().unwrap().iter().cloned());
                all_realizations.extend(
                    draft["fantasyRealization"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .cloned(),
                );
                all_revisions.extend(draft["revisionNotes"].as_array().unwrap().iter().cloned());
                all_unresolved.extend(draft["unresolved"].as_array().unwrap().iter().cloned());
                if done["localBlocked"]
                    .as_array()
                    .map(|v| !v.is_empty())
                    .unwrap_or(false)
                {
                    blocked.extend(done["localBlocked"].as_array().unwrap().iter().cloned());
                    unavailable.insert(episode.id.clone());
                } else {
                    updated_episodes.push(episode.id.clone());
                }
                plans.push(json!({"episodeId":episode.id,"plan":done["plan"]}));
            }
            Err(reason) => {
                blocked.push(json!({"episodeId":episode.id,"status":"blocked","reason":reason}));
                unavailable.insert(episode.id.clone());
            }
        }
    }
    Ok(
        json!({"schemaVersion":"storyboard-delivery/v1","sourceSha256":source.sha256,"status":if !waiting.is_empty(){"waiting_decision"}else if !blocked.is_empty(){"partially_blocked"}else{"completed"},"scope":"episodes","updatedEpisodeIds":updated_episodes,"replacedUnitIds":[],"units":all_units,"plans":plans,"waitingDecision":waiting.first(),"waitingDecisions":waiting,"fantasyRealization":all_realizations,"revisionNotes":all_revisions,"unresolved":all_unresolved,"blocked":blocked,"ruleSnapshots":storyboard_rules()}),
    )
}

fn episode_assets(assets: &[Value], episode_id: &str) -> Vec<Value> {
    let mut selected: Vec<Value> = assets
        .iter()
        .filter(|asset| {
            match asset
                .pointer("/applicability/episodes")
                .and_then(Value::as_array)
                .filter(|items| !items.is_empty())
            {
                Some(items) => items.iter().any(|item| item.as_str() == Some(episode_id)),
                None => asset
                    .get("applicability")
                    .and_then(Value::as_array)
                    .filter(|items| !items.is_empty())
                    .map(|items| {
                        items
                            .iter()
                            .any(|item| text(item, "episodeId") == episode_id)
                    })
                    .unwrap_or(true),
            }
        })
        .cloned()
        .collect();
    // Dependency references supply real media identity, not extra appearance.
    let mut cursor = 0;
    while cursor < selected.len() {
        let parent = resolve_asset_dependency(assets, &selected[cursor])
            .ok()
            .flatten();
        if let Some(parent) = parent {
            if !selected.iter().any(|a| text(a, "id") == parent) {
                if let Some(value) = assets.iter().find(|a| text(a, "id") == parent) {
                    let mut value = value.clone();
                    value["materialRole"] = json!("MATERIAL_SOURCE_ONLY");
                    selected.push(value);
                }
            }
        }
        cursor += 1;
    }
    selected
}

fn image_identity(asset: &Value, assets: &[Value]) -> Option<(String, String)> {
    if asset.pointer("/preparation/mode").and_then(Value::as_str) != Some("INLINE") {
        return None;
    }
    let mut current = asset;
    let mut visited = HashSet::new();
    loop {
        if !visited.insert(text(current, "id")) {
            return None;
        }
        if current.pointer("/preparation/mode").and_then(Value::as_str) != Some("INLINE") {
            if current.pointer("/preparation/mode").and_then(Value::as_str) == Some("AUDIO") {
                return None;
            }
            return Some((
                text(current, "id").into(),
                text(current, "variantId").into(),
            ));
        }
        let explicit = resolve_asset_dependency(assets, current).ok().flatten();
        let from = current
            .pointer("/preparation/fromKey")
            .and_then(Value::as_str)
            .unwrap_or("");
        let candidates: Vec<_> = assets
            .iter()
            .filter(|other| {
                text(other, "id") != text(current, "id")
                    && (explicit.as_deref() == Some(text(other, "id"))
                        || !from.is_empty()
                            && [
                                text(other, "id"),
                                text(other, "key"),
                                text(other, "baseAssetId"),
                            ]
                            .contains(&from))
            })
            .collect();
        current = match candidates.as_slice() {
            [one] => one,
            [..] => {
                let baseline: Vec<_> = assets
                    .iter()
                    .filter(|other| {
                        text(other, "id") != text(current, "id")
                            && !text(current, "baseAssetId").is_empty()
                            && text(other, "baseAssetId") == text(current, "baseAssetId")
                            && other
                                .get("sourceVariantId")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .is_empty()
                            && other.pointer("/preparation/mode").and_then(Value::as_str)
                                != Some("INLINE")
                            && other.pointer("/preparation/mode").and_then(Value::as_str)
                                != Some("AUDIO")
                    })
                    .collect();
                if !candidates.is_empty() && candidates.len() != 1 {
                    return None;
                }
                match baseline.as_slice() {
                    [one] => one,
                    _ => return None,
                }
            }
        };
    }
}

fn materialize_asset_references(draft: &mut Value, assets: &[Value]) -> Result<(), String> {
    for unit in draft["units"].as_array_mut().ok_or("缺少分镜单元")? {
        let mut sound_sources = unit["soundSources"].as_array().cloned().unwrap_or_default();
        let owned = strings(unit, "sourceRefs")?;
        for sound in &sound_sources {
            if !assets.iter().any(|a| {
                text(a, "id") == text(sound, "assetId")
                    && text(a, "variantId") == text(sound, "variantId")
                    && a.pointer("/preparation/mode").and_then(Value::as_str) == Some("AUDIO")
            }) || strings(sound, "sourceRefs")?
                .iter()
                .any(|r| !owned.contains(r))
            {
                return Err("声音源身份或源范围失效".into());
            }
        }
        let mut references = Vec::new();
        for mut reference in unit["assetRefs"].as_array().ok_or("缺少资产引用")?.clone() {
            let asset = assets
                .iter()
                .find(|a| {
                    text(a, "id") == text(&reference, "assetId")
                        && text(a, "variantId") == text(&reference, "variantId")
                })
                .ok_or("分镜引用未知资产/形象")?;
            let mode = asset
                .pointer("/preparation/mode")
                .and_then(Value::as_str)
                .unwrap_or("");
            if mode == "AUDIO" {
                // A story voice identity is evidence, not an imported audio file.
                let refs = strings(&reference, "sourceRefs")?;
                if refs.is_empty() || refs.iter().any(|r| !owned.contains(r)) {
                    return Err("声音源引用越出本单元原文".into());
                }
                let sound = json!({"assetId":reference["assetId"],"variantId":reference["variantId"],"sourceRefs":reference["sourceRefs"],"materialStatus":"SOURCE_ONLY"});
                if !sound_sources.contains(&sound) {
                    sound_sources.push(sound);
                }
                continue;
            }
            let map = reference.as_object_mut().ok_or("资产引用不是对象")?;
            map.remove("imageAssetId");
            map.remove("imageVariantId");
            if mode == "INLINE" {
                if let Some((id, variant)) = image_identity(asset, assets) {
                    map.insert("imageAssetId".into(), json!(id));
                    map.insert("imageVariantId".into(), json!(variant));
                } else {
                    map.insert("imageBindingRequired".into(), json!(true));
                }
            }
            reference["order"] = json!(references.len() + 1);
            references.push(reference);
        }
        unit["assetRefs"] = json!(references);
        unit["soundSources"] = json!(sound_sources);
    }
    Ok(())
}

fn scoped_facts(input: &Value, rows: &[SourceRow], context: &[SourceRow]) -> Vec<Value> {
    input
        .pointer("/foundation/facts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|fact| {
            fact["sourceRefs"]
                .as_array()
                .map(|refs| {
                    refs.iter()
                        .filter_map(Value::as_str)
                        .any(|id| rows.iter().chain(context).any(|row| row.id == id))
                })
                .unwrap_or(false)
        })
        .map(|fact| {
            let mut fact = fact.clone();
            if let Some(map) = fact.as_object_mut() {
                map.remove("quotes");
            }
            fact
        })
        .collect()
}

fn methods_for(
    rows: &[SourceRow],
    selected: &[Value],
    scenario_keys: &[String],
    finish: bool,
    entry_facts: &[Value],
) -> Result<Vec<&'static str>, String> {
    let mut methods = vec![
        "storyboard-common",
        "acting-blocking",
        "camera-emotion",
        "lighting-space",
        "sound-rhythm",
    ];
    let cue=regex::Regex::new(r"(?i)(?:Q|Ｑ)(?:版|化|形体)|梦境|梦中|梦里|主观(?:画面|镜头|空间)|(?:幻想|想象)(?:画面|空间)|小化身|(?:内心|心理|主观)小人|(?:二维|2D)[^。！？!?；;\n]{0,24}(?:小人|化身)").unwrap();
    if !selected.is_empty()
        || rows.iter().any(|row| cue.is_match(&row.text))
        || entry_facts
            .iter()
            .any(|fact| cue.is_match(text(fact, "statement")))
    {
        methods.push("fantasy-expression");
    }
    for key in scenario_keys {
        let name = original::scenario_rule(key).ok_or_else(|| format!("方法卡不存在：{key}"))?;
        if !methods.contains(&name) {
            methods.push(name);
        }
    }
    if finish {
        for key in ["editing-integrity", "camera-path-repair"] {
            let name = original::scenario_rule(key).unwrap();
            if !methods.contains(&name) {
                methods.push(name);
            }
        }
    }
    Ok(methods)
}

fn validate_authored(
    source: &LockedSource,
    draft: &mut Value,
    assets: &[Value],
    caps: &Value,
    refs: &[String],
    style: &str,
    prefix: &str,
) -> Result<(), String> {
    if text(draft, "schemaVersion") != "storyboard-draft/v2" {
        return Err("新分镜创作须返回storyboard-draft/v2原话区间协议".into());
    }
    materialize_dialogue(source, draft, false)?;
    materialize_asset_references(draft, assets)?;
    prefix_ids(draft, prefix)?;
    add_delivery_fields(draft, style)?;
    validate_storyboard_scope(source, draft, assets, caps, Some(refs))?;
    materialize_unit_coverage(source, draft)
}

fn mark_short_endings(draft: &mut Value, minimum: f64) {
    for unit in draft["units"].as_array_mut().unwrap() {
        if unit["duration"].as_f64().unwrap() < minimum {
            unit["capacityIssues"] = json!([{"code":"BELOW_CHANNEL_MINIMUM","message":"源范围自然短收；当前渠道最小时长未满足，请调整渠道或合法单元组合，不新增空白或源外剧情。","minimum":minimum}]);
        }
    }
}

fn storyboard_rules() -> Vec<RuleSnapshot> {
    rule_snapshots()
        .into_iter()
        .filter(|rule| {
            [
                "episode-emotion-planner",
                "unit-performance-director",
                "episode-finishing-editor",
                "acting-blocking",
                "camera-emotion",
                "lighting-space",
                "sound-rhythm",
                "fantasy-expression",
            ]
            .contains(&rule.id.as_str())
                || rule.id.starts_with("storyboard-")
        })
        .collect()
}

async fn run_storyboard_revision(
    source: &LockedSource,
    input: &Value,
    executor: &dyn TextExecutor,
    model: &str,
    reasoning: &str,
) -> Result<Value, String> {
    let selected = strings(&input["selection"], "unitIds")?;
    let selected_ids: HashSet<_> = selected.iter().map(String::as_str).collect();
    if selected_ids.len() != selected.len() {
        return Err("重做单元不能重复选择".into());
    }
    let existing = input["existingUnits"]
        .as_array()
        .ok_or("局部重做缺少冻结的原单元")?;
    if selected
        .iter()
        .any(|id| !existing.iter().any(|unit| text(unit, "id") == id))
    {
        return Err("所选重做单元不在冻结版本中".into());
    }
    let instruction = text(input, "revisionInstruction").trim();
    if instruction.is_empty() {
        return Err("请写明本次单元重做要求".into());
    }
    let caps = input.get("capabilities").ok_or("缺少冻结的分镜制作规格")?;
    let (minimum, _, _) = capabilities(input)?;
    let assets = input["assets"].as_array().ok_or("缺少资产身份目录")?;
    let settings = creative_settings(&input["settings"]);
    let style = text(&settings, "visualStyle");
    let direction = production_direction(input);
    let mut units = Vec::new();
    let mut replaced = Vec::new();
    let mut updated = Vec::new();
    let mut blocked = Vec::new();
    let mut revisions = Vec::new();
    let mut unresolved = Vec::new();
    let mut realized = Vec::new();
    let mut impacts = Vec::new();
    let mut unavailable = HashSet::new();
    let mut accepted_boundaries: HashMap<String, Value> = HashMap::new();
    for (episode_position, episode) in source.episodes.iter().enumerate() {
        let mut episode_units: Vec<_> = existing
            .iter()
            .filter(|unit| text(unit, "episodeId") == episode.id)
            .cloned()
            .collect();
        episode_units.sort_by_key(|unit| unit_source_position(source, unit));
        let target_positions: Vec<_> = episode_units
            .iter()
            .enumerate()
            .filter(|(_, unit)| selected_ids.contains(text(unit, "id")))
            .map(|(index, _)| index)
            .collect();
        if target_positions.is_empty() {
            continue;
        }
        let prior_id = episode_position
            .checked_sub(1)
            .map(|index| source.episodes[index].id.as_str());
        if prior_id.map(|id| unavailable.contains(id)).unwrap_or(false) {
            blocked.push(json!({"episodeId":episode.id,"status":"waiting_dependency","dependsOn":prior_id,"reason":"连续前集重做尚未完成，先处理前置再继续。"}));
            unavailable.insert(episode.id.clone());
            continue;
        }
        // Include intervening units and all units sharing a split source line.
        // The published replacement set is explicit; no unrelated episode runs.
        let mut first = *target_positions.first().unwrap();
        let mut last = *target_positions.last().unwrap();
        loop {
            let refs: HashSet<_> = episode_units[first..=last]
                .iter()
                .flat_map(|unit| strings(unit, "sourceRefs").unwrap_or_default())
                .collect();
            let shared: Vec<_> = episode_units
                .iter()
                .enumerate()
                .filter(|(_, unit)| {
                    strings(unit, "sourceRefs")
                        .unwrap_or_default()
                        .iter()
                        .any(|id| refs.contains(id))
                })
                .map(|(index, _)| index)
                .collect();
            let next_first = shared.iter().copied().min().unwrap_or(first).min(first);
            let next_last = shared.iter().copied().max().unwrap_or(last).max(last);
            if (first, last) == (next_first, next_last) {
                break;
            }
            first = next_first;
            last = next_last;
        }
        let originals = &episode_units[first..=last];
        let target_refs: HashSet<_> = originals
            .iter()
            .flat_map(|unit| strings(unit, "sourceRefs").unwrap_or_default())
            .collect();
        let rows: Vec<_> = source
            .rows
            .iter()
            .filter(|row| {
                row.kind == "body"
                    && row.episode_id.as_ref() == Some(&episode.id)
                    && target_refs.contains(&row.id)
            })
            .cloned()
            .collect();
        let refs: Vec<_> = rows.iter().map(|row| row.id.clone()).collect();
        let current_assets = episode_assets(assets, &episode.id);
        let context = relevant_context(
            source,
            episode,
            &current_assets,
            input.get("foundation").unwrap_or(&Value::Null),
        );
        let facts = scoped_facts(input, &rows, &context);
        let before = first
            .checked_sub(1)
            .map(|index| &episode_units[index])
            .or_else(|| prior_id.and_then(|id| accepted_boundaries.get(id)))
            .or_else(|| input.get("previousBoundary"));
        let after = episode_units.get(last + 1);
        let candidates: Vec<_> = input["selectedFantasy"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|candidate| {
                strings(candidate, "sourceRefs")
                    .map(|ids| ids.iter().any(|id| target_refs.contains(id)))
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        let methods = methods_for(&rows, &candidates, &[], false, &facts)?;
        let mut events = Vec::new();
        for scene in source
            .scenes
            .iter()
            .filter(|scene| scene.episode_id == episode.id)
        {
            let scene_refs: Vec<_> = rows
                .iter()
                .filter(|row| row.scene_id.as_ref() == Some(&scene.id))
                .map(|row| row.id.clone())
                .collect();
            if !scene_refs.is_empty() {
                events.push(json!({"id":format!("revision:{}",scene.id),"sceneId":scene.id,"sourceRefs":scene_refs}));
            }
        }
        let plan = json!({"events":events});
        let event_ids: Vec<_> = plan["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| text(event, "id").to_string())
            .collect();
        let identity = digest(&json!({"source":source.sha256,"originals":originals,"instruction":instruction,"caps":caps,"direction":direction,"settings":settings}).to_string());
        let prefix = format!("{}:revision:{}:", episode.id, &identity[..12]);
        let result: Result<Value,String> = async {
            if refs.is_empty() || target_refs.len()!=refs.len() { return Err("原单元来源已失效，请按当前原文重新创作整集".into()); }
            let authored = call_validated(executor,"storyboardCreate","unit-performance-director",model,reasoning,
                json!({"mode":"revision","episodeId":episode.id,"productionDirection":direction,"sourceRows":rows,"contextRows":context,"facts":facts,"assets":current_assets,"events":plan["events"],"revisionTargetUnits":originals,"revisionInstruction":instruction,"acceptedContinuity":before,"nextBoundary":after,"selectedFantasy":candidates,"settings":settings,"capabilities":caps,"instruction":"仅重做本源范围，保留完整源事实、原话和前后连续状态。可拆合；对白仅选lineId与绝对UTF16原话区间，不发声演法。"}),
                draft_schema(&rows,&context,&current_assets,&event_ids,&episode.id),&methods,|value| {
                    validate_authored(source,value,&current_assets,caps,&refs,style,&format!("{prefix}create:"))?;
                    validate_event_bindings(value,&plan)?;
                    validate_fantasy(value,&candidates)
                }).await?;
            let finish_methods=methods_for(&rows,&candidates,&[],true,&facts)?;
            let finished = call_validated(executor,"storyboardFinish","episode-finishing-editor",model,reasoning,
                json!({"mode":"revision","episodeId":episode.id,"productionDirection":direction,"sourceRows":rows,"contextRows":context,"facts":facts,"assets":current_assets,"plan":plan,"draft":authored,"revisionTargetUnits":originals,"revisionInstruction":instruction,"previousBoundary":before,"nextBoundary":after,"selectedFantasy":candidates,"settings":settings,"capabilities":caps,"instruction":"直接修好本关联范围；不改写无关单元。输出完整范围，按新切点选择原话区间并重算声窗。"}),
                draft_schema(&rows,&context,&current_assets,&event_ids,&episode.id),&finish_methods,|value| {
                    original::pack_event_units(value,&plan,caps["maxDuration"].as_f64().unwrap())?;
                    validate_authored(source,value,&current_assets,caps,&refs,style,&prefix)?;
                    validate_event_bindings(value,&plan)?;
                    validate_fantasy(value,&candidates)?;
                    preserve_revision_ids(value,originals)?;
                    let mut combined=episode_units[..first].to_vec();
                    combined.extend(value["units"].as_array().unwrap().iter().cloned());
                    combined.extend(episode_units[last+1..].iter().cloned());
                    validate_storyboard(source,&json!({"units":combined}),assets,caps)
                        .map_err(|reason|format!("局部重做与本集未改部分不一致：{reason}"))?;
                    mark_short_endings(value,minimum);
                    Ok(())
                }).await?;
            Ok(finished)
        }.await;
        match result {
            Ok(draft) => {
                let new_last = draft["units"].as_array().unwrap().last().unwrap();
                accepted_boundaries.insert(
                    episode.id.clone(),
                    if last + 1 == episode_units.len() {
                        new_last.clone()
                    } else {
                        episode_units.last().unwrap().clone()
                    },
                );
                if let Some(next) = after {
                    if text(originals.last().unwrap(), "exitState") != text(new_last, "exitState") {
                        impacts.push(json!({"episodeId":episode.id,"fromUnitId":new_last["id"],"nextUnitId":next["id"],"reason":"重做范围末态变化，后继初态需重新核对。"}));
                    }
                }
                units.extend(draft["units"].as_array().unwrap().iter().cloned());
                replaced.extend(originals.iter().map(|unit| text(unit, "id").to_string()));
                updated.push(episode.id.clone());
                revisions.extend(draft["revisionNotes"].as_array().unwrap().iter().cloned());
                unresolved.extend(draft["unresolved"].as_array().unwrap().iter().cloned());
                realized.extend(
                    draft["fantasyRealization"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .cloned(),
                );
            }
            Err(reason) => {
                unavailable.insert(episode.id.clone());
                blocked.push(json!({"episodeId":episode.id,"unitIds":originals.iter().map(|unit|text(unit,"id")).collect::<Vec<_>>(),"reason":reason}));
            }
        }
    }
    Ok(
        json!({"schemaVersion":"storyboard-delivery/v1","sourceSha256":source.sha256,"scope":"units","status":if blocked.is_empty(){"completed"}else{"partially_blocked"},"updatedEpisodeIds":updated,"replacedUnitIds":replaced,"units":units,"plans":[],"waitingDecision":null,"waitingDecisions":[],"continuityImpacts":impacts,"fantasyRealization":realized,"revisionNotes":revisions,"unresolved":unresolved,"blocked":blocked,"ruleSnapshots":storyboard_rules()}),
    )
}

fn unit_source_position(source: &LockedSource, unit: &Value) -> usize {
    unit["sourceCoverage"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|range| range["start"].as_u64().map(|start| start as usize))
        .min()
        .or_else(|| {
            strings(unit, "sourceRefs").ok().and_then(|refs| {
                source
                    .rows
                    .iter()
                    .filter(|row| refs.contains(&row.id))
                    .map(|row| row.range.start)
                    .min()
            })
        })
        .unwrap_or(usize::MAX)
}

fn preserve_revision_ids(draft: &mut Value, originals: &[Value]) -> Result<(), String> {
    let units = draft["units"].as_array_mut().ok_or("重做缺少单元")?;
    if units.len() != originals.len() {
        return Ok(());
    }
    let mut ids = HashMap::new();
    for (unit, original) in units.iter_mut().zip(originals) {
        ids.insert(
            text(unit, "id").to_string(),
            text(original, "id").to_string(),
        );
        unit["id"] = original["id"].clone();
    }
    for realization in draft["fantasyRealization"]
        .as_array_mut()
        .ok_or("缺少幻想记录")?
    {
        for id in realization["unitIds"]
            .as_array_mut()
            .ok_or("幻想单元引用无效")?
        {
            if let Some(next) = ids.get(id.as_str().ok_or("幻想单元id无效")?) {
                *id = json!(next);
            }
        }
    }
    Ok(())
}

fn materialize_unit_coverage(source: &LockedSource, draft: &mut Value) -> Result<(), String> {
    materialize_dialogue(source, draft, true)?;
    let mut quote_offsets: HashMap<String, usize> = HashMap::new();
    let mut covered_actions = HashSet::new();
    for unit in draft
        .get_mut("units")
        .and_then(Value::as_array_mut)
        .ok_or("缺少单元")?
    {
        let mut ranges = Vec::new();
        for row_id in strings(unit, "sourceRefs")? {
            let row = source
                .rows
                .iter()
                .find(|r| r.id == row_id)
                .ok_or("来源行不存在")?;
            if let Some(q) = &row.dialogue {
                let old = *quote_offsets.get(&q.id).unwrap_or(&row.range.start);
                let fragments: Vec<_> = unit["shots"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .flat_map(|s| s["dialogueParts"].as_array().unwrap())
                    .filter(|p| text(p, "lineId") == q.id)
                    .map(|p| p["quoteEnd"].as_u64().unwrap() as usize)
                    .collect();
                if fragments.is_empty() && expected_spoken(source, q)?.is_empty() {
                    if covered_actions.insert(row.id.clone()) {
                        ranges.push(
                            json!({"rowId":row.id,"start":row.range.start,"end":row.range.end}),
                        );
                    }
                    continue;
                }
                if fragments.is_empty() {
                    return Err("单元重复引用一行对白却没有承担对应原句片段".into());
                }
                let last = *fragments.last().unwrap();
                let spoken_end = spoken_ranges(q)
                    .last()
                    .map(|range| range.end)
                    .unwrap_or(q.range.end);
                let new = if last == spoken_end {
                    row.range.end
                } else {
                    last
                };
                ranges.push(json!({"rowId":row.id,"start":old,"end":new,"dialogueId":q.id}));
                quote_offsets.insert(q.id.clone(), new);
            } else if covered_actions.insert(row.id.clone()) {
                ranges.push(json!({"rowId":row.id,"start":row.range.start,"end":row.range.end}));
            }
        }
        unit["sourceCoverage"] = json!(ranges);
    }
    Ok(())
}

fn prefix_ids(draft: &mut Value, prefix: &str) -> Result<(), String> {
    let mut units_map = HashMap::new();
    let mut shots_map = HashMap::new();
    for unit in draft
        .get_mut("units")
        .and_then(Value::as_array_mut)
        .ok_or("缺少单元")?
    {
        let old = text(unit, "id").to_string();
        let new = if old.starts_with(prefix) {
            old.clone()
        } else {
            format!("{prefix}{old}")
        };
        if units_map.insert(old, new.clone()).is_some() {
            return Err("模型单元 id 重复".into());
        }
        unit["id"] = json!(new);
        for shot in unit
            .get_mut("shots")
            .and_then(Value::as_array_mut)
            .ok_or("缺少镜表")?
        {
            let old = text(shot, "id").to_string();
            let new = if old.starts_with(prefix) {
                old.clone()
            } else {
                format!("{prefix}{old}")
            };
            if shots_map.insert(old, new.clone()).is_some() {
                return Err("模型镜号重复".into());
            }
            shot["id"] = json!(new);
        }
    }
    // Event packing's segment headers refer to generated shot IDs. Keep those
    // references aligned when a finished response introduced fresh local IDs;
    // remap only program-created header tokens, never source dialogue text.
    for unit in draft["units"].as_array_mut().unwrap() {
        let mut headers = Vec::new();
        if let Some(segments) = unit["segments"].as_array_mut() {
            for segment in segments {
                let ids = segment["shotIds"].as_array_mut().ok_or("联排段缺少镜号")?;
                let old: Vec<_> = ids
                    .iter()
                    .map(|id| id.as_str().map(str::to_string).ok_or("联排段镜号无效"))
                    .collect::<Result<_, _>>()?;
                for id in ids.iter_mut() {
                    *id = json!(shots_map
                        .get(id.as_str().unwrap())
                        .ok_or("联排段引用未知镜号")?);
                }
                if let (Some(a), Some(b), Some(c), Some(d)) = (
                    old.first(),
                    old.last(),
                    ids.first().and_then(Value::as_str),
                    ids.last().and_then(Value::as_str),
                ) {
                    headers.push((format!("【{a}—{b}】"), format!("【{c}—{d}】")));
                    headers.push((format!("【{a}起承接】"), format!("【{c}起承接】")));
                }
            }
        }
        for key in ["unitDirection", "lighting", "initialState"] {
            if let Some(value) = unit[key].as_str() {
                let mut updated = value.to_string();
                for (before, after) in &headers {
                    updated = updated.replace(before, after);
                }
                unit[key] = json!(updated);
            }
        }
    }
    for realization in draft
        .get_mut("fantasyRealization")
        .and_then(Value::as_array_mut)
        .ok_or("缺少幻想兑现记录")?
    {
        for (field, map) in [("unitIds", &units_map), ("shotIds", &shots_map)] {
            for id in realization
                .get_mut(field)
                .and_then(Value::as_array_mut)
                .ok_or("幻想记录引用不是数组")?
            {
                let old = id.as_str().ok_or("幻想记录 id 无效")?;
                *id = json!(map.get(old).ok_or("幻想记录引用不存在单元/镜号")?);
            }
        }
    }
    Ok(())
}

fn validate_fantasy(draft: &Value, selected: &[Value]) -> Result<(), String> {
    let realized = draft
        .get("fantasyRealization")
        .and_then(Value::as_array)
        .ok_or("缺少幻想兑现记录")?;
    let mut seen = HashSet::new();
    for r in realized {
        let id = text(r, "candidateId");
        if !selected.iter().any(|c| text(c, "id") == id) || !seen.insert(id) {
            return Err("未选幻想被执行或兑现记录重复".into());
        }
        let seconds = r
            .get("screenSeconds")
            .and_then(Value::as_f64)
            .filter(|s| s.is_finite() && *s > 0.0)
            .ok_or("幻想占时须与实际演出相符")?;
        let unit_ids = strings(r, "unitIds")?;
        let shot_ids = strings(r, "shotIds")?;
        if unit_ids.is_empty()
            || shot_ids.is_empty()
            || text(r, "entry").trim().is_empty()
            || text(r, "exit").trim().is_empty()
        {
            return Err("已选幻想缺少实际入出或镜引用".into());
        }
        let available: f64 = draft["units"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|u| unit_ids.iter().any(|id| id == text(u, "id")))
            .flat_map(|u| u["shots"].as_array().unwrap())
            .filter(|s| shot_ids.iter().any(|id| id == text(s, "id")))
            .filter_map(|s| s["duration"].as_f64())
            .sum();
        if seconds > available + 0.001 {
            return Err("幻想占时超出引用镜长".into());
        }
    }
    if selected.iter().any(|c| !seen.contains(text(c, "id"))) {
        return Err("已选幻想机会未实际兑现，不能静默删掉".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (LockedSource, Value, Vec<Value>, Value) {
        let source = prepare_source("第一集\n场景：门口\n小王OS：“先走，别回头😀。”\n").unwrap();
        let row = &source.rows[2];
        let q = row.dialogue.as_ref().unwrap();
        let eid = &source.episodes[0].id;
        let sid = &source.scenes[0].id;
        let assets = vec![
            json!({"id":"王:白衣","variantId":"白衣","applicability":{"episodes":[eid],"scenes":[sid]}}),
        ];
        let draft = json!({"schemaVersion":"storyboard-draft/v1","units":[{"id":"U1","episodeId":eid,"eventId":"E1","sceneId":sid,"title":"走","unitDirection":"她推门，他在画外说话。","scene":"门口","initialState":"小王站在门边。","exitState":"门打开。","lighting":"门外侧光","sourceRefs":[row.id],"assetRefs":[{"assetId":"王:白衣","variantId":"白衣","order":1,"use":"character","sourceRefs":[row.id]}],"shots":[{"id":"S1","duration":3.0,"camera":"近景","picture":"小王推门。","lighting":"侧光","sound":"门轴声","transition":"切到门外","sourceRefs":[row.id],"contextRefs":[],"dialogueParts":[{"lineId":q.id,"text":q.quote,"speaker":"小王","channel":"OS","presentation":"OS","voiceStart":0.0,"voiceEnd":2.9,"delivery":"压低声音"}]}]}],"fantasyRealization":[],"revisionNotes":[],"unresolved":[]});
        (
            source,
            draft,
            assets,
            json!({"minDuration":0,"maxDuration":15,"imageLimit":1}),
        )
    }
    #[test]
    fn exact_source_dialogue_passes_and_rephrasing_fails() {
        let (s, mut d, a, c) = fixture();
        validate_storyboard(&s, &d, &a, &c).unwrap();
        d["units"][0]["shots"][0]["dialogueParts"][0]["text"] = json!("先走，别回头。");
        assert!(validate_storyboard(&s, &d, &a, &c).is_err());
    }
    #[test]
    fn voice_windows_assets_and_capacity_cannot_be_clamped() {
        let (s, mut d, a, c) = fixture();
        d["units"][0]["shots"][0]["dialogueParts"][0]["voiceEnd"] = json!(4.0);
        assert!(validate_storyboard(&s, &d, &a, &c).is_err());
        let (_, mut d, _, _) = fixture();
        d["units"][0]["assetRefs"][0]["variantId"] = json!("战损");
        assert!(validate_storyboard(&s, &d, &a, &c).is_err());
        let (_, mut d, _, _) = fixture();
        d["units"][0]["shots"][0]["duration"] = json!(16.0);
        assert!(validate_storyboard(&s, &d, &a, &c).is_err());
    }
    #[test]
    fn splitting_preserves_exact_quote_once() {
        let (s, mut d, a, c) = fixture();
        let q = s.rows[2].dialogue.as_ref().unwrap();
        let mut shot = d["units"][0]["shots"][0].clone();
        d["units"][0]["shots"][0]["dialogueParts"][0]["text"] = json!("“先走，");
        shot["id"] = json!("S2");
        shot["dialogueParts"][0]["text"] = json!("别回头😀。”");
        d["units"][0]["shots"].as_array_mut().unwrap().push(shot);
        validate_storyboard(&s, &d, &a, &c).unwrap();
        assert_eq!(q.quote, "“先走，别回头😀。”");
    }

    #[test]
    fn inline_variant_uses_exact_parent_image_without_losing_semantic_state() {
        let (source, mut draft, mut assets, caps) = fixture();
        assets[0]["baseAssetId"] = json!("王");
        assets[0]["preparation"] = json!({"mode":"GENERATE"});
        let mut child = assets[0].clone();
        child["id"] = json!("王:伤态");
        child["variantId"] = json!("hurt");
        child["sourceAssetId"] = assets[0]["id"].clone();
        child["sourceVariantId"] = assets[0]["variantId"].clone();
        child["preparation"] =
            json!({"mode":"INLINE","fromKey":"王:白衣","note":"伤态在当前画面表达"});
        assets.push(child);
        let mut reference = draft["units"][0]["assetRefs"][0].clone();
        reference["assetId"] = json!("王:伤态");
        reference["variantId"] = json!("hurt");
        reference["order"] = json!(2);
        draft["units"][0]["assetRefs"]
            .as_array_mut()
            .unwrap()
            .push(reference);
        materialize_asset_references(&mut draft, &assets).unwrap();
        assert_eq!(draft["units"][0]["assetRefs"][1]["assetId"], "王:伤态");
        assert_eq!(draft["units"][0]["assetRefs"][1]["imageAssetId"], "王:白衣");
        validate_storyboard(&source, &draft, &assets, &caps).unwrap();
        draft["units"][0]["assetRefs"][1]["imageAssetId"] = json!("冒名父图");
        assert!(validate_storyboard(&source, &draft, &assets, &caps)
            .unwrap_err()
            .contains("来源关系"));
    }

    #[test]
    fn audio_source_is_evidence_and_never_an_image_or_fabricated_audio_import() {
        let (source, mut draft, mut assets, _) = fixture();
        assets[0]["preparation"] = json!({"mode":"AUDIO"});
        materialize_asset_references(&mut draft, &assets).unwrap();
        assert_eq!(draft["units"][0]["assetRefs"], json!([]));
        assert_eq!(
            draft["units"][0]["soundSources"][0]["materialStatus"],
            "SOURCE_ONLY"
        );
        validate_storyboard(
            &source,
            &draft,
            &assets,
            &json!({"minDuration":0,"maxDuration":15,"imageLimit":0}),
        )
        .unwrap();
        let before = draft.clone();
        materialize_asset_references(&mut draft, &assets).unwrap();
        assert_eq!(draft, before);
        draft["units"][0]["soundSources"][0]["sourceRefs"] = json!(["foreign-source"]);
        assert!(materialize_asset_references(&mut draft, &assets).is_err());
    }
    struct Authored {
        plan: Value,
        draft: Value,
        stages: tokio::sync::Mutex<Vec<String>>,
    }
    #[async_trait]
    impl TextExecutor for Authored {
        async fn execute(&self, request: TextRequest) -> Result<Value, String> {
            self.stages.lock().await.push(request.stage.clone());
            assert_eq!(request.rule_snapshot["primary"]["id"], request.skill);
            if request.stage == "storyboardPlan" {
                Ok(self.plan.clone())
            } else {
                let mut draft = self.draft.clone();
                draft["schemaVersion"] = json!("storyboard-draft/v2");
                let mut offsets: HashMap<String, usize> = HashMap::new();
                for unit in draft["units"].as_array_mut().unwrap() {
                    for shot in unit["shots"].as_array_mut().unwrap() {
                        for part in shot["dialogueParts"].as_array_mut().unwrap() {
                            let id = text(part, "lineId").to_string();
                            let quote = request.input["sourceRows"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .find_map(|row| {
                                    let quote = &row["dialogue"];
                                    (text(quote, "id") == id).then_some(quote)
                                })
                                .unwrap();
                            let old = *offsets.get(&id).unwrap_or(&0);
                            let count = text(part, "text").encode_utf16().count();
                            let start = quote["spokenSegments"][0]["range"]["start"]
                                .as_u64()
                                .unwrap() as usize
                                + old;
                            offsets.insert(id, old + count);
                            part["quoteStart"] = json!(start);
                            part["quoteEnd"] = json!(start + count);
                            let map = part.as_object_mut().unwrap();
                            map.remove("text");
                            map.remove("speaker");
                            map.remove("channel");
                        }
                    }
                }
                Ok(draft)
            }
        }
    }
    #[tokio::test]
    async fn three_roles_emit_bound_independently_usable_units() {
        let (s, mut draft, assets, caps) = fixture();
        let eid = &s.episodes[0].id;
        let sid = &s.scenes[0].id;
        let row = &s.rows[2].id;
        draft["units"][0]["participants"] = json!(["小王"]);
        draft["units"][0]["props"] = json!([]);
        draft["units"][0]["boundaryBefore"] =
            json!({"kind":"episode_start","reason":"当前集源开始"});
        let emotion = json!({"subject":"小王","contextTone":"急迫","audienceEffect":"离开决定可读","change":"被追赶后决定离开","landing":"推门出去","retain":["原话"]});
        let mut plan = json!({"schemaVersion":"storyboard-plan/v2","emotionArc":"离开","events":[{"id":"E1","sceneId":sid,"sourceRefs":[row],"boundaryBefore":{"kind":"episode_start","reason":"当前集源开始"},"emotionContract":emotion}],"workPackages":[{"id":"W1","eventId":"E1","sourceRefs":[row],"contextRefs":[],"entryFactIds":[],"dependsOn":[],"emotionContract":emotion}],"entryFacts":[],"fantasyCandidates":[]});
        plan["unitPackingPolicy"] = json!("event-first-v1");
        plan["provisionalUnits"] =
            json!([{"id":"P1","packageId":"W1","sourceRefs":[row],"secondsRange":[2,3]}]);
        plan["workPackages"][0]["scenarioKeys"] = json!([]);
        let exec = Authored {
            plan,
            draft,
            stages: tokio::sync::Mutex::new(vec![]),
        };
        let output=run_storyboard(&json!({"source":s,"assets":assets,"capabilities":caps,"settings":{"fantasyMode":"off","visualStyle":"16:9真人"},"episodeId":eid}),&exec,"gpt-6.1-sol","medium").await.unwrap();
        assert!(output["blocked"].as_array().unwrap().is_empty());
        assert_eq!(output["units"].as_array().unwrap().len(), 1);
        assert_eq!(
            *exec.stages.lock().await,
            vec!["storyboardPlan", "storyboardCreate", "storyboardFinish"]
        );
        assert_eq!(output["units"][0]["duration"], 3.0);
        let prompt = output["units"][0]["prompt"].as_str().unwrap();
        assert!(prompt.contains("{{asset:王:白衣:白衣}}"));
        assert!(prompt.contains("“先走，别回头😀。”"));
        assert!(prompt.contains("初态：小王站在门边。"));
    }
    #[test]
    fn cross_unit_quote_fragments_have_program_owned_nonoverlapping_coverage() {
        let (s, mut draft, assets, caps) = fixture();
        let mut second = draft["units"][0].clone();
        draft["units"][0]["shots"][0]["dialogueParts"][0]["text"] = json!("“先走，");
        second["id"] = json!("U2");
        second["shots"][0]["id"] = json!("S2");
        second["shots"][0]["dialogueParts"][0]["text"] = json!("别回头😀。”");
        draft["units"].as_array_mut().unwrap().push(second);
        validate_storyboard(&s, &draft, &assets, &caps).unwrap();
        materialize_unit_coverage(&s, &mut draft).unwrap();
        assert_eq!(
            draft["units"][0]["sourceCoverage"][0]["end"],
            draft["units"][1]["sourceCoverage"][0]["start"]
        );
        assert_eq!(
            draft["units"][0]["sourceCoverage"][0]["start"],
            s.rows[2].range.start
        );
        assert_eq!(
            draft["units"][1]["sourceCoverage"][0]["end"],
            s.rows[2].range.end
        );
    }
}

#[cfg(test)]
mod production_contract_tests {
    use super::*;
    use tokio::sync::Mutex;

    #[derive(Default)]
    struct Recorded {
        calls: Mutex<Vec<TextRequest>>,
        accepted: Mutex<HashMap<String, Value>>,
        rejected: Mutex<Vec<String>>,
        fantasy: bool,
        fail_episode: String,
        invalid_interval: bool,
        rough_per_row: bool,
    }

    fn mock_plan(request: &TextRequest, fantasy: bool) -> Value {
        let rows = request.input["sourceRows"].as_array().unwrap();
        let refs: Vec<_> = rows.iter().map(|row| row["id"].clone()).collect();
        let emotion = json!({"subject":"人物","contextTone":"当前源情境","audienceEffect":"真实回应可读","change":"依源事实回应","landing":"真实结果可见","retain":["源动作与原话"]});
        let mut value = json!({"schemaVersion":"storyboard-plan/v2","emotionArc":"因果回应",
            "events":[{"id":"E1","sceneId":rows[0]["sceneId"],"sourceRefs":refs,"boundaryBefore":{"kind":"episode_start","reason":"本集开始"},"emotionContract":emotion}],
            "workPackages":[{"id":"W1","eventId":"E1","sourceRefs":refs,"contextRefs":[],"entryFactIds":[],"dependsOn":[],"emotionContract":emotion}],"entryFacts":[],
            "fantasyCandidates":if fantasy {json!([{"id":"F1","sourceRefs":[rows[0]["id"]],"subject":"人物","emotionPurpose":"情绪重音","recommended":false,"proposal":"具象变化"}])}else{json!([])}});
        value["unitPackingPolicy"] = json!("event-first-v1");
        value["workPackages"][0]["scenarioKeys"] = json!([]);
        value["provisionalUnits"] = json!([{"id":"P1","packageId":"W1","sourceRefs":refs,"secondsRange":[3,rows.len() as f64*3.0]}]);
        for candidate in value["fantasyCandidates"].as_array_mut().unwrap() {
            candidate["screenSecondsRange"] = json!([1, 2]);
            candidate["extraSecondsRange"] = json!([0, 1]);
        }
        value
    }

    fn mock_draft(request: &TextRequest, invalid_interval: bool) -> Value {
        let event = request.schema["properties"]["units"]["items"]["properties"]["eventId"]["enum"]
            [0]
        .clone();
        let units: Vec<_>=request.input["sourceRows"].as_array().unwrap().iter().enumerate().map(|(index,row)| {
            let quote=&row["dialogue"];
            let parts: Vec<_>=quote["spokenSegments"].as_array().into_iter().flatten().enumerate().map(|(position,segment)|json!({
                "lineId":quote["id"],"quoteStart":if invalid_interval {quote["range"]["start"].clone()}else{segment["range"]["start"].clone()},"quoteEnd":segment["range"]["end"],"presentation":"画内","delivery":"自然说出","voiceStart":position as f64*0.5,"voiceEnd":position as f64*0.5+0.4
            })).collect();
            json!({"id":format!("U{index}"),"episodeId":row["episodeId"],"eventId":event,"sceneId":row["sceneId"],"title":"源动作回应","unitDirection":"人物完成源动作并回应。","intent":{"subject":"人物","change":"回应","landing":"结果","retain":["原话"]},"boundaryBefore":{"kind":"continuous","reason":"本场连续动作"},"scene":"门口","participants":["人物"],"props":[],"lighting":"门外侧光","initialState":"人物站在门边。","exitState":"人物保持原站位。","sourceRefs":[row["id"]],"assetRefs":[],"shots":[{"id":format!("S{index}"),"duration":3.0,"camera":"近景读回应","picture":"人物回应","lighting":"侧光","sound":"环境底声与原声","transition":"自然切出","sourceRefs":[row["id"]],"contextRefs":[],"dialogueParts":parts}]})
        }).collect();
        json!({"schemaVersion":"storyboard-draft/v2","units":units,"fantasyRealization":[],"revisionNotes":[],"unresolved":[]})
    }

    #[async_trait]
    impl TextExecutor for Recorded {
        async fn execute(&self, request: TextRequest) -> Result<Value, String> {
            let key = serde_json::to_string(&request).unwrap();
            if let Some(value) = self.accepted.lock().await.get(&key).cloned() {
                return Ok(value);
            }
            self.calls.lock().await.push(request.clone());
            if request.stage == "storyboardPlan" {
                let mut value = mock_plan(&request, self.fantasy);
                if self.rough_per_row {
                    value["provisionalUnits"]=json!(request.input["sourceRows"].as_array().unwrap().iter().enumerate().map(|(i,row)|json!({"id":format!("P{i}"),"packageId":"W1","sourceRefs":[row["id"]],"secondsRange":[20,30]})).collect::<Vec<_>>());
                }
                if request.input["episode"]["id"].as_str() == Some(self.fail_episode.as_str()) {
                    value["events"] = json!([]);
                }
                Ok(value)
            } else {
                Ok(mock_draft(&request, self.invalid_interval))
            }
        }
        async fn accept(&self, request: &TextRequest, value: &Value) -> Result<(), String> {
            self.accepted
                .lock()
                .await
                .insert(serde_json::to_string(request).unwrap(), value.clone());
            Ok(())
        }
        async fn reject(
            &self,
            request: &TextRequest,
            _value: &Value,
            reason: &str,
        ) -> Result<(), String> {
            self.rejected
                .lock()
                .await
                .push(format!("{}:{reason}", request.stage));
            Ok(())
        }
    }

    fn input(source: &LockedSource) -> Value {
        json!({"source":source,"assets":[],"foundation":{"overview":"人物拒绝离开。","direction":"克制且保留局部爆发。","episodes":[],"facts":[]},"settings":{"fantasyMode":"off","visualStyle":"16:9真人","videoProvider":"private-channel","textApiToken":"test-placeholder","imageResolution":"4k"},"capabilities":{"minDuration":0,"maxDuration":15,"imageLimit":5},"selection":{"episodeIds":source.episodes.iter().map(|episode|episode.id.clone()).collect::<Vec<_>>()}})
    }

    #[tokio::test]
    async fn source_intervals_are_materialized_without_speaking_cues_or_copying_settings() {
        let source =
            prepare_source("第一集\n场景：门口\n小王（低声）：别动（抬手），回来😀。\n").unwrap();
        let exec = Recorded::default();
        let output = run_storyboard(&input(&source), &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(output["status"], "completed");
        let parts = output["units"][0]["shots"][0]["dialogueParts"]
            .as_array()
            .unwrap();
        assert_eq!(
            parts
                .iter()
                .map(|part| text(part, "text"))
                .collect::<String>(),
            "别动，回来😀。"
        );
        assert!(parts
            .iter()
            .all(|part| text(part, "speaker") == "小王" && text(part, "channel") == "现场"));
        assert!(output["units"][0]["prompt"]
            .as_str()
            .unwrap()
            .contains("别动"));
        for request in exec.calls.lock().await.iter() {
            assert_eq!(
                request.input["productionDirection"]["direction"],
                "克制且保留局部爆发。"
            );
            assert!(request.input["settings"].get("textApiToken").is_none());
            assert!(request.input["settings"].get("videoProvider").is_none());
            if request.stage != "storyboardPlan" {
                let properties = &request.schema["properties"]["units"]["items"]["properties"]
                    ["shots"]["items"]["properties"]["dialogueParts"]["items"]["properties"];
                assert!(properties.get("text").is_none() && properties.get("speaker").is_none());
            }
        }
        assert_eq!(exec.accepted.lock().await.len(), 3);
    }

    #[tokio::test]
    async fn long_owner_finishes_each_transport_batch_and_passes_only_accepted_tail() {
        let source=prepare_source("第一集\n场景：门口\n小王：一。\n小王：二。\n小王：三。\n小王：四。\n小王：五。\n小王：六。\n小王：七。\n小王：八。\n").unwrap();
        let exec = Recorded {
            rough_per_row: true,
            ..Default::default()
        };
        let first = run_storyboard(&input(&source), &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(first["status"], "completed");
        assert_eq!(first["units"].as_array().unwrap().len(), 2);
        let calls = exec.calls.lock().await.clone();
        assert_eq!(
            calls.iter().map(|r| r.stage.as_str()).collect::<Vec<_>>(),
            vec![
                "storyboardPlan",
                "storyboardCreate",
                "storyboardFinish",
                "storyboardCreate",
                "storyboardFinish"
            ]
        );
        assert_eq!(calls[1].input["sourceRows"].as_array().unwrap().len(), 5);
        assert_eq!(calls[3].input["sourceRows"].as_array().unwrap().len(), 3);
        assert_eq!(
            calls[3].input["acceptedContinuity"]["version"],
            "accepted-tail-v1"
        );
        assert_eq!(
            calls[3].input["acceptedContinuity"]["unit"]["id"],
            first["units"][0]["id"]
        );
        assert_eq!(
            calls[3].input["acceptedContinuity"]["evidenceRole"],
            "ACCEPTED_CREATIVE_STATE_ONLY"
        );
        // The saved normalized plan and each accepted full scope are reusable;
        // resuming never invokes another model or shrinks/expands its scope.
        let repeated = run_storyboard(&input(&source), &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(first["units"], repeated["units"]);
        assert_eq!(exec.calls.lock().await.len(), 5);
        assert_eq!(first["sourceSha256"], source.sha256);
    }

    #[test]
    fn method_cards_are_loaded_by_scope_and_source_expression_does_not_grant_fantasy() {
        let source = prepare_source("第一集\n场景：门口\n小王：别动。\n").unwrap();
        let rows: Vec<_> = source
            .rows
            .iter()
            .filter(|r| r.kind == "body")
            .cloned()
            .collect();
        let base = methods_for(&rows, &[], &[], false, &[]).unwrap();
        assert!(base.contains(&"storyboard-common") && !base.contains(&"fantasy-expression"));
        let finish = methods_for(&rows, &[], &["long-voice".into()], true, &[]).unwrap();
        assert!(
            finish.contains(&"storyboard-card-long-voice")
                && finish.contains(&"storyboard-card-editing-integrity")
                && finish.contains(&"storyboard-card-camera-path-repair")
        );
        assert!(!finish.contains(&"storyboard-card-danger-rescue"));
        assert!(methods_for(&rows, &[], &["unknown-card".into()], false, &[]).is_err());
        let source = prepare_source("第一集\n场景：门口\nQ版小王OS：别动。\n").unwrap();
        assert!(methods_for(&source.rows, &[], &[], false, &[])
            .unwrap()
            .contains(&"fantasy-expression"));
    }

    #[test]
    fn prefixed_packed_segments_keep_shot_headers_and_source_dialogue_consistent() {
        let mut draft = json!({"units":[{"id":"U","unitDirection":"【S1—S2】完整表演。", "lighting":"【S1—S2】自然侧光。", "initialState":"原站位。\n【S1起承接】站位未变。",
            "segments":[{"shotIds":["S1","S2"]}],"shots":[{"id":"S1","dialogueParts":[{"text":"源文提到【S1—S2】，原话不许改。"}]},{"id":"S2"}]}],"fantasyRealization":[]});
        let quote = draft["units"][0]["shots"][0]["dialogueParts"].clone();
        prefix_ids(&mut draft, "episode:batch:").unwrap();
        assert_eq!(
            draft["units"][0]["segments"][0]["shotIds"],
            json!(["episode:batch:S1", "episode:batch:S2"])
        );
        assert_eq!(
            draft["units"][0]["unitDirection"],
            "【episode:batch:S1—episode:batch:S2】完整表演。"
        );
        assert!(text(&draft["units"][0], "initialState").contains("【episode:batch:S1起承接】"));
        assert_eq!(draft["units"][0]["shots"][0]["dialogueParts"], quote);
        let before = draft.clone();
        prefix_ids(&mut draft, "episode:batch:").unwrap();
        assert_eq!(draft, before);
    }

    #[test]
    fn previous_source_boundary_retains_complete_scene_or_whole_oversized_tail_node() {
        let mut text = String::from("第一集\n场景：旧场\n某人：旧场对白。\n场景：末场\n");
        for i in 0..10 {
            text.push_str(&format!("甲：第{i}句。\n"));
        }
        text.push_str("第二集\n场景：新场\n乙：回来。\n");
        let source = prepare_source(&text).unwrap();
        let evidence = previous_source_boundary(&source, &source.episodes[1]);
        assert_eq!(evidence["selectionKind"], "SAVED_SCENE");
        assert_eq!(evidence["clipped"], false);
        assert_eq!(evidence["currentApplicability"], "UNKNOWN");
        let refs = strings(&evidence, "sourceRefs").unwrap();
        assert_eq!(
            refs.iter()
                .filter(|id| source.rows.iter().any(|r| &r.id == *id && r.kind == "body"))
                .count(),
            10
        );
        assert!(!refs.iter().any(|id| source
            .rows
            .iter()
            .any(|r| &r.id == id && r.text.contains("旧场对白"))));
        let long = "字".repeat(2500);
        let source = prepare_source(&format!(
            "第一集\n场景：末场\n甲：短句。\n甲：{long}。\n第二集\n场景：新场\n乙：回来。\n"
        ))
        .unwrap();
        let evidence = previous_source_boundary(&source, &source.episodes[1]);
        assert_eq!(evidence["selectionKind"], "TAIL_NODES");
        assert_eq!(evidence["budgetExceeded"], true);
        let refs = strings(&evidence, "sourceRefs").unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(
            source
                .rows
                .iter()
                .find(|r| r.id == refs[0])
                .unwrap()
                .dialogue
                .as_ref()
                .unwrap()
                .quote,
            format!("{long}。")
        );
        assert!(previous_source_boundary(&source, &source.episodes[0]).is_null());
    }

    #[test]
    fn history_keeps_relevant_different_claims_and_original_neighbors() {
        let source=prepare_source("第一集\n场景：门口\n甲：我已经把刀收好。\n乙：他还拿着刀。\n甲：我放下刀了。\n第二集\n场景：门口\n甲：走吧。\n").unwrap();
        let prior: Vec<_> = source
            .rows
            .iter()
            .filter(|r| r.kind == "body" && r.episode_id.as_ref() == Some(&source.episodes[0].id))
            .collect();
        let assets = vec![json!({"id":"A:v","baseAssetId":"A","variantId":"v","name":"甲｜基础"})];
        let foundation = json!({"facts":[{"assetId":"A","attribute":"持物","claim":"CHARACTER_CLAIM","scope":"LOCAL","sourceRefs":[prior[0].id]},{"assetId":"A","attribute":"持物","claim":"CHARACTER_CLAIM","scope":"LOCAL","sourceRefs":[prior[2].id]}]});
        let context = relevant_context(&source, &source.episodes[1], &assets, &foundation);
        for row in prior {
            assert!(context.iter().any(|r| r.id == row.id && r.text == row.text));
        }
        assert!(!context
            .iter()
            .any(|r| r.episode_id.as_ref() == Some(&source.episodes[1].id)));
    }

    #[tokio::test]
    async fn invalid_spoken_range_is_rejected_and_never_accepted() {
        let source = prepare_source("第一集\n场景：门口\n小王：（低声）别动。\n").unwrap();
        let exec = Recorded {
            invalid_interval: true,
            ..Default::default()
        };
        let output = run_storyboard(&input(&source), &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert!(output["units"].as_array().unwrap().is_empty());
        assert_eq!(exec.accepted.lock().await.len(), 1);
        assert_eq!(exec.rejected.lock().await.len(), 1);
        assert!(output["blocked"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("演法"));
    }

    #[tokio::test]
    async fn review_waits_then_reuses_the_frozen_plan_with_an_empty_choice() {
        let source = prepare_source("第一集\n场景：门口\n小王：别动。\n").unwrap();
        let mut value = input(&source);
        value["settings"]["fantasyMode"] = json!("review");
        let exec = Recorded {
            fantasy: true,
            ..Default::default()
        };
        let waiting = run_storyboard(&value, &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(waiting["status"], "waiting_decision");
        assert_eq!(waiting["waitingDecision"]["selectionMode"], "review");
        assert!(waiting["blocked"].as_array().unwrap().is_empty());
        value["decisions"] = json!({source.episodes[0].id.clone():{"selectedFantasyIds":[]}});
        let done = run_storyboard(&value, &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(done["status"], "completed");
        assert_eq!(
            exec.calls
                .lock()
                .await
                .iter()
                .filter(|request| request.stage == "storyboardPlan")
                .count(),
            1
        );
        let again = run_storyboard(&value, &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(done["units"], again["units"]);
        assert_eq!(exec.calls.lock().await.len(), 3);
    }

    #[tokio::test]
    async fn failed_predecessor_blocks_dependent_episode_without_resetting_continuity() {
        let source =
            prepare_source("第一集\n场景：门口\n小王：别动。\n第二集\n场景：门口\n小王：回来。\n")
                .unwrap();
        let exec = Recorded {
            fail_episode: source.episodes[0].id.clone(),
            ..Default::default()
        };
        let output = run_storyboard(&input(&source), &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(exec.calls.lock().await.len(), 1);
        assert_eq!(output["blocked"][1]["status"], "waiting_dependency");
        assert_eq!(output["blocked"][1]["dependsOn"], source.episodes[0].id);
    }

    #[tokio::test]
    async fn local_revision_runs_only_create_and_finish_and_preserves_other_units() {
        let source = prepare_source("第一集\n场景：门口\n小王：别动。\n小王：回来。\n").unwrap();
        let original = run_storyboard(
            &input(&source),
            &Recorded::default(),
            "gpt-6.1-sol",
            "medium",
        )
        .await
        .unwrap();
        let mut value = input(&source);
        value["selection"] = json!({"unitIds":[original["units"][0]["id"]]});
        value["existingUnits"] = original["units"].clone();
        value["revisionInstruction"] = json!("把本次回应拍得更清楚，保持原站位。");
        let exec = Recorded::default();
        let output = run_storyboard(&value, &exec, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(output["status"], "completed");
        assert_eq!(output["scope"], "units");
        assert_eq!(
            output["replacedUnitIds"],
            json!([original["units"][0]["id"]])
        );
        assert_eq!(output["units"][0]["id"], original["units"][0]["id"]);
        assert_eq!(output["units"].as_array().unwrap().len(), 1);
        assert_eq!(
            exec.calls
                .lock()
                .await
                .iter()
                .map(|request| request.stage.as_str())
                .collect::<Vec<_>>(),
            vec!["storyboardCreate", "storyboardFinish"]
        );
    }

    #[test]
    fn utf16_selection_rejects_surrogate_splits_and_duplicate_source_intervals() {
        let source = prepare_source("第一集\n场景：门口\n小王：😀。\n").unwrap();
        let quote = source.rows[2].dialogue.as_ref().unwrap();
        let mut draft = json!({"units":[{"shots":[{"dialogueParts":[{"lineId":quote.id,"quoteStart":quote.range.start,"quoteEnd":quote.range.start+1}]}]}]});
        assert!(materialize_dialogue(&source, &mut draft, false).is_err());
        let part = draft["units"][0]["shots"][0]["dialogueParts"][0]
            .as_object_mut()
            .unwrap();
        part.remove("quoteStart");
        part.remove("quoteEnd");
        part.insert("text".into(), json!("改写原话"));
        assert!(materialize_dialogue(&source, &mut draft, false).is_err());
        let repeat_source = prepare_source("第一集\n场景：门口\n小王：哈哈\n").unwrap();
        let quote = repeat_source.rows[2].dialogue.as_ref().unwrap();
        let part = json!({"lineId":quote.id,"quoteStart":quote.range.start,"quoteEnd":quote.range.start+1});
        let mut repeated = json!({"units":[{"shots":[{"dialogueParts":[part.clone(),part]}]}]});
        assert!(materialize_dialogue(&repeat_source, &mut repeated, false).is_err());
    }
}
