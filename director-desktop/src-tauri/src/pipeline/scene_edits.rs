//! Q1's already validated declaration is executed once by Rust, never by a
//! second model call. The original bytes and every dialogue coordinate stay locked.
use super::*;

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Validate and materialize the scene projection of one Q1 response, without
/// publishing a source or touching a proposal. New scene identities exist only
/// after their exact locked cut row has been replayed. A same-response metadata
/// patch can therefore address that identity even if it precedes the split in
/// the wire's changes object.
pub(super) fn preview_foundation_scene_edits(
    source: &LockedSource,
    edits: &[Value],
    selected_episode_ids: &[String],
) -> Result<LockedSource, String> {
    validate_source(source)?;
    let mut combined = source.scene_edits.clone();
    for kind in ["sceneSplit", "sceneMetadata"] {
        for edit in edits.iter().filter(|edit| text(edit, "kind") == kind) {
            let fields = edit.as_object().ok_or("场次预演声明须为对象")?;
            if fields.keys().any(|key| !["kind", "sourceSha256", "plan"].contains(&key.as_str())) {
                return Err("场次预演声明含未授权字段".into());
            }
            if text(edit, "sourceSha256") != source.sha256 {
                return Err("场次修订不属于当前原文".into());
            }
            let plan = &edit["plan"];
            let fields = plan.as_object().ok_or("场次计划须为对象")?;
            if !selected_episode_ids.iter().any(|id| id == text(plan, "episodeId")) {
                return Err("场次计划越出本轮制作范围".into());
            }
            if kind == "sceneSplit" && fields.keys().any(|key| !["episodeId", "sceneId", "cuts"].contains(&key.as_str())) {
                return Err("拆场计划含未授权字段".into());
            }
            if !combined.contains(edit) { combined.push(edit.clone()); }
        }
    }
    if edits.iter().any(|edit| !["sceneSplit", "sceneMetadata"].contains(&text(edit, "kind"))) {
        return Err("未知场次程序修订类型".into());
    }
    let baseline = super::source::source_before_scene_edits(source)?;
    let revised = replay_scene_edits(baseline, &combined)?;
    validate_source(&revised)?;
    if revised.text != source.text || revised.sha256 != source.sha256
        || revised.rows.len() != source.rows.len()
        || revised.rows.iter().zip(&source.rows).any(|(after, before)| {
            after.id != before.id || after.number != before.number || after.text != before.text
                || after.range.start != before.range.start || after.range.end != before.range.end
                || serde_json::to_value(&after.dialogue).ok() != serde_json::to_value(&before.dialogue).ok()
        })
    {
        return Err("场次预演不能改写锁定原文或对白坐标".into());
    }
    Ok(revised)
}

