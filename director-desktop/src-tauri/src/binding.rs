use crate::store::{hash_file, id, s, Result, Store};
use serde_json::{json, Value};

/// Names are display text only. References are resolved by immutable identity and scope.
pub fn bind(store: &Store, unit: &Value, provider: &str, model: &str) -> Result<Value> {
    if s(unit, "prompt").trim().is_empty() {
        return Err("单元提示词为空".into());
    }
    let mut refs = unit["assetRefs"]
        .as_array()
        .ok_or("分镜没有结构化assetRefs，请先完成旧分镜资产映射")?
        .clone();
    refs.sort_by_key(|r| r.get("order").and_then(Value::as_u64).unwrap_or(0));
    let mut media = Vec::new();
    let mut problems = Vec::new();
    if unit["continuityStale"] == true {
        problems.push(json!({"code":"CONTINUITY_REVISION_REQUIRED","message":"前置单元已修改，请先更新本单元的连续状态与提示词"}));
    }
    let duration = unit["duration"].as_f64().unwrap_or(0.0);
    if !duration.is_finite() || duration <= 0.0 || duration.fract() != 0.0 {
        problems.push(json!({"code":"DURATION_REVISION_REQUIRED","message":"首版视频渠道要求正整秒载体；请修订单元时长，不自动取整或填空"}));
    }
    let source = store.source()?;
    if source.is_null() {
        problems.push(
            json!({"code":"MISSING_SOURCE","message":"请先导入源文档，为单元保存明确来源版本"}),
        );
    } else {
        let episode = s(unit, "episodeId");
        let scene = s(unit, "sceneId");
        if !source["episodes"]
            .as_array()
            .map(|es| es.iter().any(|e| s(e, "id") == episode))
            .unwrap_or(false)
        {
            problems
                .push(json!({"code":"INVALID_EPISODE","message":"单元所属集没有映射到当前原文"}));
        }
        if !source["scenes"]
            .as_array()
            .map(|sc| {
                sc.iter()
                    .any(|sc| s(sc, "id") == scene && s(sc, "episodeId") == episode)
            })
            .unwrap_or(false)
        {
            problems.push(json!({"code":"INVALID_SCENE","message":"单元所属场没有映射到当前原文"}));
        }
        let source_refs = unit["sourceRefs"].as_array();
        if source_refs.map(|r| r.is_empty()).unwrap_or(true) {
            problems
                .push(json!({"code":"SOURCE_REFS_REQUIRED","message":"单元缺少当前正文来源引用"}));
        } else if source_refs.unwrap().iter().any(|id| {
            !source["rows"]
                .as_array()
                .unwrap_or(&Vec::new())
                .iter()
                .any(|row| {
                    row["id"] == *id
                        && s(row, "episodeId") == episode
                        && s(row, "sceneId") == scene
                        && s(row, "kind") == "body"
                })
        }) {
            problems.push(
                json!({"code":"INVALID_SOURCE_REF","message":"单元来源已失效或越出所属集场"}),
            );
        }
    }
    if unit["needsAssetMapping"].as_bool() == Some(true) {
        problems.push(json!({"code":"LEGACY_ASSET_MAPPING","message":"旧分镜需要明确确认assetId、variantId、用途与顺序"}));
    }
    if let Some(issues) = unit["capacityIssues"].as_array() {
        if !issues.is_empty() {
            problems.push(json!({"code":"CAPACITY_REVISION_REQUIRED","message":"该单元仍有时长或素材容量问题，请修订关联单元","details":issues}));
        }
    }
    for (order, r) in refs.iter().enumerate() {
        let aid = s(r, "assetId");
        if aid.is_empty() {
            problems.push(json!({"code":"MISSING_ASSET_ID","order":order,"message":"引用缺少assetId，不能按姓名自动配图"}));
            continue;
        }
        let a = match store.get("assets", aid) {
            Ok(a) => a,
            Err(e) => {
                problems.push(json!({"code":"MISSING_ASSET","assetId":aid,"message":e}));
                continue;
            }
        };
        if crate::store::asset_deleted(&a) {
            problems.push(json!({"code":"ASSET_DELETED","assetId":aid,"message":"此资产已删除，请在单元配图中替换，或到图片资产恢复"}));
            continue;
        }
        if a["scope"]["kind"] == "UNRESOLVED" {
            problems.push(json!({"code":"ASSET_SCOPE_UNRESOLVED","assetId":aid,"message":"此形象的适用集场尚未明确，请先处理制作基础中的相关问题"}));
            continue;
        }
        if a["scope"]["kind"] == "SCENES"
            && !a["scope"]["scenes"].as_array().is_some_and(|scenes| {
                scenes.iter().any(|sc| {
                    sc["episodeId"] == unit["episodeId"] && sc["sceneId"] == unit["sceneId"]
                })
            })
        {
            problems.push(
                json!({"code":"OUT_OF_SCOPE","assetId":aid,"message":"形象不适用于本单元的集场"}),
            );
            continue;
        }
        if a["needsReview"].as_bool() == Some(true) {
            problems.push(json!({"code":"ASSET_REVIEW_REQUIRED","assetId":aid,"message":"导入形象身份及适用范围尚未核对"}));
            continue;
        }
        let variant = if s(r, "variantId").is_empty() {
            s(&a, "variantId")
        } else {
            s(r, "variantId")
        };
        if variant != s(&a, "variantId") {
            problems.push(json!({"code":"VARIANT_MISMATCH","assetId":aid,"variantId":variant,"message":"指定形象版本不存在"}));
            continue;
        }
        if let Some(scope) = a["applicability"]["episodes"].as_array() {
            if !scope.is_empty() && !scope.iter().any(|e| e == &unit["episodeId"]) {
                problems.push(
                    json!({"code":"OUT_OF_SCOPE","assetId":aid,"message":"形象不适用于本集"}),
                );
                continue;
            }
        }
        if let Some(scope) = a["applicability"]["scenes"].as_array() {
            if !scope.is_empty() && !scope.iter().any(|e| e == &unit["sceneId"]) {
                problems.push(
                    json!({"code":"OUT_OF_SCOPE","assetId":aid,"message":"形象不适用于本场"}),
                );
                continue;
            }
        }
        // INLINE is a semantic appearance, not a request for a new image. Resolve
        // its actual material ancestor in Rust while retaining its scope/version.
        if a.pointer("/preparation/mode").and_then(Value::as_str)==Some("AUDIO") {
            continue;
        }
        let image_asset=match image_material_asset(store,&a) {
            Ok(value)=>value,
            Err(message)=>{problems.push(json!({"code":"MATERIAL_SOURCE_UNRESOLVED","assetId":aid,"message":message}));continue;}
        };
        let image_aid=s(&image_asset,"id");
        let image_variant=s(&image_asset,"variantId");
        if (!s(r,"imageAssetId").is_empty() && s(r,"imageAssetId")!=image_aid)
            || (!s(r,"imageVariantId").is_empty() && s(r,"imageVariantId")!=image_variant) {
            problems.push(json!({"code":"MATERIAL_SOURCE_MISMATCH","assetId":aid,"message":"参考图身份与当前素材来源不一致，请更新配图"}));continue;
        }
        let adopted = store.adopted(image_aid, image_variant)?;
        let mid = if !s(r, "mediaId").is_empty() {
            if adopted.as_deref() != Some(s(r, "mediaId")) {
                problems.push(json!({"code":"STALE_ADOPTION","assetId":aid,"message":"显式图片引用已不是当前采用版本"}));
                continue;
            }
            s(r, "mediaId").to_string()
        } else {
            match adopted {
                Some(m) => m,
                None => {
                    problems.push(json!({"code":"MISSING_IMAGE","assetId":aid,"variantId":variant,"message":"没有已采用图片"}));
                    continue;
                }
            }
        };
        let m = store.get("media", &mid)?;
        let p = match store.verify_media(&m) {
            Ok(p) => p,
            Err(e) => {
                problems.push(json!({"code":"INVALID_MEDIA","mediaId":mid,"message":e}));
                continue;
            }
        };
        let semantic=json!({"assetId":aid,"variantId":variant,"assetVersion":a["version"]});
        if let Some(existing)=media.iter_mut().find(|item:&&mut Value|item["mediaId"]==mid && item["kind"]=="image") {
            existing["semanticBindings"].as_array_mut().ok_or("素材语义绑定缺失")?.push(semantic);
        } else {
            media.push(json!({"mediaId":mid,"assetId":image_aid,"assetVersion":image_asset["version"],"variantId":image_variant,"semanticBindings":[semantic],"kind":"image","path":p,"relativePath":m["relativePath"],"sha256":m["sha256"],"order":media.len(),"usage":r.get("role").or(r.get("usage")).unwrap_or(&json!("reference")),"assetName":a["name"]}));
        }
    }
    if let Some(extras) = unit["mediaRefs"].as_array() {
        let mut ordered = extras.clone();
        ordered.sort_by_key(|r| r["order"].as_u64().unwrap_or(0));
        for r in &ordered {
            let m = store.get("media", s(r, "mediaId"))?;
            let p = store.verify_media(&m)?;
            if ["audio", "video"].contains(&s(&m, "kind"))
                && m["metadataVerified"].as_bool() != Some(true)
            {
                problems.push(json!({"code":"MEDIA_METADATA_REQUIRED","mediaId":m["id"],"message":"音视频时长尚未可靠读取，请检查媒体探测工具或重新导入"}));
            }
            media.push(json!({"mediaId":m["id"],"kind":m["kind"],"path":p,"relativePath":m["relativePath"],"sha256":m["sha256"],"order":media.len(),"usage":r.get("usage").or(r.get("role")).unwrap_or(&json!("reference")),"durationSeconds":m.get("durationSeconds")}));
        }
    }
    let mut prompt = s(unit, "prompt").to_owned();
    // Compile explicit identity placeholders, never infer a name-to-image alias.
    let mut image_order = 0;
    let mut video_order = 0;
    let mut audio_order = 0;
    for r in &media {
        let marker = match s(r, "kind") {
            "image" => {
                image_order += 1;
                format!("@图片{image_order}")
            }
            "video" => {
                video_order += 1;
                format!("@视频{video_order}")
            }
            _ => {
                audio_order += 1;
                format!("@音频{audio_order}")
            }
        };
        let placeholder = format!("{{{{asset:{}:{}}}}}", s(r, "assetId"), s(r, "variantId"));
        prompt = prompt.replace(&placeholder, &marker);
        for semantic in r["semanticBindings"].as_array().into_iter().flatten() {
            let placeholder=format!("{{{{asset:{}:{}}}}}",s(semantic,"assetId"),s(semantic,"variantId"));
            prompt=prompt.replace(&placeholder,&marker);
        }
    }
    if prompt.contains("{{asset:") {
        problems.push(json!({"code":"UNBOUND_PLACEHOLDER","message":"提示词含未绑定资产占位符"}));
    }
    if provider != "bh" && unit.get("generateAudio").and_then(Value::as_bool) == Some(false) {
        problems.push(json!({"code":"AUDIO_OPTION_UNSUPPORTED","message":"所选渠道尚未核实静音生成参数，请调整单元设置或渠道"}));
    }
    // A source @图片N must agree with the compiled order. We do not silently renumber it.
    let markers = regex::Regex::new(r"@图片(\d+)").unwrap();
    if markers
        .captures_iter(&prompt)
        .any(|c| c[1].parse::<usize>().unwrap_or(usize::MAX) > image_order)
    {
        problems.push(json!({"code":"REFERENCE_ORDER","message":"提示词图片编号超出实际绑定顺序"}));
    }
    let options = if provider == "bh" {
        json!({"generateAudio":unit.get("generateAudio").cloned().unwrap_or(json!(true))})
    } else {
        json!({})
    };
    let wire_duration = if duration.is_finite()
        && duration > 0.0
        && duration.fract() == 0.0
        && duration <= u32::MAX as f64
    {
        json!(duration as u32)
    } else {
        unit["duration"].clone()
    };
    Ok(
        json!({"requestId":id(),"kind":"video","provider":provider,"model":model,"unitId":unit["id"],"unitVersion":unit["version"],"episodeId":unit["episodeId"],"sourceVersion":store.source()?["version"],"prompt":prompt,"duration":wire_duration,"ratio":store.settings()?["ratio"],"resolution":store.settings()?.get("videoResolution").cloned().unwrap_or(json!("720p")),"references":media,"problems":problems,"ruleSnapshot":crate::pipeline::rule_snapshot("unit-video-production")?,"options":options}),
    )
}