pub(super) fn replay_scene_edits(mut source: LockedSource, edits: &[Value]) -> Result<LockedSource, String> {
    for edit in edits {
        if text(edit, "sourceSha256") != source.sha256 { return Err("场次修订不属于当前原文".into()); }
        let plan=&edit["plan"];
        let sid=text(plan,"sceneId"); let eid=text(plan,"episodeId");
        let position=source.scenes.iter().position(|scene|scene.id==sid && scene.episode_id==eid)
            .ok_or("场次修订指向失效集场")?;
        let original=source.scenes[position].clone();
        match text(edit,"kind") {
            "sceneMetadata"=>{
                let refs=plan["sourceRefs"].as_array().ok_or("场字段修订缺少源引用")?;
                if refs.is_empty() || refs.iter().any(|id| !source.rows.iter().any(|row| row.id==id.as_str().unwrap_or("") && row.scene_id.as_deref()==Some(sid))) {
                    return Err("场字段修订引用越出原场".into());
                }
                let map=plan.as_object().ok_or("场字段修订须为对象")?;
                for (key,value) in map {
                    if ["episodeId","sceneId","sourceRefs"].contains(&key.as_str()) {continue;}
                    if !["location","timeOfDay","interiorExterior","timeLayer","weather","characters"].contains(&key.as_str()) {
                        return Err("场字段修订越出白名单".into());
                    }
                    if key=="characters" {
                        if value.as_array().is_none_or(|items|items.iter().any(|v|!v.is_string())) {return Err("场次人物清单类型无效".into());}
                    } else if !value.is_string() {return Err("场字段类型无效".into());}
                    source.scenes[position].metadata.insert(key.clone(),value.clone());
                }
            },
            "sceneSplit"=>{
                let cuts=plan["cuts"].as_array().ok_or("拆场计划缺少cuts")?;
                if cuts.is_empty() {return Err("拆场计划没有实际边界".into());}
                let rows:Vec<_>=source.rows.iter().filter(|row|original.row_ids.contains(&row.id)).collect();
                let first=rows.first().ok_or("原场没有源行")?.range.start;
                let last=rows.last().unwrap().range.end;
                let mut starts=vec![first]; let mut numbers=vec![None];
                for cut in cuts {
                    if cut.as_object().is_none_or(|m|m.keys().any(|key| !["rowId","anchor"].contains(&key.as_str()))) {return Err("拆场切点含未授权字段".into());}
                    let row=rows.iter().find(|row|row.id==text(cut,"rowId")).ok_or("拆场切点不在原场")?;
                    if row.range.start<=*starts.last().unwrap() || row.range.start>=last || row.kind!="body" {
                        return Err("拆场切点必须是原场内按序的正文起行".into());
                    }
                    if row.text.trim_end_matches(['\r','\n'])!=text(cut,"anchor") {return Err("拆场锚点与原文不逐字一致".into());}
                    starts.push(row.range.start);numbers.push(Some(row.number));
                }
                let mut replacements=vec![];
                for (index,start) in starts.iter().enumerate() {
                    let end=starts.get(index+1).copied().unwrap_or(last);
                    let id=if index==0 {sid.to_owned()} else {format!("{sid}__L{}",numbers[index].unwrap())};
                    if index>0 && source.scenes.iter().any(|scene|scene.id==id) {return Err("拆场子场身份重复".into());}
                    let mut scene=original.clone();scene.id=id.clone();scene.row_ids.clear();
                    for row in source.rows.iter_mut().filter(|row|row.scene_id.as_deref()==Some(sid) && row.range.start>=*start && row.range.end<=end) {
                        row.scene_id=Some(id.clone());scene.row_ids.push(row.id.clone());
                    }
                    if scene.row_ids.is_empty() {return Err("拆场产生空场，未执行".into());}
                    replacements.push(scene);
                }
                source.scenes.splice(position..position+1,replacements);
                for episode in &mut source.episodes {
                    episode.scene_ids=source.scenes.iter().filter(|scene|scene.episode_id==episode.id).map(|scene|scene.id.clone()).collect();
                }
            },
            _=>return Err("未知场次程序修订类型".into()),
        }
    }
    source.scene_edits=edits.to_vec();
    Ok(source)
}