pub fn validate_snapshot(store: &Store, snapshot: &Value) -> Result<()> {
    let unit = store.get("units", s(snapshot, "unitId"))?;
    if unit["version"] != snapshot["unitVersion"] {
        return Err("分镜版本已变化，请重新准备".into());
    }
    if store.source()?["version"] != snapshot["sourceVersion"] {
        return Err("原文版本已变化，请重新准备".into());
    }
    for r in snapshot["references"].as_array().ok_or("素材快照缺失")? {
        for semantic in r["semanticBindings"].as_array().into_iter().flatten() {
            let asset=store.active_asset(s(semantic,"assetId"))?;
            if asset["version"]!=semantic["assetVersion"] || s(&asset,"variantId")!=s(semantic,"variantId") {
                return Err("单元语义形象版本已变化，请重新准备".into());
            }
            let material=image_material_asset(store,&asset)?;
            if s(&material,"id")!=s(r,"assetId") || s(&material,"variantId")!=s(r,"variantId") {
                return Err("单元素材来源已变化，请重新准备".into());
            }
        }
        let m = store.get("media", s(r, "mediaId"))?;
        let p = store.verify_media(&m)?;
        if !same_path(&p, s(r, "path")) {
            return Err("素材执行路径已经变化，请重新准备".into());
        }
        if hash_file(&p)?.0 != s(r, "sha256") {
            return Err("素材快照哈希已失效".into());
        }
        if !s(r, "assetId").is_empty() {
            let a = store.active_asset(s(r, "assetId"))?;
            if a["version"] != r["assetVersion"]
                || store
                    .adopted(s(r, "assetId"), s(r, "variantId"))?
                    .as_deref()
                    != Some(s(r, "mediaId"))
            {
                return Err("采用图片或形象版本已变化，请重新准备".into());
            }
        }
    }
    Ok(())
}

fn image_material_asset(store:&Store,asset:&Value)->Result<Value> {
    let assets=store.values("assets")?;
    let mut current=asset.clone();
    let mut visited=std::collections::HashSet::new();
    loop {
        if !visited.insert(s(&current,"id").to_owned()) {return Err("沿用图片的素材来源出现循环".into());}
        if crate::store::asset_deleted(&current) {return Err("参考图片的来源资产已删除".into());}
        match current.pointer("/preparation/mode").and_then(Value::as_str) {
            Some("UNRESOLVED")=>return Err("素材制作方式尚未明确".into()),
            Some("AUDIO")=>return Err("纯声音资产不能用作图片素材来源".into()),
            Some("INLINE")=>{
                let parent=crate::pipeline::resolve_asset_dependency(&assets,&current)?
                    .ok_or("沿用图片的形象没有明确来源，请指定基础形象")?;
                current=store.active_asset(&parent)?;
            },
            _=>return Ok(current),
        }
    }
}

/// Images and videos share the same immutable-reference validity boundary.
pub fn validate_generation_snapshot(store: &Store, snapshot: &Value) -> Result<()> {
    if s(snapshot, "kind") == "video" {
        validate_snapshot(store, snapshot)?;
    } else if s(snapshot, "kind") == "image" {
        let asset = store.active_asset(s(snapshot, "assetId"))?;
        if asset["version"] != snapshot["assetVersion"] {
            return Err("图片设计版本已变化，请重新准备".into());
        }
        if !snapshot["sourceVersion"].is_null()
            && store.source()?["version"] != snapshot["sourceVersion"]
        {
            return Err("原文版本已变化，请重新准备".into());
        }
        for r in snapshot["references"]
            .as_array()
            .ok_or("图片依赖快照缺失")?
        {
            let a = store.active_asset(s(r, "assetId"))?;
            let variant = if s(r, "variantId").is_empty() {
                s(&a, "variantId")
            } else {
                s(r, "variantId")
            };
            if a["version"] != r["assetVersion"]
                || store.adopted(s(r, "assetId"), variant)?.as_deref() != Some(s(r, "mediaId"))
            {
                return Err("图片派生参考已经替换，请重新准备".into());
            }
            let m = store.get("media", s(r, "mediaId"))?;
            let p = store.verify_media(&m)?;
            if s(r, "sha256") != s(&m, "sha256") || !same_path(&p, s(r, "path")) {
                return Err("图片素材路径或哈希已变化，请重新准备".into());
            }
        }
    } else {
        return Err("未知生成类型".into());
    }
    Ok(())
}

fn same_path(path: &std::path::Path, other: &str) -> bool {
    !other.is_empty() && std::fs::canonicalize(path).ok() == std::fs::canonicalize(other).ok()
}