pub fn execute_foundation_scene_edits(source:&LockedSource, proposal:&mut FoundationProposal)->Result<Option<LockedSource>,String> {
    validate_source(source)?;
    let selected=proposal.updated_episode_ids.clone();
    let mut edits=vec![];
    let mut resolved=HashSet::new();
    for (index,issue) in proposal.issues.iter().enumerate() {
        let Some(details)=issue.details.as_ref() else {continue};
        if details["owner"]!="PROGRAM" || !["sceneMetadata","sceneSplit"].contains(&text(details,"planKind")) {continue;}
        let plan=&details["plan"];
        if !selected.iter().any(|id|id==text(plan,"episodeId")) {return Err("场次计划越出本轮制作范围".into());}
        let edit=json!({"kind":details["planKind"],"sourceSha256":source.sha256,"plan":plan});
        if !edits.contains(&edit) {edits.push(edit);}
        resolved.insert(index);
    }
    if resolved.is_empty() {return Ok(None);}
    // Rebuild from the canonical source via its saved original decisions; this
    // proves the revision is reproducible and cannot mutate locked dialogue.
    let revised=preview_foundation_scene_edits(source,&edits,&selected)?;
    for asset in &mut proposal.assets {
        for variant in &mut asset.variants {
            if variant.scope.kind!="SCENES" {continue;}
            let old=variant.scope.scenes.clone();let mut places=vec![];
            let scope_only=variant.metadata.get("sourceRefsPurpose")==Some(&json!("SOURCE_SCOPE"))
                && variant.metadata.get("sourceScope").and_then(|scope|scope.get("sourceSha256")).and_then(Value::as_str)==Some(source.sha256.as_str());
            for place in old {
                if scope_only {
                    // These refs bind a model-declared usage range, not a
                    // character's appearance. Keep exactly its declared scenes;
                    // a scene anchor cannot broadcast usage into split children.
                    if !revised.scenes.iter().any(|scene|scene.id==place.scene_id && scene.episode_id==place.episode_id) {
                        return Err("形象声明的适用场未由拆场计划成立".into());
                    }
                    if !places.contains(&place) {places.push(place);}
                    continue;
                }
                let Some(old_scene)=source.scenes.iter().find(|scene|scene.id==place.scene_id && scene.episode_id==place.episode_id) else {
                    // Q1 may already use a child scene proved by this response's
                    // cut. Unknown/name-derived scene identities remain invalid.
                    if !revised.scenes.iter().any(|scene|scene.id==place.scene_id && scene.episode_id==place.episode_id) {
                        return Err("形象引用的原场不存在".into());
                    }
                    if !places.contains(&place) {places.push(place);}
                    continue;
                };
                let has_split=revised.scenes.iter().any(|scene|scene.id.starts_with(&format!("{}__L",old_scene.id)));
                if !has_split {if !places.contains(&place) {places.push(place);}continue;}
                for id in &variant.source_refs {
                    if old_scene.row_ids.contains(id) {
                        let row=revised.rows.iter().find(|row|&row.id==id).ok_or("拆场形象源引用失效")?;
                        if row.kind=="body" {
                            let found=Applicability{episode_id:place.episode_id.clone(),scene_id:row.scene_id.clone().ok_or("拆场正文没有场身份")?};
                            if !places.contains(&found) {places.push(found);}
                        }
                    }
                }
            }
            variant.scope.scenes=places.clone();variant.applicability=places;
            if variant.scope.scenes.is_empty() {variant.scope.kind="UNRESOLVED".into();}
        }
    }
    proposal.issues=proposal.issues.iter().enumerate().filter(|(index,_)|!resolved.contains(index)).map(|(_,issue)|issue.clone()).collect();
    materialize_foundation(&revised,proposal)?;validate_foundation(&revised,proposal)?;
    Ok(Some(revised))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> LockedSource {
        prepare_source("第一集\r\n场景：门口\r\n甲：（低声）别动😀。\r\n△甲走进室内。\r\n甲：回来。\r\n第二集\r\n场景：楼上\r\n乙：门没开。\r\n").unwrap()
    }
    fn split(source: &LockedSource) -> Value {
        let row = source.rows.iter().find(|row| row.text.starts_with("△甲走进室内。")).unwrap();
        json!({"kind":"sceneSplit","sourceSha256":source.sha256,"plan":{"episodeId":row.episode_id,"sceneId":row.scene_id,"cuts":[{"rowId":row.id,"anchor":row.text.trim_end_matches(['\r','\n'])}]}})
    }
    fn child_id(source: &LockedSource) -> String {
        let row = source.rows.iter().find(|row| row.text.starts_with("△甲走进室内。")).unwrap();
        format!("{}__L{}", row.scene_id.as_ref().unwrap(), row.number)
    }
    fn metadata(source: &LockedSource, child: &str) -> Value {
        let row = source.rows.iter().find(|row| row.text.starts_with("△甲走进室内。")).unwrap();
        json!({"kind":"sceneMetadata","sourceSha256":source.sha256,"plan":{"episodeId":row.episode_id,"sceneId":child,"sourceRefs":[row.id],"location":"室内","characters":["甲"]}})
    }
    fn selected(source: &LockedSource) -> Vec<String> {
        vec![source.episodes[0].id.clone()]
    }
    fn assert_locked(before: &LockedSource, after: &LockedSource) {
        assert_eq!(before.text, after.text);
        assert_eq!(before.sha256, after.sha256);
        assert_eq!(before.length, after.length);
        assert_eq!(before.rows.len(), after.rows.len());
        for (before, after) in before.rows.iter().zip(&after.rows) {
            assert_eq!(before.id, after.id);
            assert_eq!(before.number, after.number);
            assert_eq!(before.text, after.text);
            assert_eq!(before.range.start, after.range.start);
            assert_eq!(before.range.end, after.range.end);
            assert_eq!(serde_json::to_value(&before.dialogue).unwrap(), serde_json::to_value(&after.dialogue).unwrap());
        }
        validate_source(after).unwrap();
    }

    #[test]
    fn same_response_split_then_child_metadata_are_previewed_without_changing_source() {
        let source = fixture();
        let original = serde_json::to_value(&source).unwrap();
        let child = child_id(&source);
        // Q1's scenes object can precede its sceneSplits object. The program
        // validates the actual cut first rather than guessing a new identity.
        let edited = preview_foundation_scene_edits(&source, &[metadata(&source, &child), split(&source)], &selected(&source)).unwrap();
        assert_locked(&source, &edited);
        assert_eq!(serde_json::to_value(&source).unwrap(), original);
        assert_eq!(edited.scenes.len(), source.scenes.len() + 1);
        assert_eq!(edited.scene_edits[0]["kind"], "sceneSplit");
        assert_eq!(edited.scene_edits[1]["kind"], "sceneMetadata");
        let scene = edited.scenes.iter().find(|scene| scene.id == child).unwrap();
        assert_eq!(scene.metadata["location"], "室内");
        assert_eq!(scene.metadata["characters"], json!(["甲"]));
        assert!(edited.episodes[0].scene_ids.contains(&child));
        assert_eq!(serde_json::to_value(&source.scenes[1]).unwrap(), serde_json::to_value(edited.scenes.last().unwrap()).unwrap());
    }

    #[test]
    fn preview_reuses_existing_edits_and_does_not_repeat_a_saved_split() {
        let source = fixture();
        let plan = split(&source);
        let edited = preview_foundation_scene_edits(&source, &[plan.clone()], &selected(&source)).unwrap();
        let child = child_id(&source);
        let with_metadata = preview_foundation_scene_edits(&edited, &[metadata(&source, &child), plan], &selected(&source)).unwrap();
        assert_locked(&source, &with_metadata);
        assert_eq!(with_metadata.scenes.len(), edited.scenes.len());
        assert_eq!(with_metadata.scene_edits.len(), 2);
        let repeated = preview_foundation_scene_edits(&with_metadata, &with_metadata.scene_edits, &selected(&source)).unwrap();
        assert_eq!(serde_json::to_value(repeated).unwrap(), serde_json::to_value(with_metadata).unwrap());
    }

    #[test]
    fn future_scene_name_requires_the_exact_same_response_cut_number() {
        let source = fixture();
        let child = child_id(&source);
        assert!(preview_foundation_scene_edits(&source, &[metadata(&source, &child)], &selected(&source)).is_err());
        for wrong in [format!("{child}0"), format!("{}__L99999", source.scenes[0].id), source.scenes[1].id.clone()] {
            assert!(preview_foundation_scene_edits(&source, &[split(&source), metadata(&source, &wrong)], &selected(&source)).is_err());
        }
        let mut borrowed = metadata(&source, &child);
        borrowed["plan"]["sourceRefs"] = json!([source.rows.last().unwrap().id]);
        assert!(preview_foundation_scene_edits(&source, &[split(&source), borrowed], &selected(&source)).is_err());
    }

    #[test]
    fn preview_rejects_scope_sha_source_anchor_and_unauthorized_field_changes() {
        let source = fixture();
        let original = serde_json::to_value(&source).unwrap();
        let valid = split(&source);
        let mut invalid = valid.clone(); invalid["sourceSha256"] = json!("other-source");
        assert!(preview_foundation_scene_edits(&source, &[invalid], &selected(&source)).is_err());
        assert!(preview_foundation_scene_edits(&source, &[valid.clone()], &[source.episodes[1].id.clone()]).is_err());
        let mut invalid = valid.clone(); invalid["plan"]["cuts"][0]["anchor"] = json!("△甲走到室内。");
        assert!(preview_foundation_scene_edits(&source, &[invalid], &selected(&source)).is_err());
        let mut invalid = valid.clone(); invalid["plan"]["cuts"][0]["rowId"] = json!("r:0:99999");
        assert!(preview_foundation_scene_edits(&source, &[invalid], &selected(&source)).is_err());
        let mut invalid = valid.clone(); invalid["plan"]["text"] = json!("替换原文");
        assert!(preview_foundation_scene_edits(&source, &[invalid], &selected(&source)).is_err());
        let mut invalid = valid.clone(); invalid["notAnEdit"] = json!(true);
        assert!(preview_foundation_scene_edits(&source, &[invalid], &selected(&source)).is_err());
        let mut invalid = metadata(&source, &child_id(&source)); invalid["plan"]["dialogue"] = json!("改话");
        assert!(preview_foundation_scene_edits(&source, &[valid, invalid], &selected(&source)).is_err());
        assert_eq!(serde_json::to_value(&source).unwrap(), original);
    }

    fn proposal(source: &LockedSource, child: &str, scope_only: bool) -> FoundationProposal {
        let cut = source.rows.iter().find(|row| row.text.starts_with("△甲走进室内。")).unwrap();
        let first = source.rows.iter().find(|row| row.text.starts_with("甲：（低声）")).unwrap();
        let variants = vec![
            json!({"id":"a:base","name":"基础","description":"已登记形象","sourceVariantId":null,"sourceRefs":[first.id,cut.id],"applicability":[{"episodeId":source.episodes[0].id,"sceneId":source.scenes[0].id}],"scope":{"kind":"SCENES","scenes":[{"episodeId":source.episodes[0].id,"sceneId":source.scenes[0].id}],"reason":null}}),
            json!({"id":"a:state","name":"室内状态","description":"本批形象","sourceVariantId":"a:base","sourceRefs":[cut.id],"applicability":[{"episodeId":source.episodes[0].id,"sceneId":child}],"scope":{"kind":"SCENES","scenes":[{"episodeId":source.episodes[0].id,"sceneId":child}],"reason":null}}),
        ];
        let mut value = json!({"schemaVersion":"foundation/v1","sourceSha256":source.sha256,"overview":"","direction":"","episodes":[],"facts":[],"updatedEpisodeIds":selected(source),
            "assets":[{"id":"a","name":"甲","kind":"CH","aliases":[],"description":"人物","sourceRefs":[first.id,cut.id],"variants":variants}],
            "issues":[{"coordinate":"split","problem":"待程序拆场","sourceRefs":[cut.id],"blocking":false,"episodeIds":selected(source),"details":{"owner":"PROGRAM","planKind":"sceneSplit","plan":split(source)["plan"]}},
                {"coordinate":"scene","problem":"待程序元数据","sourceRefs":[cut.id],"blocking":false,"episodeIds":selected(source),"details":{"owner":"PROGRAM","planKind":"sceneMetadata","plan":metadata(source,child)["plan"]}}]});
        if scope_only {
            for variant in value["assets"][0]["variants"].as_array_mut().unwrap() {
                variant["sourceRefsPurpose"] = json!("SOURCE_SCOPE");
                variant["sourceScope"] = json!({"sourceSha256":source.sha256,"kind":"PROGRAM_SCOPE"});
            }
        }
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn execution_preserves_exact_declared_scope_and_accepts_previewed_child_references() {
        let source = fixture();
        let child = child_id(&source);
        let mut proposal = proposal(&source, &child, true);
        let revised = execute_foundation_scene_edits(&source, &mut proposal).unwrap().unwrap();
        assert_locked(&source, &revised);
        assert_eq!(proposal.assets[0].variants[0].scope.scenes.len(), 1, "Scope anchors are not appearance evidence and must not broadcast into the child");
        assert_eq!(proposal.assets[0].variants[0].scope.scenes[0].scene_id, source.scenes[0].id);
        assert_eq!(proposal.assets[0].variants[1].scope.scenes.len(), 1);
        assert_eq!(proposal.assets[0].variants[1].scope.scenes[0].scene_id, child);
        assert_eq!(proposal.assets[0].variants[1].source_variant_id.as_deref(), Some("a:base"));
        assert!(proposal.issues.is_empty());
        validate_foundation(&revised, &proposal).unwrap();
        assert!(execute_foundation_scene_edits(&revised, &mut proposal).unwrap().is_none());
    }

    #[test]
    fn actual_evidence_can_reproject_but_unknown_scene_references_still_fail() {
        let source = fixture();
        let child = child_id(&source);
        let mut evidence = proposal(&source, &child, false);
        let revised = execute_foundation_scene_edits(&source, &mut evidence).unwrap().unwrap();
        assert_eq!(evidence.assets[0].variants[0].scope.scenes.len(), 2);
        validate_foundation(&revised, &evidence).unwrap();
        let mut invalid = proposal(&source, &child, true);
        invalid.assets[0].variants[1].scope.scenes[0].scene_id = format!("{child}0");
        invalid.assets[0].variants[1].applicability = invalid.assets[0].variants[1].scope.scenes.clone();
        assert!(execute_foundation_scene_edits(&source, &mut invalid).is_err());
    }

    #[test]
    #[ignore = "offline replay of retained local Q1 fixture only; no CLI, model, or database"]
    fn recorded_q1_plans_prove_only_the_six_exact_cut_line_children() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../reports/foundation-real-a-20261005");
        let source: LockedSource = serde_json::from_str(&std::fs::read_to_string(directory.join("source.json")).unwrap()).unwrap();
        let response: Value = serde_json::from_str(&std::fs::read_to_string(directory.join("rejected-q1.json")).unwrap()).unwrap();
        let result = &response["result"];
        let selected = result["coverage"].as_array().unwrap().iter()
            .map(|id| id.as_str().unwrap().to_string()).collect::<Vec<_>>();
        let mut edits = vec![];
        for split in result["changes"]["sceneSplits"].as_array().unwrap() {
            let mut plan = split.clone();
            for cut in plan["cuts"].as_array_mut().unwrap() {
                let compact = text(cut, "rowId").to_owned();
                let row = source.rows.iter().find(|row| {
                    row.id == compact || format!("r:{}:{}", row.range.start, row.range.end) == compact
                }).expect("A compact cut must exactly map to this source's locked row");
                cut["rowId"] = json!(row.id);
            }
            edits.push(json!({"kind":"sceneSplit","sourceSha256":source.sha256,"plan":plan}));
        }
        let splits = preview_foundation_scene_edits(&source, &edits, &selected).unwrap();
        for scene in result["changes"]["scenes"].as_array().unwrap() {
            let mut plan = scene.clone();
            let row = splits.rows.iter().find(|row| row.kind == "body"
                && row.episode_id.as_deref() == Some(text(&plan, "episodeId"))
                && row.scene_id.as_deref() == Some(text(&plan, "sceneId")))
                .expect("Metadata can name only an existing scene or this response's proved child");
            plan["sourceRefs"] = json!([row.id]);
            edits.insert(0, json!({"kind":"sceneMetadata","sourceSha256":source.sha256,"plan":plan}));
        }
        let revised = preview_foundation_scene_edits(&source, &edits, &selected).unwrap();
        assert_locked(&source, &revised);
        let children = revised.scenes.iter().filter(|scene| !source.scenes.iter().any(|before| before.id == scene.id))
            .map(|scene| scene.id.split_once("__L").unwrap().1.parse::<usize>().unwrap()).collect::<Vec<_>>();
        assert_eq!(children, [164, 215, 286, 290, 295, 347]);
        assert_eq!(revised.scenes.len(), source.scenes.len() + 6);
        assert_eq!(revised.scenes.iter().find(|scene| scene.id.ends_with("__L215")).unwrap().metadata["location"], "姑苏市上空");
    }
}
