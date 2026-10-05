//! Port of the 3008 light delivery: program fidelity -> packed F2 -> differential Q1.
//! The frozen single-episode implementation remains in the parent module.
use super::*;
use serde_json::Map;
use std::collections::BTreeSet;

pub const METHOD_VERSION: &str = "foundation-delivery/v2";
// Original defaults: project-foundation-contracts.ts, foundation-fragments.ts,
// and project-foundation.ts. These are application UTF-16 budgets, not model tokens.
const SOURCE_BUDGET: usize = 24_000;
const FRAGMENT_BUDGET: usize = 18_000;
const REQUEST_BUDGET: usize = 200_000;
const OUTPUT_RESERVE: usize = 24_000;
const BACKGROUND_CANDIDATES_BUDGET: usize = 12_000;
const F2_RULE: &str = "foundation-asset-catalog";
const Q1_RULE: &str = "foundation-finishing-editor";

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}
fn optional_obj(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn refs_schema() -> Value {
    array(string())
}
fn preparation_schema() -> Value {
    optional_obj(
        json!({"mode":choices(&["REFERENCE","DERIVE","INLINE","AUDIO","UNRESOLVED"]),"fromKey":string(),"note":string()}),
        &["mode"],
    )
}
fn asset_schema(patch: bool) -> Value {
    // Original light catalog: models declare identity and actual use. Rust binds
    // the source scope; a row-by-row evidence inventory is not F2/Q1's job.
    let variant = optional_obj(
        json!({"key":string(),"name":string(),"episodes":refs_schema(),"sceneRefs":array(array(string())),"note":string(),"preparation":preparation_schema(),"scope":optional_obj(json!({"kind":choices(&["SCENES","GLOBAL","UNRESOLVED"]),"reason":string()}), &["kind"])}),
        if patch {
            &[][..]
        } else {
            &["name", "episodes", "sceneRefs"][..]
        },
    );
    optional_obj(
        json!({"key":string(),"name":string(),"type":choices(&["CH","GROUP","BEAST","LOC","PROP"]),"aliases":refs_schema(),"episodes":refs_schema(),"sceneRefs":array(array(string())),"role":string(),"relationNote":string(),"description":string(),"preparation":preparation_schema(),"variants":array(variant),"scope":optional_obj(json!({"kind":choices(&["SCENES","GLOBAL","UNRESOLVED"]),"reason":string()}), &["kind"])}),
        if patch {
            &[][..]
        } else {
            &[
                "name",
                "type",
                "episodes",
                "sceneRefs",
                "preparation",
            ][..]
        },
    )
}
fn issue_schema() -> Value {
    optional_obj(
        json!({"coordinate":string(),"problem":string(),"sourceRefs":refs_schema(),"blocking":{"type":"boolean"},"assetId":string(),"variantId":string(),"episodeIds":refs_schema()}),
        &["coordinate", "problem", "sourceRefs", "blocking"],
    )
}
fn choice_schema() -> Value {
    optional_obj(
        json!({"decisionKey":string(),"kind":choices(&["SOURCE_CONFLICT","PRODUCTION_CHOICE"]),"question":string(),"reason":string(),"options":refs_schema(),"recommended":string(),"recommendationReason":string(),"evidence":string(),"episodes":refs_schema(),"sourceRefs":refs_schema(),"changeTargets":obj(json!({"assetKeys":refs_schema(),"assetFields":refs_schema(),"sceneFields":refs_schema()})),"applicationScope":optional_obj(json!({"kind":choices(&["GLOBAL","EPISODES","SCENES"]),"episodes":refs_schema(),"scenes":array(array(string()))}), &["kind"]),"evidenceRefs":array(obj(json!({"rowId":string()}))),"receivingUses":refs_schema()}),
        &[
            "decisionKey",
            "kind",
            "question",
            "reason",
            "options",
            "recommended",
            "recommendationReason",
            "evidence",
            "episodes",
            "sourceRefs",
        ],
    )
}
fn pending_schema() -> Value {
    optional_obj(
        json!({"owner":choices(&["Q1","PROGRAM","STAGE2"]),"key":string(),"episodes":refs_schema(),"note":string(),"sourceRefs":refs_schema()}),
        &["owner", "episodes", "note", "sourceRefs"],
    )
}
fn f2_schema() -> Value {
    optional_obj(
        json!({"format":choices(&["ASSET_CATALOG_DESKTOP_V2"]),"sourceSha256":string(),"coverage":refs_schema(),"assets":array(asset_schema(false)),"issues":array(issue_schema()),"humanChoices":array(choice_schema()),"unresolved":array(pending_schema()),"notes":refs_schema()}),
        &["format", "sourceSha256", "coverage", "assets"],
    )
}
fn q1_schema() -> Value {
    let scene = optional_obj(
        json!({"episodeId":string(),"sceneId":string(),"location":string(),"timeOfDay":string(),"interiorExterior":string(),"timeLayer":string(),"weather":string(),"characters":refs_schema()}),
        &["episodeId", "sceneId"],
    );
    let split = obj(
        json!({"episodeId":string(),"sceneId":string(),"cuts":array(obj(json!({"rowId":string(),"anchor":string()})))}),
    );
    let episode = optional_obj(
        json!({"episodeId":string(),"summary":string(),"context":string()}),
        &["episodeId"],
    );
    let merge = obj(
        json!({"fromKey":string(),"intoKey":string(),"sourceRefs":refs_schema(),"reason":string()}),
    );
    let signal =
        obj(json!({"episodeId":string(),"rowId":string(),"quote":string(),"reading":string()}));
    optional_obj(
        json!({"format":choices(&["ASSET_OPTIMIZATION_DESKTOP_V2"]),"sourceSha256":string(),"coverage":refs_schema(),"changes":optional_obj(json!({"assets":array(asset_schema(true)),"removeAssetKeys":refs_schema(),"mergeAssets":array(merge),"episodes":array(episode),"overview":string(),"scenes":array(scene),"sceneSplits":array(split)}), &[]),"issues":array(issue_schema()),"resolvedIssues":refs_schema(),"seriesDirection":optional_obj(json!({"signals":array(signal),"content":string()}), &[]),"humanChoices":array(choice_schema()),"unresolved":array(pending_schema()),"notes":refs_schema()}),
        &["format", "sourceSha256", "coverage", "changes"],
    )
}

#[derive(Clone, Debug)]
struct Piece {
    row_id: String,
    start: usize,
    end: usize,
    text: String,
}
#[derive(Clone, Debug)]
struct Batch {
    scope: Vec<String>,
    pieces: Vec<Piece>,
    fragment: Option<Value>,
}
impl Batch {
    fn row_ids(&self) -> HashSet<&str> {
        self.pieces.iter().map(|p| p.row_id.as_str()).collect()
    }
    fn key(&self) -> String {
        digest(
            &json!([
                self.scope,
                self.pieces
                    .iter()
                    .map(|p| (&p.row_id, p.start, p.end))
                    .collect::<Vec<_>>()
            ])
            .to_string(),
        )
    }
}
fn whole_rows(source: &LockedSource, scope: &[String]) -> Vec<Piece> {
    source
        .rows
        .iter()
        .filter(|r| r.episode_id.as_ref().is_some_and(|e| scope.contains(e)))
        .map(|r| Piece {
            row_id: r.id.clone(),
            start: r.range.start,
            end: r.range.end,
            text: r.text.clone(),
        })
        .collect()
}
fn split_episode(source: &LockedSource, episode: &str) -> Result<Vec<Batch>, String> {
    let rows = whole_rows(source, &[episode.into()]);
    let text: String = rows.iter().map(|r| r.text.as_str()).collect();
    let mut spans = vec![];
    let mut from = 0;
    let length = units(&text);
    while from < length {
        let target = (from + FRAGMENT_BUDGET).min(length);
        let mut end = from;
        let mut cursor = 0;
        let mut newline = None;
        for ch in text.chars() {
            let next = cursor + ch.len_utf16();
            if next > target {
                break;
            }
            if next > from {
                end = next;
            }
            if ch == '\n' && next >= from + FRAGMENT_BUDGET / 2 {
                newline = Some(next);
            }
            cursor = next;
        }
        if target < length {
            if let Some(at) = newline {
                end = at;
            } else if end > from
                && slice_utf16(
                    &text,
                    &SourceRange {
                        start: end - 1,
                        end,
                    },
                )
                .ok()
                .as_deref()
                    == Some("\r")
            {
                end -= 1;
            }
        }
        if end <= from {
            return Err("长集分片无法取得完整 Unicode 边界".into());
        }
        spans.push((from, end));
        from = end;
    }
    let mut result = vec![];
    for (index, (start, end)) in spans.iter().copied().enumerate() {
        let mut offset = 0;
        let mut pieces = vec![];
        for row in &rows {
            let limit = offset + units(&row.text);
            let a = start.max(offset);
            let b = end.min(limit);
            if b > a {
                pieces.push(Piece {
                    row_id: row.row_id.clone(),
                    start: row.start + a - offset,
                    end: row.start + b - offset,
                    text: slice_utf16(
                        &row.text,
                        &SourceRange {
                            start: a - offset,
                            end: b - offset,
                        },
                    )?,
                });
            }
            offset = limit;
        }
        let fragment = json!({"episodeId":episode,"index":index,"count":spans.len(),"start":start,"end":end,"sourceSha256":source.sha256});
        result.push(Batch {
            scope: vec![episode.into()],
            pieces,
            fragment: Some(fragment),
        });
    }
    Ok(result)
}
fn plan_batches(source: &LockedSource, selected: &[String]) -> Result<Vec<Batch>, String> {
    let mut result = vec![];
    let mut pending = vec![];
    let mut size = 0;
    for episode in source.episodes.iter().filter(|e| selected.contains(&e.id)) {
        let rows = whole_rows(source, &[episode.id.clone()]);
        let count = rows.iter().map(|p| units(&p.text)).sum::<usize>();
        if count > SOURCE_BUDGET {
            if !pending.is_empty() {
                result.push(Batch {
                    pieces: whole_rows(source, &pending),
                    scope: std::mem::take(&mut pending),
                    fragment: None,
                });
                size = 0;
            }
            result.extend(split_episode(source, &episode.id)?);
        } else {
            if !pending.is_empty() && size + count > SOURCE_BUDGET {
                result.push(Batch {
                    pieces: whole_rows(source, &pending),
                    scope: std::mem::take(&mut pending),
                    fragment: None,
                });
                size = 0;
            }
            pending.push(episode.id.clone());
            size += count;
        }
    }
    if !pending.is_empty() {
        result.push(Batch {
            pieces: whole_rows(source, &pending),
            scope: pending,
            fragment: None,
        });
    }
    verify_coverage(source, selected, &result)?;
    Ok(result)
}
fn verify_coverage(
    source: &LockedSource,
    selected: &[String],
    batches: &[Batch],
) -> Result<(), String> {
    for row in source
        .rows
        .iter()
        .filter(|r| r.episode_id.as_ref().is_some_and(|e| selected.contains(e)))
    {
        let mut pieces = batches
            .iter()
            .flat_map(|b| &b.pieces)
            .filter(|p| p.row_id == row.id)
            .collect::<Vec<_>>();
        pieces.sort_by_key(|p| p.start);
        let mut end = row.range.start;
        let mut restored = String::new();
        for part in pieces {
            if part.start != end || part.end <= part.start {
                return Err("来源分批存在遗漏、重叠或乱序".into());
            }
            end = part.end;
            restored.push_str(&part.text);
        }
        if end != row.range.end || restored != row.text {
            return Err("来源分批未完整逐字覆盖锁定行".into());
        }
    }
    Ok(())
}

/// Names/aliases only retrieve evidence. They never determine canonical identity or current state.
fn evidence(source: &LockedSource, batch: &Batch, foundation: &FoundationProposal) -> Value {
    let current: String = batch.pieces.iter().map(|p| p.text.as_str()).collect();
    let mut names: BTreeSet<String> = source
        .rows
        .iter()
        .filter_map(|r| r.dialogue.as_ref())
        .map(|d| d.speaker.clone())
        .collect();
    for asset in &foundation.assets {
        names.insert(asset.name.clone());
        names.extend(asset.aliases.iter().cloned());
        if let Some((name, _)) = asset.name.split_once(['|', '｜']) {
            names.insert(name.into());
        }
    }
    names.retain(|name| !name.is_empty() && current.contains(name));
    for asset in &foundation.assets {
        if names.contains(&asset.name) || asset.aliases.iter().any(|a| names.contains(a)) {
            names.insert(asset.name.clone());
            names.extend(asset.aliases.iter().cloned());
        }
    }
    let relevant = |text: &str| names.iter().any(|name| text.contains(name));
    let earliest = source
        .episodes
        .iter()
        .filter(|e| batch.scope.contains(&e.id))
        .map(|e| e.number)
        .min()
        .unwrap_or(0);
    let history: Vec<_> = source
        .rows
        .iter()
        .filter(|r| {
            r.episode_id.as_ref().is_some_and(|id| {
                source
                    .episodes
                    .iter()
                    .any(|e| &e.id == id && e.number < earliest)
            }) && r.kind != "format"
        })
        .collect();
    let anchors: HashSet<_> = history
        .iter()
        .filter(|r| relevant(&r.text))
        .map(|r| r.id.as_str())
        .collect();
    let mut candidates = vec![];
    for (at, row) in history.iter().enumerate() {
        let neighbours = [
            at.checked_sub(1).and_then(|i| history.get(i)),
            history.get(at + 1),
        ]
        .into_iter()
        .flatten()
        .filter(|r| r.episode_id == row.episode_id && anchors.contains(r.id.as_str()))
        .map(|r| r.id.as_str())
        .collect::<Vec<_>>();
        if anchors.contains(row.id.as_str()) || !neighbours.is_empty() {
            candidates.push(json!([
                row.id,
                row.episode_id,
                row.scene_id,
                row.text,
                if row.dialogue.is_some() {
                    "CHARACTER_CLAIM"
                } else {
                    "SOURCE"
                },
                if anchors.contains(row.id.as_str()) {
                    "SUBJECT_MENTION"
                } else {
                    "SOURCE_NEIGHBOUR"
                },
                neighbours
            ]));
        }
    }
    let mut background = vec![];
    let mut unlinked = vec![];
    let mut omitted = vec![];
    let mut count = 0;
    for row in source.rows.iter().filter(|r| r.kind == "context") {
        let explicit = row.dialogue.is_none()
            && [
                "规则：",
                "规则:",
                "世界规则：",
                "世界观规则：",
                "世界观设定：",
                "世界设定：",
            ]
            .iter()
            .any(|prefix| row.text.trim_start().starts_with(prefix));
        let entry = json!([
            row.id,
            row.text,
            if row.dialogue.is_some() {
                "CHARACTER_CLAIM"
            } else {
                "SOURCE"
            },
            if explicit {
                "EXPLICIT_GLOBAL_DECLARATION"
            } else {
                "UNRESOLVED"
            }
        ]);
        if explicit || relevant(&row.text) {
            background.push(entry);
        } else if count + units(&row.text) <= BACKGROUND_CANDIDATES_BUDGET {
            count += units(&row.text);
            unlinked.push(entry);
        } else {
            omitted.push(json!([row.id, row.number, row.range.start, row.range.end]));
        }
    }
    json!({"schema":"FOUNDATION_EVIDENCE_DESKTOP_V2","backgroundColumns":["rowId","text","claim","applicability"],"background":background,"backgroundCandidates":unlinked,"backgroundCandidatesOmitted":omitted,"historicalColumns":["rowId","episodeId","sceneId","text","claim","retrievalMode","anchorRowIds"],"historicalEvidenceCandidates":candidates,"pendingIssues":foundation.issues.iter().filter(|issue|issue.episode_ids.is_empty()||issue.episode_ids.iter().any(|id|batch.scope.contains(id))).collect::<Vec<_>>(),"candidateUse":"HISTORICAL_EVIDENCE_ONLY","currentApplicability":"UNKNOWN","rule":"姓名/别名/邻句仅检索；不证明同身份、知情、时序或状态永久延续。台词只是CHARACTER_CLAIM。匿名资料不是GLOBAL；未来剧情不提前应用。pendingIssues仅本批关联待办，Q1实际局部修正才回resolvedIssues坐标；PROGRAM事项不能由模型仅回执关闭。"})
}
fn registry(foundation: &FoundationProposal) -> Value {
    json!(foundation.assets.iter().map(|a|json!({"key":a.id,"name":a.metadata.get("catalogName").cloned().unwrap_or(json!(a.name)),"type":a.kind,"aliases":a.aliases,"variants":a.variants.iter().map(|v|json!({"key":v.id,"name":v.name,"fromKey":v.source_variant_id})).collect::<Vec<_>>()})).collect::<Vec<_>>())
}
fn catalogue(foundation: &FoundationProposal, batch: &Batch) -> Value {
    let row_ids = batch.row_ids();
    json!(foundation.assets.iter().filter(|a|a.variants.iter().any(|v|v.scope.kind=="GLOBAL"||v.scope.scenes.iter().any(|s|batch.scope.contains(&s.episode_id)))||a.source_refs.iter().any(|id|row_ids.contains(id.as_str()))).map(|a| {
        let mut value=json!({"key":a.id,"name":a.metadata.get("catalogName").cloned().unwrap_or(json!(a.name)),"type":a.kind,"aliases":a.aliases,"sourceRefs":a.source_refs,"variants":a.variants.iter().map(|v|{
            let mut item=json!({"key":v.id,"name":v.name,"sourceRefs":v.source_refs,"sceneRefs":v.scope.scenes.iter().filter(|s|batch.scope.contains(&s.episode_id)).map(|s|json!([s.episode_id,s.scene_id])).collect::<Vec<_>>(),"scope":{"kind":v.scope.kind,"reason":v.scope.reason},"fromKey":v.source_variant_id});
            if let Some(map)=item.as_object_mut(){for (key,val) in &v.metadata {map.insert(key.clone(),val.clone());}} item
        }).collect::<Vec<_>>()});
        if let Some(map)=value.as_object_mut(){for (key,val) in &a.metadata {map.insert(key.clone(),val.clone());}} value
    }).collect::<Vec<_>>())
}
fn input_for_legacy(
    stage: &str,
    source: &LockedSource,
    batch: &Batch,
    foundation: &FoundationProposal,
    context: &Value,
    index: usize,
    total: usize,
    final_batch: bool,
    direction_signals: &[Value],
) -> Value {
    let ids = batch.row_ids();
    let source_rows: HashMap<_, _> = source
        .rows
        .iter()
        .map(|row| (row.id.as_str(), row))
        .collect();
    let rows: Vec<_> = batch
        .pieces
        .iter()
        .map(|piece| {
            let row = source_rows[piece.row_id.as_str()];
            json!([
                piece.row_id,
                row.number,
                row.episode_id,
                row.scene_id,
                row.kind,
                row.dialogue.as_ref().map(|d| d.speaker.as_str()),
                row.dialogue.as_ref().map(|d| d.channel.as_str()),
                piece.start,
                piece.end,
                piece.text
            ])
        })
        .collect();
    json!({"method":METHOD_VERSION,"catalogueContract":"light-catalogue/v1","sourceReferenceEncoding":"row-coordinates/v1","sourceSha256":source.sha256,"scope":batch.scope,"batch":batch.key(),"batchIndex":index,"delivery":{"method":METHOD_VERSION,"stage":stage,"phase":if stage=="F2"{"GENERATE_F2"}else{"EDIT"},"scope":batch.scope,"batchIndex":index,"batchCount":total,"fragment":batch.fragment},"source":{"columns":["rowId","line","episodeId","sceneId","kind","speaker","channel","start","end","text"],"coordinateSystem":"UTF-16 half-open","rows":rows},"scenes":source.scenes.iter().filter(|s|s.row_ids.iter().any(|id|ids.contains(id.as_str()))).map(|s|json!([s.episode_id,s.id,s.title])).collect::<Vec<_>>(),"registry":registry(foundation),"candidates":if stage=="Q1"{catalogue(foundation,batch)}else{json!(null)},"evidence":evidence(source,batch,foundation),"humanChoiceRegistry":foundation.issues.iter().filter_map(|issue|issue.details.as_ref().and_then(|details|details.get("choice"))).collect::<Vec<_>>(),"transportInstructions":"schema使用桌面固定format；episodes/coverage为输入episodeId，sceneRefs为[episodeId,sceneId]。资产/形象及普通集场修订沿旧轻量目录，不填写sourceRefs；Rust绑定实际sourceSha和声明的集场范围，范围资料不是外观事实。真正事项证据、方向与拆场rowId只选schema枚举的r:start:end，与输入第1列的row:源前缀:start:end逐个对应；程序绑定当前sourceSha还原，不重算或拼接start/end。humanChoices保留旧完整问题/方案/推荐/权限及必要sourceRefs；推荐不是已确认，技术错误不得包装为取舍。程序保存choice到issues.details，普通notes不阻塞；仅有据源矛盾阻塞关联范围。unresolved使用owner/episodes/note/sourceRefs。Q1省略/null保留字段，只交差异，不把PROGRAM计划声称已执行。","projectConditions":context.get("settings").cloned().unwrap_or(json!({})),"seriesDirectionPreparation":if stage=="Q1"{json!({"mode":if final_batch{"FINAL"}else{"SIGNALS"},"priorSignals":direction_signals,"priorDirection":foundation.direction,"confirmedDirection":context.pointer("/settings/confirmedDirection"),"scope":context.pointer("/selection/episodeIds")})}else{json!(null)}})
}
// A model projection, never the saved catalogue. Like the original production
// contract, usage is local and unlocated definitions remain separate candidates.
fn light_catalogue(foundation: &FoundationProposal, batch: &Batch) -> (Value, Value) {
    fn program_scope(meta: &Map<String, Value>, sha: &str) -> bool {
        meta.get("sourceRefsPurpose").and_then(Value::as_str) == Some("SOURCE_SCOPE")
            && meta.get("sourceScope").is_some_and(|scope| {
                scope["kind"] == "PROGRAM_SCOPE" && scope["sourceSha256"] == sha
            })
    }
    fn metadata(meta: &Map<String, Value>, refs: &[String], sha: &str) -> Map<String, Value> {
        let mut out = meta.clone();
        for key in ["catalogName", "usageEpisodes", "key", "name", "type", "aliases", "variants", "sceneRefs", "scope", "fromKey"] {
            out.remove(key);
        }
        if program_scope(meta, sha) {
            out.remove("sourceScope");
            out.remove("sourceRefsPurpose");
            out.remove("sourceRefs");
        } else if !refs.is_empty() {
            out.insert("sourceRefs".into(), json!(refs));
        }
        out
    }
    fn variant(v: &FoundationVariant, batch: &Batch, sha: &str) -> Value {
        let mut value = Value::Object(metadata(&v.metadata, &v.source_refs, sha));
        value["key"] = json!(v.id);
        value["name"] = json!(v.name);
        value["fromKey"] = json!(v.source_variant_id);
        value["scope"] = json!({"kind":v.scope.kind,"reason":v.scope.reason});
        let scenes: Vec<_> = v.scope.scenes.iter().filter(|s|batch.scope.contains(&s.episode_id)).collect();
        value["sceneRefs"] = json!(scenes.iter().map(|s|json!([s.episode_id,s.scene_id])).collect::<Vec<_>>());
        value["episodes"] = json!(batch.scope.iter().filter(|ep|v.scope.kind=="GLOBAL"||scenes.iter().any(|s|&s.episode_id==*ep)).collect::<Vec<_>>());
        if !program_scope(&v.metadata, sha) && !v.description.is_empty() {
            value["description"] = json!(v.description);
        }
        value
    }
    let mut candidates = vec![];
    let mut unlocated = vec![];
    for a in &foundation.assets {
        let local = |v: &FoundationVariant| v.scope.kind=="GLOBAL" || v.scope.scenes.iter().any(|s|batch.scope.contains(&s.episode_id));
        let located = a.variants.iter().any(|v|v.scope.kind=="GLOBAL"||!v.scope.scenes.is_empty());
        let mut value = Value::Object(metadata(&a.metadata, &a.source_refs, &foundation.source_sha256));
        value["key"] = json!(a.id);
        value["name"] = a.metadata.get("catalogName").cloned().unwrap_or(json!(a.name));
        value["type"] = json!(a.kind);
        value["aliases"] = json!(a.aliases);
        value["episodes"] = json!(batch.scope.iter().filter(|ep|a.variants.iter().any(|v|v.scope.kind=="GLOBAL"||v.scope.scenes.iter().any(|s|&s.episode_id==*ep))).collect::<Vec<_>>());
        if !program_scope(&a.metadata,&foundation.source_sha256) && !a.description.is_empty() {
            value["description"] = json!(a.description);
        }
        value["variants"] = json!(a.variants.iter().filter(|v|local(v)||v.metadata.get("isBase")==Some(&json!(true))).map(|v|variant(v,batch,&foundation.source_sha256)).collect::<Vec<_>>());
        value["crossBatchVariants"] = json!(a.variants.iter().filter(|v|!local(v)&&v.metadata.get("isBase")!=Some(&json!(true))).map(|v|json!({"key":v.id,"name":v.name,"fromKey":v.source_variant_id,"preparation":v.metadata.get("preparation")})).collect::<Vec<_>>());
        if a.variants.iter().any(local) {
            candidates.push(value.clone());
        }
        if !located {
            // The entire unlocated definition remains available, including
            // child design notes; it still grants no usage in this batch.
            value["variants"]=json!(a.variants.iter().map(|v|variant(v,batch,&foundation.source_sha256)).collect::<Vec<_>>());
            value["crossBatchVariants"]=json!([]);
            value["baseKey"]=json!(a.id);
            value["kind"]=json!("BASE");
            value["use"]=json!("CANDIDATE_ONLY");
            value["reason"]=json!("UNLOCATED_USAGE");
            unlocated.push(value);
        } else {
            for v in a.variants.iter().filter(|v|v.scope.kind!="GLOBAL"&&v.scope.scenes.is_empty()) {
                let mut item=variant(v,batch,&foundation.source_sha256);
                item["baseKey"]=json!(a.id);item["baseName"]=json!(a.name);item["type"]=json!(a.kind);
                item["kind"]=json!("VARIANT");item["use"]=json!("CANDIDATE_ONLY");item["reason"]=json!("UNLOCATED_USAGE");
                unlocated.push(item);
            }
        }
    }
    (json!(candidates),json!(unlocated))
}

fn input_for(
    stage: &str, source: &LockedSource, batch: &Batch,
    foundation: &FoundationProposal, context: &Value, index: usize,
    total: usize, final_batch: bool, direction_signals: &[Value],
) -> Value {
    let mut input=input_for_legacy(stage,source,batch,foundation,context,index,total,final_batch,direction_signals);
    if context["foundationModelInputProfile"] != super::foundation_wire::PROFILE {
        return input; // Frozen tasks and accepted cache retain their original wire.
    }
    input["modelInputProfile"]=json!(super::foundation_wire::PROFILE);
    input["registry"]=json!(foundation.assets.iter().map(|a|json!({"key":a.id,"name":a.metadata.get("catalogName").cloned().unwrap_or(json!(a.name)),"type":a.kind,"aliases":a.aliases,"variants":a.variants.iter().map(|v|json!({"key":v.id,"name":v.name,"fromKey":v.source_variant_id,"preparation":v.metadata.get("preparation")})).collect::<Vec<_>>()})).collect::<Vec<_>>());
    if stage=="Q1" {
        let (candidates,unlocated)=light_catalogue(foundation,batch);
        let local_keys:HashSet<_>=candidates.as_array().unwrap().iter().chain(unlocated.as_array().unwrap()).filter(|a|a["kind"]!="VARIANT").filter_map(|a|a.get("baseKey").or_else(||a.get("key"))).filter_map(Value::as_str).collect();
        input["registry"].as_array_mut().unwrap().retain(|a|!local_keys.contains(a["key"].as_str().unwrap_or("")));
        input["candidates"]=candidates;
        input["materialCandidates"]=unlocated;
    }
    let guide=input["transportInstructions"].as_str().unwrap().to_owned();
    input["transportInstructions"]=json!(format!("{guide} 本批candidates仅本批适用形象及独立base形象；crossBatchVariants仅用于身份/制作来源识别，不表示本批出场。materialCandidates未定位，不能当成本批出场或GLOBAL。SOURCE_SCOPE程序范围引用从轻目录省略，真正视觉证据保留。F2重整已登记key时沿用registry中的preparation/fromKey；需要改变既有制作来源应提出关联问题，不重新推断覆盖来源。Q1仍按旧规约交明确差异修订。"));
    input
}

pub(crate) const MODEL_TRANSPORT_LIMIT:usize=REQUEST_BUDGET-OUTPUT_RESERVE;
fn request_chars(stage: &str, input: &Value, schema: &Value) -> Result<usize, String> {
    // Unlike the old schema:null CLI request, desktop output-schema is actual input.
    // Account for the exact strict output-schema wire without changing the domain
    // schema saved in a TextRequest or any previously accepted cache identity.
    let exact_schema=if schema.get("$defs").is_some() {schema.clone()} else {delivery_schema(stage,input)};
    if input["modelInputProfile"]==super::foundation_wire::PROFILE {
        let compiled=super::foundation_wire::compile(&format!("foundation:{stage}"),input,&exact_schema)?;
        let skill=if stage=="F2"{F2_RULE}else{Q1_RULE};
        let request=TextRequest{stage:format!("foundation:{stage}"),skill:skill.into(),model:"m".repeat(128),reasoning:"ultra".into(),input:input.clone(),schema:exact_schema,rule_snapshot:snapshot(skill,&[])?};
        return Ok(crate::text_executor::transport_payload_characters(&request,&compiled.input,&compiled.schema));
    }
    // Frozen legacy requests retain their original planning and cache identity.
    let wire_schema = crate::text_executor::structured_schema_for_budget(&exact_schema);
    let request = json!({"stage":format!("foundation:{stage}"),"skill":if stage=="F2"{F2_RULE}else{Q1_RULE},"rules":snapshot(if stage=="F2"{F2_RULE}else{Q1_RULE},&[])?,"input":input,"schema":wire_schema});
    Ok(units(&request.to_string()))
}
fn fits(stage: &str, input: &Value, schema: &Value) -> Result<bool, String> {
    Ok(request_chars(stage, input, schema)? + OUTPUT_RESERVE <= REQUEST_BUDGET)
}

const HISTORY_DICTIONARY_FORMAT: &str = "HISTORICAL_EVIDENCE_TABLE_DESKTOP_V1";
const HISTORY_DICTIONARY_GUIDE: &str = "columns逐行对应rows；dictionaries按字段名给出值表，行内整数为该值表零起始索引。每行仍独立，rowId原样保留，不合并相同原句或人物事件。anchorRowIds的整数为本表rows零起始行号，恢复为那一行原rowId，顺序不变。text逐字保留；null仅为原显式空值。所有候选仅HISTORICAL_EVIDENCE_ONLY、当前适用性UNKNOWN；CHARACTER_CLAIM不升级为事实。";
const HISTORY_COLUMNS: [&str; 7] = [
    "rowId",
    "episodeId",
    "sceneId",
    "text",
    "claim",
    "retrievalMode",
    "anchorRowIds",
];

/// Equivalent to 3008 foundation-model-input.ts's exact dictionaries and
/// anchorRows projection. Desktop source row IDs are already stable and stay
/// explicit; no source hashes are recomputed or semantic candidates merged.
fn compact_history(value: &Value) -> Result<Value, String> {
    let Some(rows) = value.as_array().filter(|rows| rows.len() >= 2) else {
        return Ok(value.clone());
    };
    let mut positions = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        let Some(fields) = row.as_array().filter(|fields| fields.len() == 7) else {
            return Ok(value.clone());
        };
        let Some(id) = fields[0].as_str().filter(|id| !id.is_empty()) else {
            return Ok(value.clone());
        };
        if positions.insert(id.to_owned(), index).is_some()
            || !fields[1].is_string()
            || !(fields[2].is_string() || fields[2].is_null())
            || !fields[3].is_string()
            || !matches!(fields[4].as_str(), Some("SOURCE" | "CHARACTER_CLAIM"))
            || !matches!(
                fields[5].as_str(),
                Some("SUBJECT_MENTION" | "SOURCE_NEIGHBOUR")
            )
            || !fields[6].is_array()
        {
            return Ok(value.clone());
        }
    }
    if rows.iter().any(|row| {
        row[6]
            .as_array()
            .unwrap()
            .iter()
            .any(|anchor| anchor.as_str().is_none_or(|id| !positions.contains_key(id)))
    }) {
        return Ok(value.clone()); // Unknown/legacy links stay addressable and unchanged.
    }
    let mut encoded = rows.clone();
    let mut dictionaries = Map::new();
    for column in 1..=5 {
        let mut dictionary = vec![];
        let mut indexes = HashMap::new();
        let mut projected = vec![];
        for row in rows {
            let key = row[column].to_string();
            let index = *indexes.entry(key).or_insert_with(|| {
                dictionary.push(row[column].clone());
                dictionary.len() - 1
            });
            projected.push(json!(index));
        }
        let original: Vec<_> = rows.iter().map(|row| row[column].clone()).collect();
        if units(&json!({HISTORY_COLUMNS[column]:dictionary}).to_string())
            + units(&json!(projected).to_string())
            < units(&json!(original).to_string())
        {
            dictionaries.insert(HISTORY_COLUMNS[column].into(), json!(dictionary));
            for (row, index) in encoded.iter_mut().zip(projected) {
                row[column] = index;
            }
        }
    }
    for row in &mut encoded {
        row[6] = json!(row[6]
            .as_array()
            .unwrap()
            .iter()
            .map(|anchor| positions[anchor.as_str().unwrap()])
            .collect::<Vec<_>>());
    }
    let table = json!({"format":HISTORY_DICTIONARY_FORMAT,"columns":HISTORY_COLUMNS,"dictionaries":dictionaries,"anchorEncoding":"ROW_INDEX_V1","rowCount":rows.len(),"interpretation":HISTORY_DICTIONARY_GUIDE,"rows":encoded});
    if units(&table.to_string()) >= units(&value.to_string()) {
        return Ok(value.clone());
    }
    if expand_history(&table)? != *value {
        return Err("历史证据字典无法完整恢复，不提交模型".into());
    }
    Ok(table)
}

fn expand_history(value: &Value) -> Result<Value, String> {
    if value.get("format").and_then(Value::as_str) != Some(HISTORY_DICTIONARY_FORMAT) {
        return Ok(value.clone());
    }
    if value.as_object().is_none_or(|object| {
        object.keys().any(|key| {
            ![
                "format",
                "columns",
                "dictionaries",
                "anchorEncoding",
                "rowCount",
                "interpretation",
                "rows",
            ]
            .contains(&key.as_str())
        })
    }) || value["columns"] != json!(HISTORY_COLUMNS)
        || value["anchorEncoding"] != "ROW_INDEX_V1"
        || value["interpretation"] != HISTORY_DICTIONARY_GUIDE
    {
        return Err("历史证据字典声明不合法".into());
    }
    let rows = value["rows"].as_array().ok_or("历史证据字典缺rows")?;
    if value["rowCount"].as_u64() != Some(rows.len() as u64) {
        return Err("历史证据字典行数不一致".into());
    }
    let dictionaries = value["dictionaries"]
        .as_object()
        .ok_or("历史证据字典缺值表")?;
    if dictionaries
        .iter()
        .any(|(key, values)| !HISTORY_COLUMNS[1..=5].contains(&key.as_str()) || !values.is_array())
    {
        return Err("历史证据字典含未知列".into());
    }
    let ids = rows
        .iter()
        .map(|row| {
            row.as_array()
                .filter(|fields| fields.len() == 7)
                .and_then(|fields| fields[0].as_str())
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .ok_or("历史证据字典来源行不合法")
        })
        .collect::<Result<Vec<_>, _>>()?;
    if ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err("历史证据字典来源行重复".into());
    }
    let mut expanded = rows.clone();
    for row in &mut expanded {
        for column in 1..=5 {
            if let Some(dictionary) = dictionaries.get(HISTORY_COLUMNS[column]) {
                let index = row[column].as_u64().ok_or("历史证据字典索引不合法")? as usize;
                row[column] = dictionary
                    .as_array()
                    .unwrap()
                    .get(index)
                    .cloned()
                    .ok_or("历史证据字典索引越界")?;
            }
        }
        let anchors = row[6]
            .as_array()
            .ok_or("历史证据字典缺邻句来源")?
            .iter()
            .map(|anchor| {
                anchor
                    .as_u64()
                    .and_then(|index| ids.get(index as usize))
                    .cloned()
                    .ok_or("历史证据字典邻句索引越界")
            })
            .collect::<Result<Vec<_>, _>>()?;
        row[6] = json!(anchors);
    }
    Ok(json!(expanded))
}

fn capacity_input(stage: &str, mut input: Value, schema: &Value) -> Result<Value, String> {
    // Apply model-only factoring only when the original request is too large.
    // Previously accepted small request bytes and their cache identity are stable.
    if input["modelInputProfile"]==super::foundation_wire::PROFILE || !fits(stage, &input, schema)? {
        if let Some(history) = input.pointer("/evidence/historicalEvidenceCandidates") {
            input["evidence"]["historicalEvidenceCandidates"] = compact_history(history)?;
        }
    }
    Ok(input)
}

fn prepare_capacity_batch(
    stage: &str,
    source: &LockedSource,
    pending: &mut Vec<Batch>,
    foundation: &FoundationProposal,
    context: &Value,
    index: usize,
    signals: &[Value],
) -> Result<(Batch, Value), String> {
    if pending.is_empty() {
        return Err("容量规划没有待处理批次".into());
    }
    let batch = pending.remove(0);
    let schema = if stage == "F2" {
        f2_schema()
    } else {
        q1_schema()
    };
    let input = capacity_input(
        stage,
        input_for(
            stage,
            source,
            &batch,
            foundation,
            context,
            index,
            index + pending.len() + 1,
            stage == "Q1" && pending.is_empty(),
            signals,
        ),
        &schema,
    )?;
    if fits(stage, &input, &schema)? {
        return Ok((batch, input));
    }
    let overflow = || {
        if stage == "F2" {
            "F2完整请求超过200k应用预算；原文与已接受响应保留，未截断或提交"
        } else {
            "Q1完整请求超过200k应用预算；未截断资料或自动购买重试"
        }
        .to_owned()
    };
    if batch.fragment.is_some() || batch.scope.len() == 1 {
        return Err(overflow());
    }
    // Port foundation-request-plan.ts: exact projected request, largest fitting
    // ordered prefix, and one intact remainder. Never turn the tail into a queue
    // of singleton model calls. Long fragments remain indivisible boundaries.
    let mut lower = 1;
    let mut upper = batch.scope.len() - 1;
    let mut best = None;
    while lower <= upper {
        let count = (lower + upper) / 2;
        let prefix = Batch {
            scope: batch.scope[..count].to_vec(),
            pieces: whole_rows(source, &batch.scope[..count]),
            fragment: None,
        };
        let candidate = capacity_input(
            stage,
            input_for(
                stage,
                source,
                &prefix,
                foundation,
                context,
                index,
                index + pending.len() + 2,
                false,
                signals,
            ),
            &schema,
        )?;
        if fits(stage, &candidate, &schema)? {
            best = Some((count, prefix, candidate));
            lower = count + 1;
        } else {
            upper = count - 1;
        }
    }
    let Some((mut count, mut prefix, _)) = best else {
        return Err(overflow());
    };
    // If the final tail would contain just one short episode, move one episode
    // across the boundary when *both* requests fit. Keep order and call count.
    if pending.is_empty() && count>1 && batch.scope.len()-count==1 {
        let balanced=Batch{scope:batch.scope[..count-1].to_vec(),pieces:whole_rows(source,&batch.scope[..count-1]),fragment:None};
        let tail=Batch{scope:batch.scope[count-1..].to_vec(),pieces:whole_rows(source,&batch.scope[count-1..]),fragment:None};
        let left=capacity_input(stage,input_for(stage,source,&balanced,foundation,context,index,index+2,false,signals),&schema)?;
        let right=capacity_input(stage,input_for(stage,source,&tail,foundation,context,index+1,index+2,stage=="Q1",signals),&schema)?;
        if fits(stage,&left,&schema)?&&fits(stage,&right,&schema)? {count-=1;prefix=balanced;}
    }
    let mut remainder = Batch {
        scope: batch.scope[count..].to_vec(),
        pieces: whole_rows(source, &batch.scope[count..]),
        fragment: None,
    };
    if stage == "F2" {
        // The old delivery recalculates the next 24k source prefix from pending
        // episodes, so an overflow tail can share a batch with its next short
        // source block without crossing a fragment or reordering selection.
        while pending.first().is_some_and(|next| {
            next.fragment.is_none()
                && remainder
                    .pieces
                    .iter()
                    .chain(&next.pieces)
                    .map(|piece| units(&piece.text))
                    .sum::<usize>()
                    <= SOURCE_BUDGET
        }) {
            let next = pending.remove(0);
            remainder.scope.extend(next.scope);
            remainder.pieces.extend(next.pieces);
        }
    }
    pending.insert(0, remainder);
    let input = capacity_input(
        stage,
        input_for(
            stage,
            source,
            &prefix,
            foundation,
            context,
            index,
            index + pending.len() + 1,
            false,
            signals,
        ),
        &schema,
    )?;
    if !fits(stage, &input, &schema)? {
        return Err(overflow());
    }
    Ok((prefix, input))
}

fn editor_batches(batches: Vec<Batch>) -> Vec<Batch> {
    let mut editor: Vec<Batch> = vec![];
    for batch in batches {
        if batch.fragment.is_none() && editor.last().is_some_and(|prior| prior.fragment.is_none()) {
            let prior = editor.last_mut().unwrap();
            prior.scope.extend(batch.scope);
            prior.pieces.extend(batch.pieces);
        } else {
            editor.push(batch);
        }
    }
    editor
}

/// Read-only capacity planning. The compatibility q1MinimumCalls field is a
/// current-registry plan, not a mathematical minimum or generated-content proof.
/// Execution recomputes both stages with their actual registry/data.
pub fn preview_foundation_delivery(
    source: &LockedSource,
    context: &Value,
) -> Result<Value, String> {
    let source = upgrade_source_dialogues(source)?;
    validate_source(&source)?;
    if context
        .pointer("/selection/episodeIds")
        .is_some_and(|value| !value.is_array())
    {
        return Err("制作集选择必须是非空ID数组，不能静默扩大到全剧".into());
    }
    let selected: Vec<String> = context
        .pointer("/selection/episodeIds")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .ok_or("制作集ID无效".into())
                })
                .collect::<Result<_, String>>()
        })
        .transpose()?
        .unwrap_or_else(|| source.episodes.iter().map(|e| e.id.clone()).collect());
    if selected.is_empty()
        || selected.iter().collect::<HashSet<_>>().len() != selected.len()
        || selected
            .iter()
            .any(|id| !source.episodes.iter().any(|e| &e.id == id))
    {
        return Err("制作集规划范围无效".into());
    }
    let mut pending = plan_batches(&source, &selected)?;
    let foundation = existing_foundation(&source, context)?;
    let mut plans = vec![];
    let mut batches = vec![];
    while !pending.is_empty() {
        let (batch, input) = prepare_capacity_batch(
            "F2",
            &source,
            &mut pending,
            &foundation,
            context,
            plans.len(),
            &[],
        )?;
        let schema = f2_schema();
        let request_chars = request_chars("F2", &input, &schema)?;
        let wire_schema = crate::text_executor::structured_schema_for_budget(&schema);
        plans.push(json!({"stage":"F2","scope":batch.scope,"fragment":batch.fragment,"sourceChars":batch.pieces.iter().map(|p|units(&p.text)).sum::<usize>(),"inputChars":units(&input.to_string()),"schemaChars":units(&wire_schema.to_string()),"requestChars":request_chars,"withinBudget":request_chars+OUTPUT_RESERVE<=REQUEST_BUDGET,"historicalEncoding":input.pointer("/evidence/historicalEvidenceCandidates/format")}));
        batches.push(batch);
    }
    verify_coverage(&source, &selected, &batches)?;
    let mut q_pending = editor_batches(batches);
    let mut q1_groups = 0;
    while !q_pending.is_empty() {
        prepare_capacity_batch(
            "Q1",
            &source,
            &mut q_pending,
            &foundation,
            context,
            q1_groups,
            &[],
        )?;
        q1_groups += 1;
    }
    Ok(
        json!({"method":METHOD_VERSION,"sourceSha256":source.sha256,"sourceCoverageVerified":true,"selectedEpisodeIds":selected,"f1ModelCalls":0,"f2PlannedCalls":plans.len(),"q1MinimumCalls":q1_groups,"q1PlanBasis":"PRE_MODEL_CURRENT_REGISTRY","f2Batches":plans,"budgets":{"sourceChars":SOURCE_BUDGET,"fragmentChars":FRAGMENT_BUDGET,"completeRequestChars":REQUEST_BUDGET,"outputReserveChars":OUTPUT_RESERVE,"coordinateSystem":"UTF-16"},"note":"F2预览与执行共用完整请求预检和无损历史字典；当前registry随后增大仍可再拆批。q1MinimumCalls兼容字段是完整源和当前registry的容量计划数，非数学最少调用数；最终范围取决于F2实际目录/方向信号。本报告未执行模型。"}),
    )
}
pub(crate) fn allowed_refs(input: &Value) -> HashSet<String> {
    let mut ids = HashSet::new();
    for pointer in [
        "/source/rows",
        "/evidence/background",
        "/evidence/backgroundCandidates",
        "/evidence/historicalEvidenceCandidates",
    ] {
        let original = input.pointer(pointer).cloned().unwrap_or(json!([]));
        let expanded = expand_history(&original).unwrap_or(json!([]));
        for row in expanded.as_array().into_iter().flatten() {
            if let Some(id) = row.get(0).and_then(Value::as_str) {
                ids.insert(id.into());
            }
        }
    }
    ids
}

// One shared enum, rather than repeating hundreds of IDs in every field. These
// are genuine evidence/cut references; ordinary catalog entries have no refs.
fn delivery_schema(stage: &str, input: &Value) -> Value {
    fn constrain(value: &mut Value) {
        match value {
            Value::Object(map) => {
                if let Some(properties) = map.get_mut("properties").and_then(Value::as_object_mut) {
                    if let Some(refs) = properties.get_mut("sourceRefs") {
                        refs["items"] = json!({"$ref":"#/$defs/sourceRow"});
                    }
                    if let Some(row) = properties.get_mut("rowId") {
                        *row = json!({"$ref":"#/$defs/sourceRow"});
                    }
                }
                for value in map.values_mut() { constrain(value); }
            }
            Value::Array(values) => for value in values { constrain(value); },
            _ => {}
        }
    }
    let mut schema = if stage == "F2" { f2_schema() } else { q1_schema() };
    constrain(&mut schema);
    let prefix=format!("row:{}:", input["sourceSha256"].as_str().and_then(|s|s.get(..12)).unwrap_or(""));
    let ids: BTreeSet<_> = allowed_refs(input).into_iter().map(|id|id.strip_prefix(&prefix).map(|s|format!("r:{s}")).unwrap_or(id)).collect();
    schema["$defs"] = json!({"sourceRow":{"type":"string","enum":ids}});
    schema
}

fn restore_delivery_refs(value: &mut Value,input: &Value) -> Result<(),String> {
    let allowed=allowed_refs(input);
    let prefix=format!("row:{}:",input["sourceSha256"].as_str().and_then(|s|s.get(..12)).ok_or("缺锁定源版本")?);
    fn walk(value:&mut Value,allowed:&HashSet<String>,prefix:&str)->Result<(),String> {
        match value {
            Value::Object(map)=>{
                if let Some(refs)=map.get_mut("sourceRefs").and_then(Value::as_array_mut) {
                    for id in refs {
                        if let Some(suffix)=id.as_str().and_then(|s|s.strip_prefix("r:")) {
                            let canonical=format!("{prefix}{suffix}");
                            if !allowed.contains(&canonical) {return Err(format!("原文证据编号未在本次提供：{suffix}"));}
                            *id=json!(canonical);
                        }
                    }
                }
                if let Some(id)=map.get_mut("rowId") {
                    if let Some(suffix)=id.as_str().and_then(|s|s.strip_prefix("r:")) {
                        let canonical=format!("{prefix}{suffix}");
                        if !allowed.contains(&canonical) {return Err(format!("原文切点/证据编号未在本次提供：{suffix}"));}
                        *id=json!(canonical);
                    }
                }
                for v in map.values_mut(){walk(v,allowed,prefix)?;}
            }
            Value::Array(values)=>for v in values {walk(v,allowed,prefix)?;},
            _=>{}
        }
        Ok(())
    }
    walk(value,&allowed,&prefix)?;
    if let Some(signals)=value.pointer_mut("/seriesDirection/signals").and_then(Value::as_array_mut) {
        for signal in signals {
            if let Some(prior)=input.pointer("/seriesDirectionPreparation/priorSignals").and_then(Value::as_array).into_iter().flatten().find(|prior|prior["rowId"]==signal["rowId"]&&prior["episodeId"]==signal["episodeId"]) {
                signal["quote"]=prior["quote"].clone();
                continue;
            }
            let rows=input.pointer("/source/rows").and_then(Value::as_array).ok_or("方向依据缺本批原行")?;
            let row=rows.iter().find(|row|row[0]==signal["rowId"]&&row[2]==signal["episodeId"]).ok_or("方向依据行不属于本批所指集数")?;
            // A model judges the direction; it does not transcribe the source.
            // Materialize the exact provided locked row, including punctuation.
            signal["quote"]=json!(row[9].as_str().ok_or("方向原行必须为文本")?.trim_end_matches(['\r','\n']));
        }
    }
    Ok(())
}

/// Narrow migration for a *saved* rejected F2. Group IDs may be expanded only
/// into complete, contiguous, currently provided rows of one episode/scene.
/// Never round a substring, fill a gap, borrow unprovided history, or guess text.
pub(crate) fn normalize_legacy_catalogue(value: &mut Value, input: &Value) -> Result<(), String> {
    let allowed = allowed_refs(input);
    let prefix = format!("row:{}:", input["sourceSha256"].as_str().and_then(|s|s.get(..12)).ok_or("旧目录缺锁定源版本")?);
    let parsed = |id: &str| -> Option<(usize,usize)> {
        let suffix = id.strip_prefix(&prefix)?;
        let (start,end) = suffix.split_once(':')?;
        Some((start.parse().ok()?,end.parse().ok()?))
    };
    let mut rows: Vec<_> = allowed.iter().filter_map(|id| parsed(id).map(|(s,e)|(s,e,id.clone()))).collect();
    rows.sort_by_key(|r|r.0);
    let owner = |id: &str| -> (Value,Value) {
        for pointer in ["/source/rows","/evidence/historicalEvidenceCandidates"] {
            let table = expand_history(input.pointer(pointer).unwrap_or(&Value::Null)).unwrap_or(json!([]));
            if let Some(row) = table.as_array().into_iter().flatten().find(|r|r[0].as_str()==Some(id)) {
                return if pointer=="/source/rows" {(row[2].clone(),row[3].clone())} else {(row[1].clone(),row[2].clone())};
            }
        }
        (Value::Null,Value::Null)
    };
    let expand = |id: &str| -> Result<Vec<String>,String> {
        if allowed.contains(id) { return Ok(vec![id.into()]); }
        let (start,end) = parsed(id).filter(|(s,e)|s<e).ok_or_else(||format!("旧目录引用不是本次完整原行：{id}"))?;
        let selected: Vec<_> = rows.iter().filter(|r|r.0>=start&&r.1<=end).collect();
        if selected.len()<2 || selected.first().is_none_or(|r|r.0!=start)
            || selected.last().is_none_or(|r|r.1!=end)
            || selected.windows(2).any(|r|r[0].1!=r[1].0)
            || selected.iter().any(|r|owner(&r.2)!=owner(&selected[0].2)) {
            return Err(format!("旧目录引用缺行、越界或跨集场，不能自动恢复：{id}"));
        }
        Ok(selected.into_iter().map(|r|r.2.clone()).collect())
    };
    fn walk(value: &mut Value, expand: &impl Fn(&str)->Result<Vec<String>,String>) -> Result<(),String> {
        match value {
            Value::Object(map) => {
                if let Some(refs) = map.get_mut("sourceRefs") {
                    let raw:Vec<String> = serde_json::from_value(refs.clone()).map_err(|_|"旧目录引用须为文本数组")?;
                    let mut restored=vec![];
                    for id in raw { restored.extend(expand(&id)?); }
                    if restored.iter().collect::<HashSet<_>>().len()!=restored.len() {
                        return Err("旧目录展开后原文引用重复".into());
                    }
                    *refs=json!(restored);
                }
                if let Some(refs) = map.get_mut("evidenceRefs").and_then(Value::as_array_mut) {
                    let mut restored=vec![];
                    for raw in std::mem::take(refs) {
                        let id=raw["rowId"].as_str().ok_or("旧目录证据对象缺rowId")?;
                        for id in expand(id)? {
                            let mut item=raw.clone(); item["rowId"]=json!(id); restored.push(item);
                        }
                    }
                    *refs=restored;
                }
                for v in map.values_mut() { walk(v,expand)?; }
            }
            Value::Array(values) => for v in values { walk(v,expand)?; },
            _=>{}
        }
        Ok(())
    }
    let mut candidate=value.clone();
    walk(&mut candidate,&expand)?;
    *value=candidate;
    Ok(())
}

// Attach scope anchors, not visual claims. Models still decide actual usage.
// An empty usage remains an unlocated catalog candidate; no implicit appearance.
fn bind_catalogue_scope(
    source: &LockedSource, batch: &Batch, allowed: &HashSet<String>,
    supplied: Option<&Vec<String>>, episodes: Option<&Vec<String>>, pairs: Option<&Vec<Vec<String>>>,
) -> Result<Vec<String>,String> {
    let mut refs=supplied.cloned().unwrap_or_default();
    if supplied.is_some() { provided_refs(&refs,allowed)?; }
    if supplied.is_some() && pairs.is_some_and(|p|!p.is_empty()) && !refs.iter().any(|id|batch.row_ids().contains(id.as_str())) {
        return Err("实际本场使用不能仅用前批引用补足；范围由本次原文绑定".into());
    }
    let places=places(source,batch,&refs,episodes,pairs)?;
    for place in &places {
        let row=source.rows.iter().find(|r|r.episode_id.as_ref()==Some(&place.episode_id)&&r.scene_id.as_ref()==Some(&place.scene_id)&&batch.row_ids().contains(r.id.as_str())).ok_or("本批没有实际提供该场原文")?;
        if !refs.contains(&row.id) { refs.push(row.id.clone()); }
    }
    if places.is_empty() {
        for episode in episodes.into_iter().flatten() {
            let row=source.rows.iter().find(|r|r.episode_id.as_ref()==Some(episode)&&batch.row_ids().contains(r.id.as_str())).ok_or("本批没有实际提供该集原文")?;
            if !refs.contains(&row.id) { refs.push(row.id.clone()); }
        }
    }
    Ok(refs)
}

fn mark_scope(metadata: &mut Map<String,Value>, source: &LockedSource) {
    metadata.insert("sourceRefsPurpose".into(),json!("SOURCE_SCOPE"));
    metadata.insert("sourceScope".into(),json!({"sourceSha256":source.sha256,"kind":"PROGRAM_SCOPE"}));
}

fn bind_explicit_global_context(source: &LockedSource, allowed: &HashSet<String>, scope: Option<&WireScope>, refs: &mut Vec<String>) {
    // Only an explicit GLOBAL declaration receives actually supplied author
    // context. Empty/unlocated candidates and one-off dialogue stay unlocated.
    if scope.is_some_and(|scope| scope.kind == "GLOBAL") {
        for row in source.rows.iter().filter(|row| row.kind == "context" && row.dialogue.is_none() && allowed.contains(&row.id)
            && ["规则：", "规则:", "世界规则：", "世界观规则：", "世界观设定：", "世界设定："].iter().any(|prefix|row.text.trim_start().starts_with(prefix))) {
            if !refs.contains(&row.id) { refs.push(row.id.clone()); }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preparation {
    mode: String,
    #[serde(default)]
    from_key: Option<String>,
    #[serde(default)]
    note: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireScope {
    kind: String,
    #[serde(default)]
    reason: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VariantWire {
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    episodes: Option<Vec<String>>,
    #[serde(default)]
    scene_refs: Option<Vec<Vec<String>>>,
    #[serde(default)]
    source_refs: Option<Vec<String>>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    preparation: Option<Preparation>,
    #[serde(default)]
    scope: Option<WireScope>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssetWire {
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    aliases: Option<Vec<String>>,
    #[serde(default)]
    episodes: Option<Vec<String>>,
    #[serde(default)]
    scene_refs: Option<Vec<Vec<String>>>,
    #[serde(default)]
    source_refs: Option<Vec<String>>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    relation_note: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    preparation: Option<Preparation>,
    #[serde(default)]
    variants: Option<Vec<VariantWire>>,
    #[serde(default)]
    scope: Option<WireScope>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogueWire {
    format: String,
    source_sha256: String,
    coverage: Vec<String>,
    assets: Vec<AssetWire>,
    #[serde(default)]
    issues: Vec<FoundationIssue>,
    #[serde(default)]
    human_choices: Vec<Value>,
    #[serde(default)]
    unresolved: Vec<Value>,
    #[serde(default)]
    notes: Vec<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EpisodePatch {
    episode_id: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    source_refs: Vec<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MergePatch {
    from_key: String,
    into_key: String,
    source_refs: Vec<String>,
    reason: String,
}
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Changes {
    #[serde(default)]
    assets: Vec<AssetWire>,
    #[serde(default)]
    remove_asset_keys: Vec<String>,
    #[serde(default)]
    merge_assets: Vec<MergePatch>,
    #[serde(default)]
    episodes: Vec<EpisodePatch>,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    scenes: Vec<Value>,
    #[serde(default)]
    scene_splits: Vec<Value>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OptimizationWire {
    format: String,
    source_sha256: String,
    coverage: Vec<String>,
    changes: Changes,
    #[serde(default)]
    issues: Vec<FoundationIssue>,
    #[serde(default)]
    resolved_issues: Vec<String>,
    #[serde(default)]
    series_direction: Option<Value>,
    #[serde(default)]
    human_choices: Vec<Value>,
    #[serde(default)]
    unresolved: Vec<Value>,
    #[serde(default)]
    notes: Vec<String>,
}

fn supplemental_issues(
    choices: &[Value],
    pending: &[Value],
    notes: &[String],
    batch: &Batch,
    allowed: &HashSet<String>,
) -> Result<Vec<FoundationIssue>, String> {
    let mut result = vec![];
    for choice in choices {
        let map = choice.as_object().ok_or("必要制作取舍须为对象")?;
        for field in [
            "decisionKey",
            "kind",
            "question",
            "reason",
            "recommended",
            "recommendationReason",
            "evidence",
        ] {
            if map
                .get(field)
                .and_then(Value::as_str)
                .is_none_or(|s| s.trim().is_empty())
            {
                return Err(format!("制作取舍缺少 {field}"));
            }
        }
        let kind = choice["kind"].as_str().unwrap();
        if !["SOURCE_CONFLICT", "PRODUCTION_CHOICE"].contains(&kind) {
            return Err("技术错误不能包装成制作取舍".into());
        }
        let options: Vec<String> =
            serde_json::from_value(choice["options"].clone()).map_err(|_| "制作取舍选项无效")?;
        if !(2..=3).contains(&options.len())
            || options.iter().collect::<HashSet<_>>().len() != options.len()
            || !options
                .iter()
                .any(|option| Some(option.as_str()) == choice["recommended"].as_str())
        {
            return Err("制作取舍须有2–3个不同选项和其中一个推荐，推荐不是确认".into());
        }
        let refs: Vec<String> = serde_json::from_value(choice["sourceRefs"].clone())
            .map_err(|_| "制作取舍缺少锁定sourceRefs")?;
        provided_refs(&refs, allowed)?;
        let episodes: Vec<String> = serde_json::from_value(choice["episodes"].clone())
            .map_err(|_| "制作取舍影响范围无效")?;
        if episodes.iter().any(|id| !batch.scope.contains(id)) {
            return Err("制作取舍不得扩大当前授权范围".into());
        }
        let blocking = kind == "SOURCE_CONFLICT" && refs.len() >= 2;
        result.push(FoundationIssue{coordinate:format!("choice:{}",choice["decisionKey"].as_str().unwrap()),problem:choice["question"].as_str().unwrap().into(),source_refs:refs,blocking,asset_id:None,variant_id:None,episode_ids:if episodes.is_empty(){batch.scope.clone()}else{episodes},details:Some(json!({"owner":"AUTHOR","kind":"HUMAN_CHOICE","choice":choice,"recommendedIsAdopted":false}))});
    }
    for item in pending {
        let owner = item["owner"]
            .as_str()
            .filter(|owner| ["Q1", "PROGRAM", "STAGE2"].contains(owner))
            .ok_or("未决事项owner无效")?;
        let note = item["note"]
            .as_str()
            .filter(|note| !note.trim().is_empty())
            .ok_or("未决事项缺原因")?;
        let episodes: Vec<String> =
            serde_json::from_value(item["episodes"].clone()).map_err(|_| "未决事项范围无效")?;
        if episodes.iter().any(|id| !batch.scope.contains(id)) {
            return Err("未决事项越出本批范围".into());
        }
        let refs: Vec<String> =
            serde_json::from_value(item["sourceRefs"].clone()).map_err(|_| "未决事项来源无效")?;
        if !refs.is_empty() {
            provided_refs(&refs, allowed)?;
        }
        result.push(FoundationIssue {
            coordinate: format!("pending:{}", &digest(&item.to_string())[..20]),
            problem: note.into(),
            source_refs: refs.clone(),
            blocking: owner == "Q1" && !refs.is_empty(),
            asset_id: None,
            variant_id: None,
            episode_ids: if episodes.is_empty() {
                batch.scope.clone()
            } else {
                episodes
            },
            details: Some(json!({"owner":owner,"pending":item})),
        });
    }
    for note in notes {
        if !note.trim().is_empty() {
            result.push(FoundationIssue {
                coordinate: format!("note:{}", &digest(note)[..20]),
                problem: note.clone(),
                source_refs: vec![],
                blocking: false,
                asset_id: None,
                variant_id: None,
                episode_ids: batch.scope.clone(),
                details: Some(json!({"owner":"STAGE2","kind":"PRODUCTION_NOTE"})),
            });
        }
    }
    Ok(result)
}

fn check_envelope(
    format: &str,
    expected: &str,
    hash: &str,
    source: &LockedSource,
    coverage: &[String],
    batch: &Batch,
) -> Result<(), String> {
    if format != expected || hash != source.sha256 {
        return Err("资料交付格式或锁定源版本不一致".into());
    }
    if coverage.len() != batch.scope.len()
        || coverage.iter().collect::<HashSet<_>>().len() != coverage.len()
        || coverage.iter().any(|id| !batch.scope.contains(id))
    {
        return Err("资料批次coverage未精确覆盖本次提供范围".into());
    }
    Ok(())
}
fn provided_refs(refs: &[String], allowed: &HashSet<String>) -> Result<(), String> {
    if refs.is_empty() { return Err("原文证据为空；请引用本次提供的原行".into()); }
    let mut seen=HashSet::new();
    for id in refs {
        if !seen.insert(id) { return Err(format!("原文证据重复：{id}")); }
        if !allowed.contains(id) { return Err(format!("原文证据编号未在本次提供：{id}")); }
    }
    Ok(())
}
fn places(
    source: &LockedSource,
    batch: &Batch,
    _refs: &[String],
    episode_ids: Option<&Vec<String>>,
    pairs: Option<&Vec<Vec<String>>>,
) -> Result<Vec<Applicability>, String> {
    let mut result = vec![];
    for pair in pairs.into_iter().flatten() {
        if pair.len() != 2
            || !batch.scope.contains(&pair[0])
            || !source
                .scenes
                .iter()
                .any(|s| s.episode_id == pair[0] && s.id == pair[1])
            || !batch.pieces.iter().any(|piece|source.rows.iter().any(|r|r.id==piece.row_id&&r.episode_id.as_ref()==Some(&pair[0])&&r.scene_id.as_ref()==Some(&pair[1])))
        {
            return Err("形象本批适用场缺少本场锁定来源或越出提供范围".into());
        }
        let place = Applicability {
            episode_id: pair[0].clone(),
            scene_id: pair[1].clone(),
        };
        if result.contains(&place) {
            return Err("形象集场引用重复".into());
        }
        result.push(place);
    }
    if let Some(episodes) = episode_ids {
        if episodes.iter().collect::<HashSet<_>>().len() != episodes.len()
            || episodes.iter().any(|id| !batch.scope.contains(id))
            || result.iter().any(|p| !episodes.contains(&p.episode_id))
        {
            return Err("资产用途集号与本次场引用不一致".into());
        }
    }
    Ok(result)
}
fn scope_value(
    raw: Option<&WireScope>,
    places: Vec<Applicability>,
    refs: &[String],
    source: &LockedSource,
) -> Result<FoundationScope, String> {
    let kind = raw
        .map(|s| s.kind.as_str())
        .unwrap_or(if places.is_empty() {
            "UNRESOLVED"
        } else {
            "SCENES"
        });
    let reason = raw.and_then(|s| s.reason.clone());
    if kind == "GLOBAL"
        && (reason.as_ref().is_none_or(|r| r.trim().is_empty())
            || !places.is_empty()
            || !refs.iter().any(|id| {
                source
                    .rows
                    .iter()
                    .any(|r| &r.id == id && r.kind == "context" && r.dialogue.is_none())
            }))
    {
        return Err("GLOBAL必须有明确资料来源和原因，不能由一次出场推广".into());
    }
    if !["GLOBAL", "SCENES", "UNRESOLVED"].contains(&kind)
        || kind == "SCENES" && places.is_empty()
        || kind == "UNRESOLVED" && !places.is_empty()
    {
        return Err("形象范围声明不合法".into());
    }
    Ok(FoundationScope {
        kind: kind.into(),
        scenes: places,
        reason,
    })
}

fn scope_for_patch(raw: Option<&WireScope>, places: Vec<Applicability>, refs: &[String], source: &LockedSource, previous: Option<&FoundationVariant>, batch: &Batch, patch: bool) -> Result<FoundationScope,String> {
    // A scoped difference may remove this batch's use while retaining genuine
    // uses outside the batch. Validate the final range, not just its empty delta.
    if patch && places.is_empty() && raw.is_some_and(|scope|scope.kind=="SCENES")
        && previous.is_some_and(|v|v.scope.kind=="SCENES"&&v.scope.scenes.iter().any(|p|!batch.scope.contains(&p.episode_id))) {
        return Ok(FoundationScope{kind:"SCENES".into(),scenes:places,reason:raw.and_then(|s|s.reason.clone())});
    }
    scope_value(raw,places,refs,source)
}
fn metadata(
    preparation: Option<&Preparation>,
    role: Option<&String>,
    relation: Option<&String>,
    note: Option<&String>,
) -> Result<Map<String, Value>, String> {
    let mut result = Map::new();
    if let Some(p) = preparation {
        if !["REFERENCE", "DERIVE", "INLINE", "AUDIO", "UNRESOLVED"].contains(&p.mode.as_str())
            || !["DERIVE", "INLINE"].contains(&p.mode.as_str()) && p.from_key.is_some()
        {
            return Err("素材制作方式或派生来源字段不合法；剧情关联不是素材来源".into());
        }
        let mut value = json!({"mode":p.mode});
        if let Some(key) = &p.from_key {
            value["fromKey"] = json!(key);
        }
        if let Some(note) = &p.note {
            value["note"] = json!(note);
        }
        result.insert("preparation".into(), value);
    }
    if let Some(role) = role {
        if !role.is_empty()
            && !["男主", "女主", "主角", "配角", "反派", "路人"].contains(&role.as_str())
        {
            return Err("人物定位字段不受支持".into());
        }
        result.insert("role".into(), json!(role));
    }
    if let Some(relation) = relation {
        result.insert("relationNote".into(), json!(relation));
    }
    if let Some(note) = note {
        result.insert("note".into(), json!(note));
    }
    Ok(result)
}
fn base_id(asset: &FoundationAsset) -> Result<String, String> {
    asset
        .variants
        .iter()
        .find(|v| v.metadata.get("isBase") == Some(&json!(true)))
        .or_else(|| asset.variants.first())
        .map(|v| v.id.clone())
        .ok_or("已登记身份缺少基础形象".into())
}
fn update_usage(
    metadata: &mut Map<String, Value>,
    incoming: &[String],
    batch: &Batch,
    patch: bool,
) {
    let mut usage: Vec<String> = metadata
        .get("usageEpisodes")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if patch && batch.fragment.is_none() {
        usage.retain(|id| !batch.scope.contains(id));
    }
    for id in incoming {
        if !usage.contains(id) {
            usage.push(id.clone());
        }
    }
    metadata.insert("usageEpisodes".into(), json!(usage));
}
fn source_parent(
    preparation: Option<&Preparation>,
    owner: &str,
    own_id: &str,
    assets: &[FoundationAsset],
    default_parent: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(p) = preparation else {
        return Ok(default_parent.map(str::to_string));
    };
    if !["DERIVE", "INLINE"].contains(&p.mode.as_str()) {
        return Ok(None);
    }
    if p.mode == "INLINE" && p.from_key.is_none() && default_parent.is_none() {
        // A standalone inline item has no proved carrying image. Binding must
        // keep it unresolved; the program cannot guess a scene/character image.
        return Ok(None);
    }
    let requested = p
        .from_key
        .as_deref()
        .or(default_parent)
        .ok_or("派生素材缺少真实来源身份/形象键")?;
    let parent = if let Some(asset) = assets.iter().find(|a| a.id == requested) {
        base_id(asset)?
    } else {
        resolve_foundation_variant(assets, owner, requested)?
            .1
            .id
            .clone()
    };
    if parent == own_id {
        return Err("派生素材不能引用自身".into());
    }
    Ok(Some(parent))
}
fn build_asset(
    source: &LockedSource,
    batch: &Batch,
    wire: &AssetWire,
    prior: &FoundationProposal,
    allowed: &HashSet<String>,
    patch: bool,
    new_ordinal: usize,
) -> Result<FoundationAsset, String> {
    let old = wire
        .key
        .as_ref()
        .and_then(|id| prior.assets.iter().find(|a| &a.id == id));
    if wire.key.is_some() && old.is_none() {
        return Err("未知资产key不可由模型猜测；新对象须省略key由程序编号".into());
    }
    let scope_episodes = wire.episodes.clone().or_else(||old.and_then(|a|a.metadata.get("usageEpisodes")).and_then(Value::as_array).map(|v|v.iter().filter_map(Value::as_str).filter(|e|batch.scope.iter().any(|id|id==e)).map(str::to_string).collect()));
    let mut refs_value = bind_catalogue_scope(source,batch,allowed,wire.source_refs.as_ref(),scope_episodes.as_ref(),wire.scene_refs.as_ref())?;
    bind_explicit_global_context(source,allowed,wire.scope.as_ref(),&mut refs_value);
    let refs=&refs_value;
    let catalog_name = wire
        .name
        .clone()
        .or_else(|| {
            old.map(|a| {
                a.metadata
                    .get("catalogName")
                    .and_then(Value::as_str)
                    .unwrap_or(&a.name)
                    .to_string()
            })
        })
        .filter(|s| !s.trim().is_empty())
        .ok_or("新资产缺少基础名称")?;
    let kind = wire
        .kind
        .clone()
        .or_else(|| old.map(|a| a.kind.clone()))
        .filter(|k| ["CH", "GROUP", "BEAST", "LOC", "PROP"].contains(&k.as_str()))
        .ok_or("新资产分类无效")?;
    // Keep the old display contract while separating canonical identity and its
    // baseline appearance. Neither half becomes a lookup key.
    let (name, baseline_name) = if kind == "CH" {
        catalog_name
            .split_once(['|', '｜'])
            .map(|(identity, look)| (identity.trim().to_string(), look.trim().to_string()))
            .unwrap_or((catalog_name.clone(), "默认".into()))
    } else {
        (catalog_name.clone(), catalog_name.clone())
    };
    if name.is_empty() || baseline_name.is_empty() {
        return Err("人物身份或基础服装名称为空".into());
    }
    if !patch && old.is_some_and(|a| a.name != name || a.kind != kind) {
        return Err("资产身份key不能通过本批显示名或分类修改替换；请明确身份修复".into());
    }
    if old.is_some_and(|a| {
        a.kind == "CH"
            && kind == "CH"
            && wire.name.is_some()
            && a.variants.first().is_some_and(|v| v.name != baseline_name)
    }) {
        return Err("已登记人物基线服装不能由主资产名称重写；有据换装应声明子形象".into());
    }
    let id = old.map(|a| a.id.clone()).unwrap_or_else(|| {
        let identity = if wire.source_refs.is_some() {
            // Preserve the exact identity of already saved evidence-inventory
            // requests, so their subsequent frozen editor can be replayed.
            json!([source.sha256, kind, catalog_name, refs.first()])
        } else {
            // Scope anchors and display names are not unique identity keys.
            json!([source.sha256, kind, catalog_name, batch.key(), new_ordinal])
        };
        format!(
            "{}_{}",
            kind,
            &digest(&identity.to_string())[..16]
        )
    });
    let bid = if let Some(old) = old {
        base_id(old)?
    } else {
        format!("{id}:base")
    };
    let mut asset = old.cloned().unwrap_or(FoundationAsset {
        id: id.clone(),
        name: name.clone(),
        kind: kind.clone(),
        aliases: vec![],
        description: String::new(),
        source_refs: vec![],
        variants: vec![],
        metadata: Map::new(),
    });
    if patch {
        if asset.name != name && !asset.aliases.contains(&asset.name) {
            asset.aliases.push(asset.name.clone());
        }
        asset.name = name.clone();
        asset.kind = kind.clone();
        if kind != "CH" {
            asset.metadata.remove("role");
        }
    }
    if let Some(aliases) = &wire.aliases {
        if patch {
            asset.aliases = aliases.clone();
        } else {
            for alias in aliases {
                if !asset.aliases.contains(alias) {
                    asset.aliases.push(alias.clone());
                }
            }
        }
    }
    if let Some(description) = &wire.description {
        asset.description = description.clone();
    }
    for reference in refs {
        if !asset.source_refs.contains(reference) {
            asset.source_refs.push(reference.clone());
        }
    }
    asset.metadata.extend(metadata(
        wire.preparation.as_ref(),
        wire.role.as_ref(),
        wire.relation_note.as_ref(),
        None,
    )?);
    mark_scope(&mut asset.metadata,source);
    asset
        .metadata
        .insert("catalogName".into(), json!(catalog_name));
    if let Some(episodes) = &wire.episodes {
        update_usage(&mut asset.metadata, episodes, batch, patch);
    }
    if wire.role.is_some() && kind != "CH" {
        return Err("角色定位只属于基础人物，不广播至群像或异兽".into());
    }
    let base_changed = old.is_none()
        || wire.scene_refs.is_some()
        || wire.episodes.is_some()
        || wire.preparation.is_some()
        || wire.scope.is_some();
    if base_changed {
        let previous = asset.variants.iter().find(|v| v.id == bid).cloned();
        let place = if wire.scene_refs.is_some() {
            places(
                source,
                batch,
                refs,
                wire.episodes.as_ref(),
                wire.scene_refs.as_ref(),
            )?
        } else {
            vec![]
        };
        let scope = if wire.scene_refs.is_some() || wire.scope.is_some() || old.is_none() {
            scope_for_patch(wire.scope.as_ref(), place, refs, source, previous.as_ref(), batch, patch)?
        } else {
            previous
                .as_ref()
                .map(|v| v.scope.clone())
                .unwrap_or_default()
        };
        let mut base = previous.unwrap_or(FoundationVariant {
            id: bid.clone(),
            name: baseline_name,
            description: String::new(),
            source_variant_id: None,
            source_refs: vec![],
            applicability: vec![],
            scope: FoundationScope::default(),
            asset_row_id: None,
            metadata: Map::new(),
        });
        if patch && batch.fragment.is_none() && wire.scene_refs.is_some() {
            base.scope
                .scenes
                .retain(|p| !batch.scope.contains(&p.episode_id));
        }
        if scope.kind == "GLOBAL" {
            base.scope = scope;
        } else {
            for p in scope.scenes {
                if !base.scope.scenes.contains(&p) {
                    base.scope.scenes.push(p);
                }
            }
            base.scope.kind = if base.scope.scenes.is_empty() {
                "UNRESOLVED"
            } else {
                "SCENES"
            }
            .into();
        }
        base.applicability = base.scope.scenes.clone();
        for r in refs {
            if !base.source_refs.contains(r) {
                base.source_refs.push(r.clone());
            }
        }
        base.source_variant_id = source_parent(
            wire.preparation.as_ref(),
            &id,
            &bid,
            &prior.assets,
            base.source_variant_id.as_deref(),
        )?;
        base.metadata
            .extend(metadata(wire.preparation.as_ref(), None, None, None)?);
        base.metadata.insert("isBase".into(), json!(true));
        mark_scope(&mut base.metadata,source);
        if let Some(usage) = asset.metadata.get("usageEpisodes") {
            base.metadata.insert("usageEpisodes".into(), usage.clone());
        }
        if let Some(at) = asset.variants.iter().position(|v| v.id == bid) {
            asset.variants[at] = base;
        } else {
            asset.variants.insert(0, base);
        }
    }
    if let Some(variants) = &wire.variants {
        let mut seen = HashSet::new();
        for v in variants {
            let existing = v
                .key
                .as_ref()
                .and_then(|key| asset.variants.iter().find(|v| &v.id == key));
            if v.key.is_some() && existing.is_none() {
                return Err("未知形象key不可猜测，新形象须省略key".into());
            }
            let name = v
                .name
                .clone()
                .or_else(|| existing.map(|v| v.name.clone()))
                .filter(|s| !s.trim().is_empty())
                .ok_or("形象名称缺失")?;
            let vid = existing
                .map(|v| v.id.clone())
                .unwrap_or_else(|| format!("{id}_V_{}", &digest(&name)[..16]));
            if !seen.insert(vid.clone()) || (vid == bid && !patch) {
                return Err("子形象重复或再次声明基础形象".into());
            }
            if vid == bid && name != existing.unwrap().name {
                return Err("基础形象身份不能在形象差异中隐式改名".into());
            }
            let scope_episodes=v.episodes.clone().or_else(||existing.and_then(|v|v.metadata.get("usageEpisodes")).and_then(Value::as_array).map(|v|v.iter().filter_map(Value::as_str).filter(|e|batch.scope.iter().any(|id|id==e)).map(str::to_string).collect()));
            let mut refs_value=bind_catalogue_scope(source,batch,allowed,v.source_refs.as_ref(),scope_episodes.as_ref(),v.scene_refs.as_ref())?;
            bind_explicit_global_context(source,allowed,v.scope.as_ref(),&mut refs_value);
            let refs=&refs_value;
            let mut variant = existing.cloned().unwrap_or(FoundationVariant {
                id: vid.clone(),
                name: name.clone(),
                description: String::new(),
                source_variant_id: Some(bid.clone()),
                source_refs: vec![],
                applicability: vec![],
                scope: FoundationScope::default(),
                asset_row_id: None,
                metadata: Map::new(),
            });
            if v.scene_refs.is_some() || existing.is_none() {
                let current = scope_for_patch(
                    v.scope.as_ref(),
                    places(
                        source,
                        batch,
                        refs,
                        v.episodes.as_ref(),
                        v.scene_refs.as_ref(),
                    )?,
                    refs,
                    source,
                    existing,
                    batch,
                    patch,
                )?;
                if patch && batch.fragment.is_none() {
                    variant
                        .scope
                        .scenes
                        .retain(|p| !batch.scope.contains(&p.episode_id));
                }
                if current.kind == "GLOBAL" {
                    variant.scope = current;
                } else {
                    for p in current.scenes {
                        if !variant.scope.scenes.contains(&p) {
                            variant.scope.scenes.push(p);
                        }
                    }
                    variant.scope.kind = if variant.scope.scenes.is_empty() {
                        "UNRESOLVED"
                    } else {
                        "SCENES"
                    }
                    .into();
                }
            }
            for r in refs {
                if !variant.source_refs.contains(r) {
                    variant.source_refs.push(r.clone());
                }
            }
            variant.applicability = variant.scope.scenes.clone();
            let mut all = prior.assets.clone();
            if let Some(at) = all.iter().position(|a| a.id == id) {
                all[at] = asset.clone();
            } else {
                all.push(asset.clone());
            }
            variant.source_variant_id = source_parent(
                v.preparation.as_ref(),
                &id,
                &vid,
                &all,
                variant.source_variant_id.as_deref(),
            )?;
            variant.metadata.extend(metadata(
                v.preparation.as_ref(),
                None,
                None,
                v.note.as_ref(),
            )?);
            mark_scope(&mut variant.metadata,source);
            if let Some(episodes) = &v.episodes {
                update_usage(&mut variant.metadata, episodes, batch, patch);
            }
            if existing.is_none() && v.preparation.is_none() {
                variant
                    .metadata
                    .insert("preparation".into(), json!({"mode":"DERIVE","fromKey":id}));
            }
            if let Some(note) = &v.note {
                variant.description = note.clone();
            }
            if let Some(at) = asset.variants.iter().position(|v| v.id == vid) {
                asset.variants[at] = variant;
            } else {
                asset.variants.push(variant);
            }
        }
        // A supplied child set replaces only this batch's child usage. Omitted
        // children remain canonical records and retain every batch-external use.
        // A long fragment cannot clear usage belonging to an unread sibling slice.
        if patch && batch.fragment.is_none() && variants.iter().any(|v|v.key.is_none()) {
            for variant in asset
                .variants
                .iter_mut()
                .filter(|v| v.id != bid && !seen.contains(&v.id))
            {
                variant
                    .scope
                    .scenes
                    .retain(|s| !batch.scope.contains(&s.episode_id));
                variant.applicability = variant.scope.scenes.clone();
                if variant.scope.scenes.is_empty() && variant.scope.kind == "SCENES" {
                    variant.scope.kind = "UNRESOLVED".into();
                }
            }
        }
    }
    Ok(asset)
}

fn check_issues(
    issues: &[FoundationIssue],
    batch: &Batch,
    allowed: &HashSet<String>,
) -> Result<(), String> {
    for issue in issues {
        if !issue.source_refs.is_empty() {
            provided_refs(&issue.source_refs, allowed)?;
        }
        if issue.episode_ids.iter().any(|id| !batch.scope.contains(id)) {
            return Err("局部事项越出实际提供范围".into());
        }
    }
    Ok(())
}

// F2 proposes production methods; it does not silently replace a registered
// material dependency. Keep its valid scope/evidence delta and give Q1 both
// alternatives through the existing issue channel instead of rejecting a batch.
fn retain_f2_preparation(
    asset: &mut FoundationAsset,
    prior: &FoundationProposal,
    source: &LockedSource,
    batch: &Batch,
) -> Result<Vec<FoundationIssue>, String> {
    let Some(old) = prior.assets.iter().find(|a| a.id == asset.id) else {
        return Ok(vec![]);
    };
    let old_base = base_id(old)?;
    let current_rows = batch.row_ids();
    let mut issues = vec![];
    for variant in &mut asset.variants {
        let Some(previous) = old.variants.iter().find(|v| v.id == variant.id) else {
            continue;
        };
        let old_preparation = previous.metadata.get("preparation");
        let proposed_preparation = variant.metadata.get("preparation").cloned();
        let old_mode = old_preparation.and_then(|p| p.get("mode"));
        let proposed_mode = proposed_preparation.as_ref().and_then(|p| p.get("mode"));
        if previous.source_variant_id == variant.source_variant_id && old_mode == proposed_mode {
            continue;
        }
        let previous_basis = json!({"preparation":old_preparation,"sourceVariantId":previous.source_variant_id});
        let proposed_basis = json!({"preparation":proposed_preparation,"sourceVariantId":variant.source_variant_id});
        let source_refs: Vec<String> = variant.source_refs.iter()
            .filter(|id| current_rows.contains(id.as_str())).cloned().collect();
        let current_scenes: Vec<_> = variant.scope.scenes.iter().filter(|place| source.rows.iter().any(|row|
            source_refs.contains(&row.id) && row.episode_id.as_ref() == Some(&place.episode_id)
                && row.scene_id.as_ref() == Some(&place.scene_id))).collect();
        issues.push(FoundationIssue {
            coordinate: format!("preparation:{}", &digest(&json!([batch.key(), asset.id, variant.id, previous_basis, proposed_basis]).to_string())[..20]),
            problem: format!("形象「{}｜{}」的制作来源建议与既有登记不同；已保留原登记，Q1可明确修订，或在resolvedIssues中确认沿用原登记。", asset.name, variant.name),
            source_refs,
            blocking: false,
            asset_id: Some(asset.id.clone()),
            variant_id: Some(variant.id.clone()),
            episode_ids: batch.scope.clone(),
            details: Some(json!({"owner":"Q1","kind":"PREPARATION_CONFLICT","method":METHOD_VERSION,
                "previous":previous_basis,"proposed":proposed_basis,"sourceRefsPurpose":"SOURCE_SCOPE",
                "currentSceneRefs":current_scenes,"previousSceneRefs":previous.scope.scenes,
                "proposedSceneRefs":variant.scope.scenes})),
        });
        variant.source_variant_id = previous.source_variant_id.clone();
        if let Some(preparation) = old_preparation {
            variant.metadata.insert("preparation".into(), preparation.clone());
        } else {
            variant.metadata.remove("preparation");
        }
        if variant.id == old_base {
            if let Some(preparation) = old.metadata.get("preparation") {
                asset.metadata.insert("preparation".into(), preparation.clone());
            } else {
                asset.metadata.remove("preparation");
            }
        }
    }
    Ok(issues)
}

fn retains_registered_preparation(issue: &FoundationIssue, foundation: &FoundationProposal) -> bool {
    let Some(details) = issue.details.as_ref() else { return false; };
    if issue.blocking || details["owner"] != "Q1" || details["kind"] != "PREPARATION_CONFLICT"
        || details["method"] != METHOD_VERSION {
        return false;
    }
    let Some(variant) = foundation.assets.iter()
        .find(|a| Some(&a.id) == issue.asset_id.as_ref())
        .and_then(|a| a.variants.iter().find(|v| Some(&v.id) == issue.variant_id.as_ref())) else {
        return false;
    };
    details["previous"] == json!({"preparation":variant.metadata.get("preparation"),"sourceVariantId":variant.source_variant_id})
}

fn apply_catalogue(
    value: &Value,
    source: &LockedSource,
    batch: &Batch,
    input: &Value,
    prior: &FoundationProposal,
    confirmed: Option<&str>,
    resolved: &HashSet<(String, String)>,
) -> Result<FoundationProposal, String> {
    let wire: CatalogueWire =
        serde_json::from_value(value.clone()).map_err(|e| format!("F2目录结构无效：{e}"))?;
    check_envelope(
        &wire.format,
        "ASSET_CATALOG_DESKTOP_V2",
        &wire.source_sha256,
        source,
        &wire.coverage,
        batch,
    )?;
    let allowed = allowed_refs(input);
    check_issues(&wire.issues, batch, &allowed)?;
    if wire.assets.iter().any(|asset| {
        asset.name.is_none()
            || asset.kind.is_none()
            || asset.episodes.is_none()
            || asset.scene_refs.is_none()
            || asset.preparation.is_none()
            || asset.variants.as_ref().is_some_and(|variants| {
                variants
                    .iter()
                    .any(|v| v.name.is_none() || v.episodes.is_none() || v.scene_refs.is_none())
            })
    }) {
        return Err("F2必要目录字段缺失；不以桌面默认值补造模型未交付内容".into());
    }
    let mut candidate = empty_foundation(source);
    let mut staged = prior.clone();
    let mut seen = HashSet::new();
    for (ordinal, wire) in wire.assets.iter().enumerate() {
        let asset = build_asset(source, batch, wire, &staged, &allowed, false, ordinal)?;
        if !seen.insert(asset.id.clone()) {
            return Err("本批资产身份重复".into());
        }
        if let Some(at) = staged.assets.iter().position(|a| a.id == asset.id) {
            staged.assets[at] = asset.clone();
        } else {
            staged.assets.push(asset.clone());
        }
        candidate.assets.push(asset);
    }
    // Validate the complete proposed graph BEFORE restoring old dependencies.
    // Unknown parents, self-links, cycles and invalid identities/scenes remain
    // hard errors even when some of the offending proposals target old keys.
    validate_foundation(source, &staged)?;
    candidate.issues = wire.issues;
    candidate.issues.extend(supplemental_issues(
        &wire.human_choices,
        &wire.unresolved,
        &wire.notes,
        batch,
        &allowed,
    )?);
    for asset in &mut candidate.assets {
        candidate.issues.extend(retain_f2_preparation(asset, prior, source, batch)?);
    }
    let mut next = prior.clone();
    // Reuse canonical identity/parent merge checks. Metadata is orthogonal to identity.
    merge_foundation(&mut next, candidate.clone(), confirmed, resolved)?;
    for asset in candidate.assets {
        if let Some(target) = next.assets.iter_mut().find(|a| a.id == asset.id) {
            target.metadata = asset.metadata;
            target.description = asset.description;
            for v in asset.variants {
                if let Some(prior) = target.variants.iter_mut().find(|p| p.id == v.id) {
                    prior.metadata = v.metadata;
                }
            }
        }
    }
    materialize_foundation(source, &mut next)?;
    validate_foundation(source, &next)?;
    Ok(next)
}
fn scene_todos(
    changes: &Changes,
    source: &LockedSource,
    batch: &Batch,
    allowed: &HashSet<String>,
) -> Result<Vec<FoundationIssue>, String> {
    let mut result = vec![];
    for (kind, list) in [
        ("sceneMetadata", &changes.scenes),
        ("sceneSplit", &changes.scene_splits),
    ] {
        for value in list {
            let raw = value.as_object().ok_or("场次程序计划须为对象")?;
            let episode = raw
                .get("episodeId")
                .and_then(Value::as_str)
                .ok_or("场次计划缺episodeId")?;
            let scene = raw
                .get("sceneId")
                .and_then(Value::as_str)
                .ok_or("场次计划缺sceneId")?;
            if !batch.scope.iter().any(|id| id == episode)
                || !source
                    .scenes
                    .iter()
                    .any(|s| s.id == scene && s.episode_id == episode)
            {
                return Err("场次程序计划越出来源范围".into());
            }
            let mut refs = vec![];
            if kind == "sceneMetadata" {
                if raw.keys().any(|key| {
                    ![
                        "episodeId",
                        "sceneId",
                        "sourceRefs",
                        "location",
                        "timeOfDay",
                        "interiorExterior",
                        "timeLayer",
                        "weather",
                        "characters",
                    ]
                    .contains(&key.as_str())
                }) {
                    return Err("场次元数据修改含未知字段".into());
                }
                refs = if let Some(raw_refs)=raw.get("sourceRefs") {
                    let refs:Vec<String>=serde_json::from_value(raw_refs.clone()).map_err(|_|"场修改来源结构无效")?;
                    provided_refs(&refs,allowed)?; refs
                } else {
                    source.rows.iter().filter(|r|r.scene_id.as_deref()==Some(scene)&&batch.row_ids().contains(r.id.as_str())).map(|r|r.id.clone()).collect()
                };
                if !refs.iter().any(|id| {
                    batch.row_ids().contains(id.as_str())
                        && source
                            .rows
                            .iter()
                            .any(|r| &r.id == id && r.scene_id.as_deref() == Some(scene))
                }) {
                    return Err("场次元数据修改缺少本场实际提供的来源".into());
                }
                for field in [
                    "location",
                    "timeOfDay",
                    "interiorExterior",
                    "timeLayer",
                    "weather",
                ] {
                    if raw.get(field).is_some_and(|value| !value.is_string()) {
                        return Err("场次元数据文本字段类型无效".into());
                    }
                }
                if raw.get("characters").is_some_and(|value| {
                    value
                        .as_array()
                        .is_none_or(|items| items.iter().any(|item| !item.is_string()))
                }) {
                    return Err("场次人物清单类型无效".into());
                }
                if raw
                    .keys()
                    .all(|key| ["episodeId", "sceneId", "sourceRefs"].contains(&key.as_str()))
                {
                    return Err("场次计划没有实际修改字段".into());
                }
            } else {
                if raw
                    .keys()
                    .any(|key| !["episodeId", "sceneId", "cuts"].contains(&key.as_str()))
                {
                    return Err("拆场计划含未知字段".into());
                }
                let cuts = raw
                    .get("cuts")
                    .and_then(Value::as_array)
                    .filter(|a| !a.is_empty())
                    .ok_or("拆场须有内部边界")?;
                let mut seen = HashSet::new();
                let mut last = 0;
                for cut in cuts {
                    if cut.as_object().is_none_or(|raw| {
                        raw.keys()
                            .any(|key| !["rowId", "anchor"].contains(&key.as_str()))
                    }) {
                        return Err("拆场切点包含未知字段".into());
                    }
                    let id = cut["rowId"].as_str().ok_or("拆场缺rowId")?;
                    let anchor = cut["anchor"].as_str().ok_or("拆场缺anchor")?;
                    let row = source
                        .rows
                        .iter()
                        .find(|r| r.id == id)
                        .ok_or("拆场源行不存在")?;
                    let first = source
                        .scenes
                        .iter()
                        .find(|s| s.id == scene)
                        .and_then(|s| s.row_ids.first());
                    if !batch.row_ids().contains(id)
                        || row.scene_id.as_deref() != Some(scene)
                        || first.map(String::as_str) == Some(id)
                        || row.text.trim_end_matches(['\r', '\n']) != anchor
                        || !seen.insert(id)
                        || row.range.start <= last
                    {
                        return Err("拆场锚点非内部有序逐字原文边界".into());
                    }
                    last = row.range.start;
                    refs.push(id.into());
                }
            }
            let mut plan=value.clone();
            if kind=="sceneMetadata" {plan["sourceRefs"]=json!(refs);}
            result.push(FoundationIssue {
                coordinate: format!("program:{kind}:{scene}"),
                problem: "已保存有据场次程序计划，尚未发布到锁定来源；由程序处理，不重试模型"
                    .into(),
                source_refs: refs,
                blocking: false,
                asset_id: None,
                variant_id: None,
                episode_ids: vec![episode.into()],
                details: Some(
                    json!({"owner":"PROGRAM","method":METHOD_VERSION,"planKind":kind,"plan":plan,"requiresProgramExecution":true}),
                ),
            });
        }
    }
    Ok(result)
}
fn apply_optimization(
    value: &Value,
    source: &LockedSource,
    batch: &Batch,
    input: &Value,
    prior: &FoundationProposal,
    confirmed: Option<&str>,
) -> Result<(FoundationProposal, Vec<Value>), String> {
    let wire: OptimizationWire =
        serde_json::from_value(value.clone()).map_err(|e| format!("Q1差异结构无效：{e}"))?;
    check_envelope(
        &wire.format,
        "ASSET_OPTIMIZATION_DESKTOP_V2",
        &wire.source_sha256,
        source,
        &wire.coverage,
        batch,
    )?;
    let allowed = allowed_refs(input);
    check_issues(&wire.issues, batch, &allowed)?;
    // Match the old editor: execute exact split declarations in memory before
    // validating metadata and asset usage of the resulting scene identities.
    // Publication remains a later, atomic program action.
    let split_changes = Changes { scene_splits: wire.changes.scene_splits.clone(), ..Changes::default() };
    let mut program_todos = scene_todos(&split_changes, source, batch, &allowed)?;
    let split_source = source_projection(source, &program_todos, &batch.scope)?;
    let metadata_changes = Changes { scenes: wire.changes.scenes.clone(), ..Changes::default() };
    program_todos.extend(scene_todos(&metadata_changes, &split_source, batch, &allowed)?);
    let projected_source = source_projection(source, &program_todos, &batch.scope)?;
    let source = &projected_source;
    let mut next = prior.clone();
    let mut seen = HashSet::new();
    for (ordinal, patch) in wire.changes.assets.iter().enumerate() {
        let asset = build_asset(source, batch, patch, &next, &allowed, true, ordinal)?;
        if !seen.insert(asset.id.clone()) {
            return Err("Q1重复修改同一身份".into());
        }
        if let Some(at) = next.assets.iter().position(|a| a.id == asset.id) {
            next.assets[at] = asset;
        } else {
            next.assets.push(asset);
        }
    }
    if batch.fragment.is_some()
        && (!wire.changes.remove_asset_keys.is_empty() || !wire.changes.merge_assets.is_empty())
    {
        return Err("长集分片不能删除或归并整集身份，应登记局部程序事项".into());
    }
    for key in &wire.changes.remove_asset_keys {
        let asset = next
            .assets
            .iter_mut()
            .find(|a| &a.id == key)
            .ok_or("Q1移出未知身份")?;
        for variant in &mut asset.variants {
            if variant.scope.kind == "GLOBAL" {
                return Err("局部移出不能删除GLOBAL身份的批外用途".into());
            }
            variant
                .scope
                .scenes
                .retain(|s| !batch.scope.contains(&s.episode_id));
            variant.applicability = variant.scope.scenes.clone();
            if variant.scope.scenes.is_empty() {
                variant.scope.kind = "UNRESOLVED".into();
            }
        }
        asset
            .metadata
            .insert("removedFromEpisodes".into(), json!(batch.scope));
    }
    for patch in &wire.changes.merge_assets {
        provided_refs(&patch.source_refs, &allowed)?;
        if patch.from_key == patch.into_key || patch.reason.trim().is_empty() {
            return Err("身份归并须明确不同键及有据原因".into());
        }
        let from = next
            .assets
            .iter()
            .find(|a| a.id == patch.from_key)
            .cloned()
            .ok_or("身份归并来源不存在")?;
        let into = next
            .assets
            .iter()
            .find(|a| a.id == patch.into_key)
            .cloned()
            .ok_or("身份归并目标不存在")?;
        if from.kind != into.kind
            || [&from, &into].iter().any(|a| {
                a.variants.iter().any(|v| {
                    v.scope.kind == "GLOBAL"
                        || v.scope
                            .scenes
                            .iter()
                            .any(|s| !batch.scope.contains(&s.episode_id))
                })
            })
        {
            return Err("本批身份归并影响批外范围或不同分类，必须留明确事项".into());
        }
        if next.assets.iter().flat_map(|a| &a.variants).any(|v| {
            v.source_variant_id
                .as_ref()
                .is_some_and(|id| from.variants.iter().any(|p| &p.id == id))
        }) {
            return Err("身份归并涉及已使用的素材父关系，须先明确重定位".into());
        }
        let target = next
            .assets
            .iter_mut()
            .find(|a| a.id == patch.into_key)
            .unwrap();
        for r in from.source_refs {
            if !target.source_refs.contains(&r) {
                target.source_refs.push(r);
            }
        }
        for v in from.variants {
            if target.variants.iter().any(|p| p.id == v.id) {
                return Err("归并形象键冲突".into());
            }
            target.variants.push(v);
        }
        if !target.aliases.contains(&from.name) {
            target.aliases.push(from.name);
        }
        for alias in from.aliases {
            if !target.aliases.contains(&alias) {
                target.aliases.push(alias);
            }
        }
        next.assets.retain(|a| a.id != patch.from_key);
        for fact in &mut next.facts {
            if fact.asset_id == patch.from_key {
                fact.asset_id = patch.into_key.clone();
            }
        }
        for issue in &mut next.issues {
            if issue.asset_id.as_deref() == Some(&patch.from_key) {
                issue.asset_id = Some(patch.into_key.clone());
            }
        }
    }
    for patch in &wire.changes.episodes {
        if !batch.scope.contains(&patch.episode_id) {
            return Err("分集导航修订越出提供范围".into());
        }
        let refs=if patch.source_refs.is_empty() {
            source.rows.iter().filter(|r|r.episode_id.as_ref()==Some(&patch.episode_id)&&batch.row_ids().contains(r.id.as_str())).map(|r|r.id.clone()).collect::<Vec<_>>()
        } else { patch.source_refs.clone() };
        provided_refs(&refs, &allowed)?;
        if refs.iter().any(|id| {
            source.rows.iter().any(|r| {
                &r.id == id
                    && r.episode_id
                        .as_ref()
                        .is_some_and(|owner| owner != &patch.episode_id)
            })
        }) {
            return Err("分集导航不能借另一集原文".into());
        }
        let episode = next
            .episodes
            .iter_mut()
            .find(|e| e.episode_id == patch.episode_id)
            .ok_or("所改分集导航未登记")?;
        if let Some(summary) = &patch.summary {
            episode.summary = summary.clone();
        }
        if let Some(context) = &patch.context {
            episode.context = context.clone();
        }
        episode.source_refs = refs;
    }
    if let Some(overview) = &wire.changes.overview {
        next.overview = overview.clone();
    }
    for coordinate in &wire.resolved_issues {
        let issue = next
            .issues
            .iter()
            .find(|i| &i.coordinate == coordinate)
            .ok_or("Q1回执未提供的事项")?;
        if issue
            .details
            .as_ref()
            .and_then(|d| d.get("owner"))
            .and_then(Value::as_str)
            == Some("PROGRAM")
            || issue.episode_ids.iter().any(|id| !batch.scope.contains(id))
            || wire.changes.assets.is_empty() && !retains_registered_preparation(issue, &next)
        {
            return Err("Q1不能仅回执关闭程序事项或未实改的事项".into());
        }
        next.issues.retain(|i| &i.coordinate != coordinate);
    }
    next.issues.extend(wire.issues);
    next.issues.extend(supplemental_issues(
        &wire.human_choices,
        &wire.unresolved,
        &wire.notes,
        batch,
        &allowed,
    )?);
    next.issues.extend(program_todos);
    let mut signals = vec![];
    if let Some(direction) = wire.series_direction {
        let raw = direction.as_object().ok_or("方向候选须为对象")?;
        if raw
            .keys()
            .any(|k| !["signals", "content"].contains(&k.as_str()))
        {
            return Err("方向候选含未知字段".into());
        }
        for signal in raw
            .get("signals")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let episode = signal["episodeId"].as_str().ok_or("方向依据缺episodeId")?;
            let id = signal["rowId"].as_str().ok_or("方向依据缺rowId")?;
            let quote = signal["quote"]
                .as_str()
                .filter(|q| !q.is_empty())
                .ok_or("方向依据缺逐字引文")?;
            if input.pointer("/seriesDirectionPreparation/mode").and_then(Value::as_str)==Some("FINAL")
                && input.pointer("/seriesDirectionPreparation/priorSignals").and_then(Value::as_array).into_iter().flatten().any(|prior|prior["rowId"]==*id&&prior["episodeId"]==*episode&&prior["quote"]==*quote) {
                // Previously verified evidence is already carried in the input.
                // Do not reject or re-add it just because FINAL cites the series.
                continue;
            }
            if !batch.scope.iter().any(|e| e == episode)
                || !batch
                    .pieces
                    .iter()
                    .any(|p| p.row_id == id && p.text.contains(quote))
                || !source
                    .rows
                    .iter()
                    .any(|r| r.id == id && r.episode_id.as_deref() == Some(episode))
            {
                return Err("方向依据不属于本次逐字原文".into());
            }
            if signal["reading"].as_str().is_none() {
                return Err("方向依据解释无效".into());
            }
            signals.push(signal.clone());
        }
        if let Some(content) = raw.get("content") {
            let content = content.as_str().ok_or("方向内容须为文本")?;
            if input
                .pointer("/seriesDirectionPreparation/mode")
                .and_then(Value::as_str)
                != Some("FINAL")
            {
                return Err("仅最后提供批次可汇总方向".into());
            }
            if units(content) > 600 {
                return Err("方向brief超过旧600字符上限".into());
            }
            if confirmed.is_none() {
                next.direction = content.into();
            }
        }
    }
    if let Some(confirmed) = confirmed {
        next.direction = confirmed.into();
    }
    materialize_foundation(source, &mut next)?;
    validate_foundation(source, &next)?;
    Ok((next, signals))
}

fn source_projection(source: &LockedSource, issues: &[FoundationIssue], selected: &[String]) -> Result<LockedSource, String> {
    let edits: Vec<_> = issues.iter().filter_map(|issue| {
        let details = issue.details.as_ref()?;
        (details["owner"] == "PROGRAM" && ["sceneMetadata", "sceneSplit"].contains(&details["planKind"].as_str().unwrap_or("")))
            .then(|| json!({"kind":details["planKind"],"sourceSha256":source.sha256,"plan":details["plan"]}))
    }).collect();
    if edits.is_empty() { return Ok(source.clone()); }
    super::scene_edits::preview_foundation_scene_edits(source, &edits, selected)
}

/// No F1 model call: the trusted source contract and explicit decisions already
/// establish source fidelity. F2 is packed across episodes; Q1 edits differences.
pub async fn run_foundation_delivery(
    source: &LockedSource,
    context: &Value,
    executor: &dyn TextExecutor,
    model: &str,
    reasoning: &str,
) -> Result<FoundationProposal, String> {
    let source = upgrade_source_dialogues(source)?;
    validate_source(&source)?;
    if context
        .pointer("/selection/episodeIds")
        .is_some_and(|value| !value.is_array())
    {
        return Err("制作集选择必须是非空ID数组，不能静默扩大到全剧".into());
    }
    let requested = context
        .pointer("/selection/episodeIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .map(|id| id.as_str().map(str::to_string).ok_or("制作集ID无效".into()))
                .collect::<Result<Vec<_>, String>>()
        })
        .transpose()?
        .unwrap_or_else(|| source.episodes.iter().map(|e| e.id.clone()).collect());
    if requested.is_empty()
        || requested.iter().collect::<HashSet<_>>().len() != requested.len()
        || requested
            .iter()
            .any(|id| !source.episodes.iter().any(|e| &e.id == id))
    {
        return Err("请选择当前来源内非空且不重复的制作集范围".into());
    }
    let selected: Vec<_> = source
        .episodes
        .iter()
        .filter(|e| requested.contains(&e.id))
        .map(|e| e.id.clone())
        .collect();
    if source.diagnostics.iter().any(|d| {
        d.blocking
            && (d.row_ids.is_empty()
                || d.row_ids.iter().any(|id| {
                    source
                        .rows
                        .iter()
                        .find(|r| &r.id == id)
                        .is_some_and(|r| r.episode_id.as_ref().is_none_or(|e| selected.contains(e)))
                }))
    }) {
        return Err("所选来源仍有集场/对白待确认；程序保真不能猜测".into());
    }
    let mut foundation = existing_foundation(&source, context)?;
    let resolved: HashSet<_> = foundation
        .assets
        .iter()
        .flat_map(|a| {
            a.variants
                .iter()
                .filter(|v| effective_scope(v).kind != "UNRESOLVED")
                .map(|v| (a.id.clone(), v.id.clone()))
        })
        .collect();
    let confirmed = context
        .pointer("/settings/confirmedDirection")
        .and_then(|v| {
            v.as_str()
                .or_else(|| v.get("content").and_then(Value::as_str))
        })
        .filter(|s| !s.trim().is_empty());
    foundation
        .episodes
        .retain(|e| !selected.contains(&e.episode_id));
    for asset in &mut foundation.assets {
        for v in &mut asset.variants {
            if v.scope.kind == "SCENES" {
                v.scope.scenes.retain(|s| !selected.contains(&s.episode_id));
                v.applicability = v.scope.scenes.clone();
                if v.scope.scenes.is_empty() {
                    v.scope.kind = "UNRESOLVED".into();
                }
            }
        }
    }
    foundation.facts.retain_mut(|f| {
        f.source_refs.retain(|id| {
            source
                .rows
                .iter()
                .find(|r| &r.id == id)
                .is_none_or(|r| r.episode_id.as_ref().is_none_or(|e| !selected.contains(e)))
        });
        !f.source_refs.is_empty()
    });
    foundation
        .issues
        .retain(|i| !i.episode_ids.iter().any(|e| selected.contains(e)));
    for episode in source.episodes.iter().filter(|e| selected.contains(&e.id)) {
        let row = source
            .rows
            .iter()
            .find(|r| r.episode_id.as_ref() == Some(&episode.id))
            .ok_or("制作集没有锁定原行")?;
        foundation.episodes.push(FoundationEpisode {
            episode_id: episode.id.clone(),
            summary: episode.title.clone(),
            context: String::new(),
            source_refs: vec![row.id.clone()],
        });
    }
    let mut pending = plan_batches(&source, &selected)?;
    let mut accepted_batches = vec![];
    let mut call_index = 0;
    while !pending.is_empty() {
        let (batch, input) = prepare_capacity_batch(
            "F2",
            &source,
            &mut pending,
            &foundation,
            context,
            call_index,
            &[],
        )?;
        let result = call_validated(
            executor,
            "foundation:F2",
            F2_RULE,
            model,
            reasoning,
            input.clone(),
            delivery_schema("F2",&input),
            &[],
            |value| {
                restore_delivery_refs(value,&input)?;
                apply_catalogue(
                    value,
                    &source,
                    &batch,
                    &input,
                    &foundation,
                    confirmed,
                    &resolved,
                )
                .map(|_| ())
            },
        )
        .await?;
        foundation = apply_catalogue(
            &result,
            &source,
            &batch,
            &input,
            &foundation,
            confirmed,
            &resolved,
        )?;
        accepted_batches.push(batch);
        call_index += 1;
    }
    verify_coverage(&source, &selected, &accepted_batches)?;
    // Q1 packs every contiguous short-episode group by its *actual* request budget,
    // rather than inheriting F2's 24k source-only limit. Long fragments stay ordered.
    let mut q_pending = editor_batches(accepted_batches);
    let mut signals = vec![];
    let mut q_index = 0;
    while !q_pending.is_empty() {
        let q_source = source_projection(&source, &foundation.issues, &selected)?;
        let (batch, input) = prepare_capacity_batch(
            "Q1",
            &q_source,
            &mut q_pending,
            &foundation,
            context,
            q_index,
            &signals,
        )?;
        let result = call_validated(
            executor,
            "foundation:Q1",
            Q1_RULE,
            model,
            reasoning,
            input.clone(),
            delivery_schema("Q1",&input),
            &[],
            |value| {
                restore_delivery_refs(value,&input)?;
                apply_optimization(value, &q_source, &batch, &input, &foundation, confirmed)
                    .map(|_| ())
            },
        )
        .await?;
        let (next, new_signals) =
            apply_optimization(&result, &q_source, &batch, &input, &foundation, confirmed)?;
        foundation = next;
        signals.extend(new_signals);
        q_index += 1;
    }
    foundation.updated_episode_ids = selected.clone();
    foundation.rule_snapshots = rule_snapshots()
        .into_iter()
        .filter(|r| ["screenplay-fidelity", F2_RULE, Q1_RULE].contains(&r.id.as_str()))
        .collect();
    let projected_source = source_projection(&source, &foundation.issues, &selected)?;
    materialize_foundation(&projected_source, &mut foundation)?;
    validate_foundation(&projected_source, &foundation)?;
    Ok(foundation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct CopiedProjectLiveExecutor {
        inner: crate::text_executor::SavedTextExecutor,
        frozen_f2: Value,
        frozen_q1: Option<Value>,
    }
    #[async_trait]
    impl TextExecutor for CopiedProjectLiveExecutor {
        async fn execute(&self, request:TextRequest)->Result<Value,String> {
            if request.stage=="foundation:Q1" {
                let mut captured=serde_json::to_value(&request).map_err(|e|e.to_string())?;
                captured["structuredOutputTransport"]=json!("strict-optionals/v1");captured["executorPolicy"]=json!("codex-isolated/v1");
                captured["executorIdentity"]=json!({"provider":"codex","executable":crate::text_cli::resolve_executable(&self.inner.settings)?.to_string_lossy()});
                let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(format!("reports/foundation-real-a-20261005/current-q1-{}.json",request.input["scope"].as_array().unwrap().len()));
                std::fs::write(path,serde_json::to_vec_pretty(&captured).unwrap()).map_err(|e|e.to_string())?;
            }
            if request.stage=="foundation:F2" {
                let mut current=serde_json::to_value(&request).map_err(|e|e.to_string())?;
                current["structuredOutputTransport"]=json!("strict-optionals/v1");
                current["executorPolicy"]=json!("codex-isolated/v1");
                current["executorIdentity"]=json!({"provider":"codex","executable":crate::text_cli::resolve_executable(&self.inner.settings)?.to_string_lossy()});
                if !crate::text_executor::legacy_f2_snapshot_compatible(&self.frozen_f2,&current) {
                    return Err("真实副本F2请求与冻结请求不满足精确迁移条件；测试禁止重新生成F2".into());
                }
                self.inner.ensure_saved_replay_available(&request)?;
            }
            if request.stage=="foundation:Q1" && self.frozen_q1.as_ref().is_some_and(|f|f["input"]["scope"]==request.input["scope"]) {
                let frozen=self.frozen_q1.as_ref().unwrap();
                let mut current=serde_json::to_value(&request).map_err(|e|e.to_string())?;
                current["structuredOutputTransport"]=json!("strict-optionals/v1");
                current["executorPolicy"]=json!("codex-isolated/v1");
                current["executorIdentity"]=json!({"provider":"codex","executable":crate::text_cli::resolve_executable(&self.inner.settings)?.to_string_lossy()});
                if &current!=frozen {return Err("真实副本首批Q1请求变化；测试禁止重新生成已收到的整编".into());}
                self.inner.ensure_saved_replay_available(&request)?;
            }
            self.inner.execute(request).await
        }
        async fn accept(&self,r:&TextRequest,v:&Value)->Result<(),String>{self.inner.accept(r,v).await}
        async fn reject(&self,r:&TextRequest,v:&Value,e:&str)->Result<(),String>{self.inner.reject(r,v,e).await}
    }

    #[tokio::test]
    #[ignore="explicit real-script copy: reuse saved F2 and Q1, finish only the remaining Q1 capacity batch, no production writes or image/video requests"]
    async fn real_script_copy_reuses_original_f2_and_completes_live_q1_handoff() {
        let root=std::path::PathBuf::from(std::env::var("DIRECTOR_TEST_REAL_FOUNDATION_COPY").expect("explicit isolated copy required"));
        let resolved=std::fs::canonicalize(&root).unwrap();
        assert!(resolved.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap())&&root.file_name().and_then(|s|s.to_str())==Some("isolated-project"));
        let store=crate::store::Store::open(root.clone()).unwrap();
        let run="0f7f34c8-423f-4caa-be8f-e33c3c2a027b";
        let rejected="3d87f01a-7599-4acc-aed7-ff1178af0ee2";
        let parent=store.job(run).unwrap();let original=store.job(rejected).unwrap();
        let input=&parent["snapshot"]["input"];
        let source:LockedSource=serde_json::from_value(input["source"].clone()).unwrap();
        let context=json!({"foundation":input["foundation"],"assets":input["assets"],"selection":input["selection"],"settings":{"confirmedDirection":input["foundation"]["productionDirection"]}});
        let saved_q1=store.job("79b78538-2683-43ec-81a5-744295c733a2").ok();
        let executor=CopiedProjectLiveExecutor{inner:crate::text_executor::SavedTextExecutor{store:store.clone(),settings:input["settings"].clone(),workflow_id:Some(run.into())},frozen_f2:original["snapshot"].clone(),frozen_q1:saved_q1.as_ref().map(|j|j["snapshot"].clone())};
        let counts=||->usize {store.jobs().unwrap().iter().filter(|j|j["kind"]=="text").count()};
        let before=counts();let before_f2=store.jobs().unwrap().iter().filter(|j|j["kind"]=="text"&&j["snapshot"]["stage"]=="foundation:F2").count();let started=std::time::Instant::now();
        let mut report=json!({"ok":false,"fixtureProject":root,"productionDatabaseWrites":false,"sourceSha256":source.sha256,"episodes":source.episodes.len(),"oldF2RawPreserved":false,"newF2Requests":0,"imageVideoRequests":0});
        let outcome:Result<(),String>=async {
            let mut proposal=run_foundation_delivery(&source,&context,&executor,"gpt-6.1-sol","medium").await?;
            report["firstRunMilliseconds"]=json!(started.elapsed().as_millis());
            report["newTextRequests"]=json!(counts()-before);
            let jobs=store.jobs()?;
            assert_eq!(jobs.iter().filter(|j|j["kind"]=="text"&&j["snapshot"]["stage"]=="foundation:F2").count(),before_f2,"replay must not generate F2");
            assert!(counts()-before<=1,"only the remaining Q1 capacity batch may call the model");
            let replay=run_foundation_delivery(&source,&context,&executor,"gpt-6.1-sol","medium").await?;
            assert_eq!(counts(),jobs.iter().filter(|j|j["kind"]=="text").count(),"same-source replay must not add requests");
            assert_eq!(serde_json::to_value(&proposal).unwrap(),serde_json::to_value(replay).unwrap());
            let original_after=store.job(rejected)?;
            assert_eq!(original_after["snapshot"],original["snapshot"]);assert_eq!(original_after["result"],original["result"]);
            if let Some(saved)=&saved_q1 {let after=store.job(saved["id"].as_str().unwrap())?;assert_eq!(after["snapshot"],saved["snapshot"]);assert_eq!(after["result"],saved["result"]);report["oldQ1RawPreserved"]=json!(true);}
            report["totalQ1Calls"]=json!(store.jobs()?.iter().filter(|j|j["kind"]=="text"&&j["snapshot"]["stage"]=="foundation:Q1").count());
            report["oldF2RawPreserved"]=json!(true);report["cacheReplayNewRequests"]=json!(0);
            let revised=super::super::execute_foundation_scene_edits(&source,&mut proposal)?.map(serde_json::to_value).transpose().map_err(|e|e.to_string())?;
            report["assetIdentities"]=json!(proposal.assets.len());
            let assets=flatten_foundation_assets(&proposal);report["stage2AssetRows"]=json!(assets.len());
            report["issues"]=json!(proposal.issues.iter().map(|i|json!({"coordinate":i.coordinate,"blocking":i.blocking,"episodes":i.episode_ids})).collect::<Vec<_>>());
            let guard=parent["prepared"].get("publicationGuard").unwrap_or(&parent["snapshot"]["guard"]);
            store.publish_foundation_with_source(guard,serde_json::to_value(&proposal).map_err(|e|e.to_string())?,assets,Some(run),revised)?;
            assert_eq!(store.source()?["text"],source.text);assert_eq!(store.source()?["sha256"],source.sha256);
            report["sourcePreserved"]=json!(true);report["publishedFoundationVersion"]=store.foundation()?["version"].clone();
            Ok(())
        }.await;
        report["ok"]=json!(outcome.is_ok());report["totalMilliseconds"]=json!(started.elapsed().as_millis());
        if let Err(e)=&outcome {report["error"]=json!(e);}
        let output=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("reports/foundation-real-a-20261005/live-copy.json");
        std::fs::write(output,serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        outcome.unwrap();
    }

    #[tokio::test]
    #[ignore="explicit fresh Temp project: two real Codex text requests for the saved 10-episode script, no production writes or media"]
    async fn compact_ten_episode_live_timing_and_stage2_handoff() {
        let root=std::path::PathBuf::from(std::env::var("DIRECTOR_SPEED_PROJECT").expect("explicit new isolated project required"));
        let report_path=std::path::PathBuf::from(std::env::var("DIRECTOR_SPEED_REPORT").expect("explicit report required"));
        let resolved=std::fs::canonicalize(&root).unwrap();
        assert!(resolved.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap())&&root.file_name().and_then(|s|s.to_str())==Some("isolated-project"));
        assert!(!root.join("project.sqlite").exists(),"fresh test only; retained results must not silently regenerate");
        let source:LockedSource=serde_json::from_str(include_str!("../../../reports/foundation-real-a-20261005/source.json")).unwrap();
        let store=crate::store::Store::open(root.clone()).unwrap();
        store.create("10集轻输入真实验收",&uuid::Uuid::new_v4().to_string()).unwrap();
        store.ensure_workflow_storage().unwrap();
        store.save_source(json!(source)).unwrap();
        let settings=crate::text_cli::resolve_settings(&json!({"textProvider":"codex","textModel":"gpt-6.1-sol","reasoning":"medium"})).await.unwrap();
        let context=json!({"foundationModelInputProfile":super::super::foundation_wire::PROFILE});
        let run=store.add_job("workflow","foundation.run","local","",&json!({"foundationMethod":METHOD_VERSION,"sourceSha256":source.sha256,"foundationModelInputProfile":super::super::foundation_wire::PROFILE}),"running").unwrap();
        let executor=crate::text_executor::SavedTextExecutor{store:store.clone(),settings,workflow_id:Some(run.clone())};
        let started=std::time::Instant::now();
        let mut report=json!({"ok":false,"profile":super::super::foundation_wire::PROFILE,"model":"gpt-6.1-sol","reasoning":"medium","fixtureProject":root,"episodes":source.episodes.len(),"sourceSha256":source.sha256,"productionDatabaseWrites":false,"mediaRequests":0});
        let result:Result<(),String>=async {
            let mut proposal=run_foundation_delivery(&source,&context,&executor,"gpt-6.1-sol","medium").await?;
            report["generationMilliseconds"]=json!(started.elapsed().as_millis());
            let jobs=store.jobs()?;
            assert_eq!(jobs.iter().filter(|j|j["kind"]=="text").count(),2,"actual 10-episode data must fit one F2 and one Q1");
            let replay=run_foundation_delivery(&source,&context,&executor,"gpt-6.1-sol","medium").await?;
            assert_eq!(store.jobs()?.len(),jobs.len());
            assert_eq!(json!(replay),json!(proposal));
            report["cacheAdditionalRequests"]=json!(0);
            let revised=super::super::execute_foundation_scene_edits(&source,&mut proposal)?.unwrap_or(source.clone());
            assert_eq!(revised.text,source.text);assert_eq!(revised.sha256,source.sha256);
            validate_source(&revised)?;validate_foundation(&revised,&proposal)?;
            store.save_source(json!(revised))?;
            store.save_foundation(json!(proposal))?;
            let assets=flatten_foundation_assets(&proposal);
            assert!(!assets.is_empty());
            for asset in &assets {store.save_asset(asset.clone())?;}
            assert_eq!(store.values("assets")?.len(),assets.len());
            report["assetIdentities"]=json!(proposal.assets.len());report["stage2AssetRows"]=json!(assets.len());
            report["sourcePreserved"]=json!(true);report["blockingIssues"]=json!(proposal.issues.iter().filter(|i|i.blocking).count());
            report["notes"]=json!(proposal.issues.iter().map(|i|json!({"coordinate":i.coordinate,"blocking":i.blocking})).collect::<Vec<_>>());
            Ok(())
        }.await;
        report["ok"]=json!(result.is_ok());report["totalMilliseconds"]=json!(started.elapsed().as_millis());
        if let Err(error)=&result {report["error"]=json!(error);}
        report["jobs"]=json!(store.jobs().unwrap().iter().filter(|j|j["kind"]=="text").map(|j|{
            let wire=std::fs::read(root.join("text-runs").join(j["id"].as_str().unwrap()).join("wire-request.json")).ok().and_then(|b|serde_json::from_slice::<Value>(&b).ok());
            let raw=std::fs::read_to_string(root.join("text-runs").join(j["id"].as_str().unwrap()).join("result.json")).ok();
            json!({"id":j["id"],"stage":j["snapshot"]["stage"],"status":j["status"],"createdAt":j["createdAt"],"updatedAt":j["updatedAt"],"receipt":j["receipt"],"error":j["error"],"canonicalInputChars":units(&j["snapshot"]["input"].to_string()),"wireInputChars":wire.as_ref().map(|v|units(&v["prompt"]["input"].to_string())),"rawOutputChars":raw.as_ref().map(|v|units(v))})
        }).collect::<Vec<_>>());
        crate::store::atomic_json(&report_path,&report).unwrap();
        println!("{}",json!({"ok":report["ok"],"report":report_path,"milliseconds":report["generationMilliseconds"],"error":report["error"]}));
        result.unwrap();
    }
    #[tokio::test]
    #[ignore="explicit retained speed fixture: read saved F2/Q1 only, zero model calls or production writes"]
    async fn final_compact_contract_replays_real_speed_results_without_generation() {
        struct Replay {jobs:Vec<Value>, root:std::path::PathBuf, calls:Mutex<Vec<Value>>}
        #[async_trait]
        impl TextExecutor for Replay {
            async fn execute(&self,r:TextRequest)->Result<Value,String> {
                let saved=self.jobs.iter().find(|j|j["snapshot"]["stage"]==r.stage).ok_or("replay has no exact stage")?;
                assert_eq!(saved["snapshot"]["sourceSha256"],Value::Null);
                assert_eq!(saved["snapshot"]["schema"],r.schema);
                assert_eq!(saved["snapshot"]["ruleSnapshot"],r.rule_snapshot);
                let old_wire:Value=serde_json::from_slice(&std::fs::read(self.root.join("text-runs").join(saved["id"].as_str().unwrap()).join("wire-request.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
                let compiled=super::super::foundation_wire::compile(&r.stage,&r.input,&r.schema)?;
                assert_eq!(compiled.input,old_wire["prompt"]["input"],"current final transport input differs from the actually tested model input");
                assert!(request_chars(r.stage.rsplit(':').next().unwrap(),&r.input,&r.schema)?<=MODEL_TRANSPORT_LIMIT);
                let mut result=saved["result"].clone();compiled.restore(&mut result)?;
                self.calls.lock().unwrap().push(json!({"stage":r.stage,"scope":r.input["scope"],"actualTestedWireReused":true}));
                Ok(result)
            }
        }
        let root=std::path::PathBuf::from(std::env::var("DIRECTOR_SPEED_PROJECT").expect("explicit retained fixture"));
        let canonical=std::fs::canonicalize(&root).unwrap();assert!(canonical.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap()));
        let store=crate::store::Store::open(root.clone()).unwrap();
        // Store::jobs is a UI projection and adds result.mediaIds; the saved
        // executor reads the original SQL value, which is the contract evidence.
        let connection=store.conn().unwrap();
        let mut statement=connection.prepare("SELECT id,snapshot,result FROM jobs WHERE kind='text' ORDER BY created_at").unwrap();
        let jobs=statement.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?))).unwrap().map(|row|{let(id,snapshot,result)=row.unwrap();json!({"id":id,"snapshot":serde_json::from_str::<Value>(&snapshot).unwrap(),"result":serde_json::from_str::<Value>(&result).unwrap()})}).collect::<Vec<_>>();assert_eq!(jobs.len(),2);
        let source:LockedSource=serde_json::from_str(include_str!("../../../reports/foundation-real-a-20261005/source.json")).unwrap();
        let executor=Replay{jobs,root,calls:Mutex::new(vec![])};
        let context=json!({"foundationModelInputProfile":super::super::foundation_wire::PROFILE});
        let mut proposal=run_foundation_delivery(&source,&context,&executor,"gpt-6.1-sol","medium").await.unwrap();
        let revised=super::super::execute_foundation_scene_edits(&source,&mut proposal).unwrap().unwrap_or(source.clone());
        validate_source(&revised).unwrap();validate_foundation(&revised,&proposal).unwrap();
        assert_eq!(source.text,revised.text);assert_eq!(source.sha256,revised.sha256);
        assert!(proposal.issues.iter().all(|i|!regex::Regex::new(r"^r\d+$").unwrap().is_match(&i.coordinate)));
        let calls=executor.calls.into_inner().unwrap();assert_eq!(calls.len(),2);
        assert_eq!(flatten_foundation_assets(&proposal).len(),51);
        let report=json!({"ok":true,"realModelCalls":0,"finalWireMatchesTestedInput":true,"sourcePreserved":true,"assetRows":51,"sourceIssueCoordinatesCanonical":true,"calls":calls});
        let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("reports/foundation-speed-20261005/final-replay.json");
        crate::store::atomic_json(&path,&report).unwrap();
    }
    fn source(count: usize) -> LockedSource {
        prepare_source(
            &(1..=count)
                .map(|i| format!("第{i}集\n场景：大厅\n小王：开始。\n△小王穿白衣进入。\n"))
                .collect::<String>(),
        )
        .unwrap()
    }
    fn empty_catalogue(source: &LockedSource, batch: &Batch) -> Value {
        json!({"format":"ASSET_CATALOG_DESKTOP_V2","sourceSha256":source.sha256,"coverage":batch.scope,"assets":[]})
    }
    fn empty_edit(source: &LockedSource, batch: &Batch) -> Value {
        json!({"format":"ASSET_OPTIMIZATION_DESKTOP_V2","sourceSha256":source.sha256,"coverage":batch.scope,"changes":{}})
    }
    struct Counter {
        requests: Mutex<Vec<TextRequest>>,
    }
    #[async_trait]
    impl TextExecutor for Counter {
        async fn execute(&self, request: TextRequest) -> Result<Value, String> {
            let scope = request.input["scope"].clone();
            let hash = request.input["sourceSha256"].clone();
            let stage = request.stage.clone();
            self.requests.lock().unwrap().push(request);
            Ok(if stage == "foundation:F2" {
                json!({"format":"ASSET_CATALOG_DESKTOP_V2","sourceSha256":hash,"coverage":scope,"assets":[]})
            } else {
                json!({"format":"ASSET_OPTIMIZATION_DESKTOP_V2","sourceSha256":hash,"coverage":scope,"changes":{}})
            })
        }
    }
    #[tokio::test]
    async fn ten_short_episodes_are_one_catalogue_and_one_editor_call() {
        let source = source(10);
        let executor = Counter {
            requests: Mutex::new(vec![]),
        };
        let result =
            run_foundation_delivery(&source, &json!({}), &executor, "gpt-6.1-sol", "medium")
                .await
                .unwrap();
        let calls = executor.requests.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].input["scope"].as_array().unwrap().len(), 10);
        assert_eq!(result.episodes.len(), 10);
        assert_eq!(result.updated_episode_ids.len(), 10);
        assert!(calls[0].input["source"]["rows"][0].is_array());
        assert!(calls[0].schema["properties"].get("episodes").is_none());
        assert_eq!(
            calls[1].schema["properties"]["changes"]["required"],
            json!([])
        );
    }
    #[test]
    fn long_utf16_fragments_cover_crlf_surrogates_and_every_locked_row() {
        let text = format!(
            "第1集\r\n场景：大厅\r\n△{}\r\n小王：结束。\r\n第2集\r\n场景：门口\r\n小王：走。\r\n",
            "😀甲".repeat(9000)
        );
        let s = prepare_source(&text).unwrap();
        let selected = s.episodes.iter().map(|e| e.id.clone()).collect::<Vec<_>>();
        let batches = plan_batches(&s, &selected).unwrap();
        assert!(batches.iter().any(|b| b.fragment.is_some()));
        verify_coverage(&s, &selected, &batches).unwrap();
        for batch in batches.iter().filter(|b| b.fragment.is_some()) {
            assert!(batch.pieces.iter().map(|p| units(&p.text)).sum::<usize>() <= FRAGMENT_BUDGET);
            for p in &batch.pieces {
                assert_eq!(
                    slice_utf16(
                        &s.text,
                        &SourceRange {
                            start: p.start,
                            end: p.end
                        }
                    )
                    .unwrap(),
                    p.text
                );
            }
        }
    }
    #[test]
    fn empty_editor_changes_preserve_every_canonical_value() {
        let s = source(2);
        let batch = plan_batches(
            &s,
            &s.episodes.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
        )
        .unwrap()
        .remove(0);
        let p = empty_foundation(&s);
        let input = input_for("Q1", &s, &batch, &p, &json!({}), 0, 1, true, &[]);
        let (next, _) =
            apply_optimization(&empty_edit(&s, &batch), &s, &batch, &input, &p, None).unwrap();
        assert_eq!(
            serde_json::to_value(next).unwrap(),
            serde_json::to_value(p).unwrap()
        );
    }
    #[test]
    fn malformed_coverage_and_unprovided_evidence_are_rejected() {
        let s = source(2);
        let batches = plan_batches(
            &s,
            &s.episodes.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
        )
        .unwrap();
        let batch = &batches[0];
        let p = empty_foundation(&s);
        let input = input_for("F2", &s, batch, &p, &json!({}), 0, 1, false, &[]);
        let mut wire = empty_catalogue(&s, batch);
        wire["coverage"] = json!([batch.scope[0]]);
        assert!(apply_catalogue(&wire, &s, batch, &input, &p, None, &HashSet::new()).is_err());
        assert!(provided_refs(&["not-supplied".into()], &allowed_refs(&input)).is_err());
    }
    #[test]
    fn historical_neighbours_and_character_claims_are_evidence_only() {
        let s=prepare_source("第1集\n场景：大厅\n△小王受伤。\n△他随后痊愈。\n第2集\n场景：大厅\n小王：我没有受过伤。\n").unwrap();
        let batch = Batch {
            scope: vec![s.episodes[1].id.clone()],
            pieces: whole_rows(&s, &[s.episodes[1].id.clone()]),
            fragment: None,
        };
        let evidence = evidence(&s, &batch, &empty_foundation(&s));
        assert_eq!(evidence["currentApplicability"], "UNKNOWN");
        assert!(evidence["historicalEvidenceCandidates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r[3].as_str().unwrap().contains("痊愈") && r[5] == "SOURCE_NEIGHBOUR"));
    }
    #[test]
    fn same_names_do_not_merge_new_source_anchored_identities() {
        let s = source(2);
        let batch = plan_batches(
            &s,
            &s.episodes.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
        )
        .unwrap()
        .remove(0);
        let p = empty_foundation(&s);
        let input = input_for("F2", &s, &batch, &p, &json!({}), 0, 1, false, &[]);
        let rows = s
            .rows
            .iter()
            .filter(|r| r.kind == "body" && r.text.contains("白衣"))
            .collect::<Vec<_>>();
        let mut wire = empty_catalogue(&s, &batch);
        wire["assets"]=json!(rows.iter().map(|r|json!({"name":"小王｜白衣","type":"CH","episodes":[r.episode_id],"sceneRefs":[[r.episode_id,r.scene_id]],"sourceRefs":[r.id],"preparation":{"mode":"REFERENCE"}})).collect::<Vec<_>>());
        let next = apply_catalogue(&wire, &s, &batch, &input, &p, None, &HashSet::new()).unwrap();
        assert_eq!(next.assets.len(), 2);
        assert_ne!(next.assets[0].id, next.assets[1].id);
        assert_eq!(
            next.assets[0].variants[0].metadata["preparation"]["mode"],
            "REFERENCE"
        );
    }

    fn two_episode_catalogue() -> (LockedSource, FoundationProposal) {
        let s = source(2);
        let selected = s.episodes.iter().map(|e| e.id.clone()).collect::<Vec<_>>();
        let batch = plan_batches(&s, &selected).unwrap().remove(0);
        let prior = empty_foundation(&s);
        let refs = s
            .rows
            .iter()
            .filter(|r| r.kind == "body" && r.text.contains("白衣"))
            .map(|r| r.id.clone())
            .collect::<Vec<_>>();
        let pairs = s
            .rows
            .iter()
            .filter(|r| refs.contains(&r.id))
            .map(|r| json!([r.episode_id, r.scene_id]))
            .collect::<Vec<_>>();
        let wire = json!({"format":"ASSET_CATALOG_DESKTOP_V2","sourceSha256":s.sha256,"coverage":selected,"assets":[{"name":"小王｜白衣","type":"CH","episodes":selected,"sceneRefs":pairs,"sourceRefs":refs,"role":"主角","relationNote":"独立人物，不因同名合并","preparation":{"mode":"REFERENCE"},"variants":[{"name":"伤态","episodes":selected,"sceneRefs":pairs,"sourceRefs":refs,"note":"必要持续状态","preparation":{"mode":"INLINE"}},{"name":"旧伤态","episodes":selected,"sceneRefs":pairs,"sourceRefs":refs,"preparation":{"mode":"DERIVE"}}]}]});
        let input = input_for("F2", &s, &batch, &prior, &json!({}), 0, 1, false, &[]);
        let next =
            apply_catalogue(&wire, &s, &batch, &input, &prior, None, &HashSet::new()).unwrap();
        (s, next)
    }

    fn preparation_conflict_fixture() -> (LockedSource, FoundationProposal, Batch) {
        let s = source(2);
        let selected = s.episodes.iter().map(|e| e.id.clone()).collect::<Vec<_>>();
        let all = Batch { scope: selected.clone(), pieces: whole_rows(&s, &selected), fragment: None };
        let prior = empty_foundation(&s);
        let pairs = s.scenes.iter().map(|scene| json!([scene.episode_id, scene.id])).collect::<Vec<_>>();
        let asset = json!({"name":"小王｜默认","type":"CH","episodes":selected,"sceneRefs":pairs,
            "preparation":{"mode":"REFERENCE","note":"已登记人物基线"},"variants":[
                {"name":"小王｜Q版","episodes":selected,"sceneRefs":pairs,"preparation":{"mode":"REFERENCE","note":"已登记独立制作"}},
                {"name":"小王｜白衣","episodes":selected,"sceneRefs":pairs,"preparation":{"mode":"DERIVE","note":"已登记基线派生"}}
            ]});
        let mut raw = empty_catalogue(&s, &all);
        raw["assets"] = json!([asset, asset]); // Equal display names are distinct identities.
        let input = input_for("F2", &s, &all, &prior, &json!({}), 0, 1, false, &[]);
        let p = apply_catalogue(&raw, &s, &all, &input, &prior, None, &HashSet::new()).unwrap();
        let first = vec![s.episodes[0].id.clone()];
        let batch = Batch { scope: first.clone(), pieces: whole_rows(&s, &first), fragment: None };
        (s, p, batch)
    }

    fn preparation_conflict_catalogue(s: &LockedSource, p: &FoundationProposal, batch: &Batch, prep: Value) -> Value {
        let asset = &p.assets[0];
        let pairs = s.scenes.iter().filter(|scene| batch.scope.contains(&scene.episode_id))
            .map(|scene| json!([scene.episode_id, scene.id])).collect::<Vec<_>>();
        let mut wire = empty_catalogue(s, batch);
        wire["assets"] = json!([{"key":asset.id,"name":"小王｜默认","type":"CH","episodes":batch.scope,
            "sceneRefs":pairs,"preparation":asset.metadata["preparation"],"variants":[{
                "key":asset.variants[1].id,"name":asset.variants[1].name,"episodes":batch.scope,
                "sceneRefs":pairs,"preparation":prep
            }]}]);
        wire
    }

    #[test]
    fn f2_preparation_conflict_retains_reference_and_every_external_use_for_both_profiles() {
        let (s, p, batch) = preparation_conflict_fixture();
        for context in [json!({}), json!({"foundationModelInputProfile":super::super::foundation_wire::PROFILE})] {
            let input = input_for("F2", &s, &batch, &p, &context, 0, 1, false, &[]);
            let wire = preparation_conflict_catalogue(&s, &p, &batch, json!({"mode":"DERIVE","fromKey":p.assets[0].variants[0].id,"note":"本批建议基线派生"}));
            let next = apply_catalogue(&wire, &s, &batch, &input, &p, None, &HashSet::new()).unwrap();
            let old = &p.assets[0].variants[1];
            let new = &next.assets[0].variants[1];
            assert_eq!(new.source_variant_id, None);
            assert_eq!(new.metadata["preparation"], old.metadata["preparation"]);
            assert_eq!(new.scope.scenes, old.scope.scenes);
            assert_eq!(new.source_refs, old.source_refs);
            assert_eq!(new.metadata["usageEpisodes"], old.metadata["usageEpisodes"]);
            assert_eq!(serde_json::to_value(&next.assets[1]).unwrap(), serde_json::to_value(&p.assets[1]).unwrap());
            let issue = next.issues.iter().find(|i| i.details.as_ref().is_some_and(|d| d["kind"] == "PREPARATION_CONFLICT")).unwrap();
            assert!(!issue.blocking);
            assert!(issue.coordinate.starts_with("preparation:"));
            assert_eq!(issue.episode_ids, batch.scope);
            assert!(issue.source_refs.iter().all(|id| batch.row_ids().contains(id.as_str())));
            let details = issue.details.as_ref().unwrap();
            assert_eq!(details["previous"]["preparation"], old.metadata["preparation"]);
            assert_eq!(details["previous"]["sourceVariantId"], Value::Null);
            assert_eq!(details["proposed"]["sourceVariantId"], p.assets[0].variants[0].id);
            assert_eq!(details["proposed"]["preparation"]["mode"], "DERIVE");
            assert_eq!(details["previousSceneRefs"], serde_json::to_value(&old.scope.scenes).unwrap());
            assert_eq!(details["currentSceneRefs"].as_array().unwrap().len(), 1);
        }
    }

    #[test]
    fn f2_preparation_conflict_q1_can_keep_or_explicitly_change_the_registered_basis() {
        let (s, p, batch) = preparation_conflict_fixture();
        let f2 = input_for("F2", &s, &batch, &p, &json!({}), 0, 1, false, &[]);
        let raw = preparation_conflict_catalogue(&s, &p, &batch, json!({"mode":"DERIVE","fromKey":p.assets[0].variants[0].id}));
        let staged = apply_catalogue(&raw, &s, &batch, &f2, &p, None, &HashSet::new()).unwrap();
        let issue = staged.issues.iter().find(|i| i.coordinate.starts_with("preparation:")).unwrap();
        let q1 = input_for("Q1", &s, &batch, &staged, &json!({}), 0, 1, true, &[]);
        let mut keep = empty_edit(&s, &batch);
        keep["resolvedIssues"] = json!([issue.coordinate]);
        let (retained, _) = apply_optimization(&keep, &s, &batch, &q1, &staged, None).unwrap();
        assert_eq!(retained.assets[0].variants[1].source_variant_id, None);
        assert_eq!(retained.assets[0].variants[1].metadata["preparation"], p.assets[0].variants[1].metadata["preparation"]);
        assert!(retained.issues.iter().all(|i| i.coordinate != issue.coordinate));
        let mut explicit_keep = keep.clone();
        explicit_keep["changes"] = json!({"assets":[{"key":p.assets[0].id,"variants":[{"key":p.assets[0].variants[1].id,"preparation":p.assets[0].variants[1].metadata["preparation"]}]}]});
        assert!(apply_optimization(&explicit_keep, &s, &batch, &q1, &staged, None).unwrap().0.issues.iter().all(|i| i.coordinate != issue.coordinate));
        let mut change = keep;
        change["changes"] = json!({"assets":[{"key":p.assets[0].id,"variants":[{"key":p.assets[0].variants[1].id,"preparation":{"mode":"DERIVE","fromKey":p.assets[0].variants[0].id,"note":"Q1明确采纳制作建议"}}]}]});
        let (changed, _) = apply_optimization(&change, &s, &batch, &q1, &staged, None).unwrap();
        assert_eq!(changed.assets[0].variants[1].source_variant_id, Some(p.assets[0].variants[0].id.clone()));
        assert!(changed.issues.iter().all(|i| i.coordinate != issue.coordinate));
        assert_eq!(changed.assets[0].variants[1].scope.scenes, p.assets[0].variants[1].scope.scenes);
    }

    #[test]
    fn f2_preparation_conflict_swap_parent_and_mode_only_changes_are_q1_suggestions() {
        let (s, p, batch) = preparation_conflict_fixture();
        let input = input_for("F2", &s, &batch, &p, &json!({}), 0, 1, false, &[]);
        let mut raw = preparation_conflict_catalogue(&s, &p, &batch, json!({"mode":"DERIVE","fromKey":p.assets[0].variants[1].id}));
        raw["assets"][0]["variants"][0]["key"] = json!(p.assets[0].variants[2].id);
        raw["assets"][0]["variants"][0]["name"] = json!(p.assets[0].variants[2].name);
        let next = apply_catalogue(&raw, &s, &batch, &input, &p, None, &HashSet::new()).unwrap();
        assert_eq!(next.assets[0].variants[2].source_variant_id, p.assets[0].variants[2].source_variant_id);
        assert_eq!(next.assets[0].variants[2].metadata["preparation"], p.assets[0].variants[2].metadata["preparation"]);
        let issue = next.issues.iter().find(|i| i.coordinate.starts_with("preparation:")).unwrap();
        assert_eq!(issue.details.as_ref().unwrap()["proposed"]["sourceVariantId"], p.assets[0].variants[1].id);
        let mut mode_only = preparation_conflict_catalogue(&s, &p, &batch, json!({"mode":"AUDIO"}));
        let next = apply_catalogue(&mode_only, &s, &batch, &input, &p, None, &HashSet::new()).unwrap();
        assert_eq!(next.assets[0].variants[1].metadata["preparation"], p.assets[0].variants[1].metadata["preparation"]);
        mode_only["assets"][0]["preparation"] = json!({"mode":"AUDIO"});
        let next = apply_catalogue(&mode_only, &s, &batch, &input, &p, None, &HashSet::new()).unwrap();
        assert_eq!(next.assets[0].metadata["preparation"], p.assets[0].metadata["preparation"]);
        assert_eq!(next.assets[0].variants[0].metadata["preparation"], p.assets[0].variants[0].metadata["preparation"]);
    }

    #[test]
    fn f2_preparation_conflict_does_not_hide_invalid_graph_identity_or_required_fields() {
        let (s, p, batch) = preparation_conflict_fixture();
        let input = input_for("F2", &s, &batch, &p, &json!({}), 0, 1, false, &[]);
        let run = |raw: &Value| apply_catalogue(raw, &s, &batch, &input, &p, None, &HashSet::new());
        let valid = preparation_conflict_catalogue(&s, &p, &batch, json!({"mode":"DERIVE","fromKey":p.assets[0].variants[0].id}));
        let mut unknown = valid.clone();
        unknown["assets"][0]["variants"][0]["preparation"]["fromKey"] = json!("missing-parent");
        assert!(run(&unknown).is_err());
        let mut self_link = valid.clone();
        self_link["assets"][0]["variants"][0]["preparation"]["fromKey"] = json!(p.assets[0].variants[1].id);
        assert!(run(&self_link).unwrap_err().contains("自身"));
        let mut cycle = valid.clone();
        cycle["assets"][0]["variants"][0]["preparation"]["fromKey"] = json!(p.assets[0].variants[2].id);
        let mut second = cycle["assets"][0]["variants"][0].clone();
        second["key"] = json!(p.assets[0].variants[2].id);
        second["name"] = json!(p.assets[0].variants[2].name);
        second["preparation"]["fromKey"] = json!(p.assets[0].variants[1].id);
        cycle["assets"][0]["variants"].as_array_mut().unwrap().push(second);
        assert!(run(&cycle).unwrap_err().contains("循环"));
        let mut wrong_identity = valid.clone();
        wrong_identity["assets"][0]["name"] = json!("另一人｜默认");
        assert!(run(&wrong_identity).unwrap_err().contains("身份"));
        let mut wrong_type = valid.clone();
        wrong_type["assets"][0]["type"] = json!("PROP");
        assert!(run(&wrong_type).unwrap_err().contains("身份"));
        let mut missing = valid.clone();
        missing["assets"][0]["variants"][0].as_object_mut().unwrap().remove("sceneRefs");
        assert!(run(&missing).unwrap_err().contains("必要目录字段"));
        let mut bad_scene = valid;
        bad_scene["assets"][0]["variants"][0]["sceneRefs"] = json!([[batch.scope[0], "unknown-scene"]]);
        assert!(run(&bad_scene).is_err());
    }

    #[test]
    fn f2_preparation_conflict_new_legal_variant_and_equivalent_parent_are_not_conflicts() {
        let (s, p, batch) = preparation_conflict_fixture();
        let input = input_for("F2", &s, &batch, &p, &json!({}), 0, 1, false, &[]);
        let mut new_child = preparation_conflict_catalogue(&s, &p, &batch, json!({"mode":"DERIVE","fromKey":p.assets[0].variants[0].id}));
        new_child["assets"][0]["variants"][0].as_object_mut().unwrap().remove("key");
        new_child["assets"][0]["variants"][0]["name"] = json!("新伤态");
        let next = apply_catalogue(&new_child, &s, &batch, &input, &p, None, &HashSet::new()).unwrap();
        let child = next.assets[0].variants.iter().find(|v| v.name == "新伤态").unwrap();
        assert_eq!(child.source_variant_id, Some(p.assets[0].variants[0].id.clone()));
        assert!(next.issues.iter().all(|i| !i.coordinate.starts_with("preparation:")));
        let mut equivalent = preparation_conflict_catalogue(&s, &p, &batch, json!({"mode":"DERIVE","fromKey":p.assets[0].id,"note":"同一父的另一种有效键"}));
        equivalent["assets"][0]["variants"][0]["key"] = json!(p.assets[0].variants[2].id);
        equivalent["assets"][0]["variants"][0]["name"] = json!(p.assets[0].variants[2].name);
        let next = apply_catalogue(&equivalent, &s, &batch, &input, &p, None, &HashSet::new()).unwrap();
        assert!(next.issues.iter().all(|i| !i.coordinate.starts_with("preparation:")));
    }

    #[test]
    fn f2_preparation_conflict_resolution_exception_does_not_close_real_or_program_issues() {
        let (s, p, batch) = preparation_conflict_fixture();
        let f2 = input_for("F2", &s, &batch, &p, &json!({}), 0, 1, false, &[]);
        let raw = preparation_conflict_catalogue(&s, &p, &batch, json!({"mode":"DERIVE","fromKey":p.assets[0].variants[0].id}));
        let staged = apply_catalogue(&raw, &s, &batch, &f2, &p, None, &HashSet::new()).unwrap();
        let issue_at = staged.issues.iter().position(|i| i.coordinate.starts_with("preparation:")).unwrap();
        let mut keep = empty_edit(&s, &batch);
        keep["resolvedIssues"] = json!([staged.issues[issue_at].coordinate]);
        for kind in ["blocking", "program", "ordinary", "basis-differs", "outside-scope"] {
            let mut p = staged.clone();
            match kind {
                "blocking" => p.issues[issue_at].blocking = true,
                "program" => p.issues[issue_at].details.as_mut().unwrap()["owner"] = json!("PROGRAM"),
                "ordinary" => p.issues[issue_at].details.as_mut().unwrap()["kind"] = json!("SOURCE_CONFLICT"),
                "basis-differs" => p.issues[issue_at].details.as_mut().unwrap()["previous"]["sourceVariantId"] = json!(p.assets[0].variants[0].id),
                _ => p.issues[issue_at].episode_ids.push(s.episodes[1].id.clone()),
            }
            let input = input_for("Q1", &s, &batch, &p, &json!({}), 0, 1, true, &[]);
            assert!(apply_optimization(&keep, &s, &batch, &input, &p, None).is_err(), "{kind}");
        }
    }
    #[test]
    fn inline_uses_strong_baseline_and_editor_keeps_external_appearance_scope() {
        let (s, p) = two_episode_catalogue();
        let asset = &p.assets[0];
        let baseline = &asset.variants[0];
        let inline = &asset.variants[1];
        let untouched = &asset.variants[2];
        assert_eq!(asset.name, "小王");
        assert_eq!(baseline.name, "白衣");
        assert_eq!(
            inline.source_variant_id.as_deref(),
            Some(baseline.id.as_str())
        );
        assert_eq!(inline.metadata["preparation"]["mode"], "INLINE");
        let batch = Batch {
            scope: vec![s.episodes[1].id.clone()],
            pieces: whole_rows(&s, &[s.episodes[1].id.clone()]),
            fragment: None,
        };
        let reference = s
            .rows
            .iter()
            .find(|r| r.episode_id.as_ref() == Some(&s.episodes[1].id) && r.text.contains("白衣"))
            .unwrap()
            .id
            .clone();
        let input = input_for("Q1", &s, &batch, &p, &json!({}), 0, 1, true, &[]);
        let mut wire = empty_edit(&s, &batch);
        wire["changes"] = json!({"assets":[{"key":asset.id,"role":"男主","sourceRefs":[reference],"variants":[{"key":inline.id,"sourceRefs":[reference],"note":"本批有据延续"}]}]});
        let (next, _) = apply_optimization(&wire, &s, &batch, &input, &p, None).unwrap();
        let asset = &next.assets[0];
        assert_eq!(asset.metadata["role"], "男主");
        assert_eq!(
            asset.metadata["relationNote"],
            p.assets[0].metadata["relationNote"]
        );
        assert_eq!(
            asset.variants[0].source_variant_id,
            baseline.source_variant_id
        );
        assert_eq!(
            asset
                .variants
                .iter()
                .find(|v| v.id == inline.id)
                .unwrap()
                .scope
                .scenes
                .len(),
            2
        );
        let shape = asset.variants.iter().find(|v| v.id == untouched.id).unwrap();
        // A keyed patch changes only its named variant. An omitted sibling is
        // not a request to remove its current-batch or external appearances.
        assert_eq!(serde_json::to_value(shape).unwrap(), serde_json::to_value(untouched).unwrap());
        assert_eq!(shape.scope.scenes.len(), 2);
        assert!(shape.scope.scenes.iter().any(|place| place.episode_id == s.episodes[0].id));
        assert!(shape.scope.scenes.iter().any(|place| place.episode_id == s.episodes[1].id));
    }
    #[test]
    fn editor_parent_cycle_and_prior_source_borrowing_are_rejected() {
        let (s, p) = two_episode_catalogue();
        let asset = &p.assets[0];
        let child = &asset.variants[1];
        let batch = Batch {
            scope: vec![s.episodes[1].id.clone()],
            pieces: whole_rows(&s, &[s.episodes[1].id.clone()]),
            fragment: None,
        };
        let current = s
            .rows
            .iter()
            .find(|r| r.episode_id.as_ref() == Some(&s.episodes[1].id) && r.text.contains("白衣"))
            .unwrap();
        let previous = s
            .rows
            .iter()
            .find(|r| r.episode_id.as_ref() == Some(&s.episodes[0].id) && r.text.contains("白衣"))
            .unwrap();
        let input = input_for("Q1", &s, &batch, &p, &json!({}), 0, 1, true, &[]);
        let mut cycle = empty_edit(&s, &batch);
        cycle["changes"] = json!({"assets":[{"key":asset.id,"sourceRefs":[current.id],"preparation":{"mode":"DERIVE","fromKey":child.id}}]});
        assert!(apply_optimization(&cycle, &s, &batch, &input, &p, None)
            .unwrap_err()
            .contains("循环"));
        let mut borrowed = empty_edit(&s, &batch);
        borrowed["changes"] = json!({"assets":[{"key":asset.id,"sourceRefs":[previous.id],"episodes":[current.episode_id],"sceneRefs":[[current.episode_id,current.scene_id]]}]});
        assert!(apply_optimization(&borrowed, &s, &batch, &input, &p, None)
            .unwrap_err()
            .contains("本场"));
    }
    #[test]
    fn light_catalogue_changes_bind_current_scope_without_model_reference_inventories() {
        let schema = q1_schema();
        let asset_schema = &schema["properties"]["changes"]["properties"]["assets"]["items"];
        let variant_schema = &asset_schema["properties"]["variants"]["items"];
        for item in [asset_schema, variant_schema] {
            assert_eq!(item["required"], json!([]));
            assert!(item["properties"].get("sourceRefs").is_none());
        }
        assert_eq!(schema["properties"]["changes"]["required"], json!([]));
        let f2 = f2_schema();
        assert!(f2["properties"]["assets"]["items"]["properties"].get("sourceRefs").is_none());
        assert!(f2["properties"]["assets"]["items"]["properties"]["variants"]["items"]["properties"].get("sourceRefs").is_none());
        let (source, prior) = two_episode_catalogue();
        let asset = &prior.assets[0];
        let child = &asset.variants[1];
        let batch = Batch {
            scope: vec![source.episodes[1].id.clone()],
            pieces: whole_rows(&source, &[source.episodes[1].id.clone()]),
            fragment: None,
        };
        let reference = source
            .rows
            .iter()
            .find(|row| {
                row.episode_id.as_ref() == Some(&source.episodes[1].id) && row.text.contains("白衣")
            })
            .unwrap();
        let input = input_for("Q1", &source, &batch, &prior, &json!({}), 0, 1, true, &[]);
        let mut edit = empty_edit(&source, &batch);
        edit["changes"] = json!({"assets":[{"key":asset.id,"variants":[{"key":child.id,"preparation":{"mode":"DERIVE","fromKey":asset.variants[0].id}}]}]});
        let (scope_bound,_) = apply_optimization(&edit,&source,&batch,&input,&prior,None).unwrap();
        assert_eq!(scope_bound.assets[0].metadata["sourceRefsPurpose"],"SOURCE_SCOPE");
        assert!(scope_bound.facts.is_empty(),"source scope must not create visual claims");
        edit["changes"]["assets"][0]["sourceRefs"] = json!([reference.id]);
        edit["changes"]["assets"][0]["variants"][0]["sourceRefs"] = json!([]);
        assert!(apply_optimization(&edit, &source, &batch, &input, &prior, None).is_err());
        edit["changes"]["assets"][0]["variants"][0]["sourceRefs"] = json!([reference.id]);
        let (next, _) = apply_optimization(&edit, &source, &batch, &input, &prior, None).unwrap();
        assert_eq!(next.assets[0].id, asset.id);
        assert_eq!(next.assets[0].variants[1].id, child.id);
        assert_eq!(
            next.assets[0].variants[1].metadata["preparation"]["mode"],
            "DERIVE"
        );
        assert_eq!(next.assets[0].variants[0].name, asset.variants[0].name);
        assert_eq!(next.assets[0].variants[1].scope.scenes, child.scope.scenes);
    }
    #[test]
    fn historical_dictionary_roundtrips_every_claim_neighbor_and_distinct_source_row() {
        let source = prepare_source(
            &(1..=6)
                .map(|number| {
                    format!(
                        "第{number}集\n场景：大厅\n{}小王：我没有受伤。\n",
                        "小王：我受伤了。\n△门边地面留着雨水。\n△小王右臂受伤。\n".repeat(24)
                    )
                })
                .collect::<String>(),
        )
        .unwrap();
        let episode = source.episodes.last().unwrap().id.clone();
        let batch = Batch {
            scope: vec![episode.clone()],
            pieces: whole_rows(&source, &[episode]),
            fragment: None,
        };
        let mut input = input_for(
            "F2",
            &source,
            &batch,
            &empty_foundation(&source),
            &json!({}),
            0,
            1,
            false,
            &[],
        );
        let original = input["evidence"]["historicalEvidenceCandidates"].clone();
        let table = compact_history(&original).unwrap();
        assert_eq!(table["format"], HISTORY_DICTIONARY_FORMAT);
        assert!(units(&table.to_string()) < units(&original.to_string()));
        assert_eq!(expand_history(&table).unwrap(), original);
        let candidates = original.as_array().unwrap();
        assert_eq!(table["rowCount"], candidates.len());
        assert_eq!(
            candidates
                .iter()
                .map(|row| row[0].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            candidates.len()
        );
        assert!(candidates.iter().any(
            |row| row[3].as_str().unwrap().contains("没有受伤") && row[4] == "CHARACTER_CLAIM"
        ));
        assert!(candidates
            .iter()
            .any(|row| row[5] == "SOURCE_NEIGHBOUR" && !row[6].as_array().unwrap().is_empty()));
        let before = allowed_refs(&input);
        input["evidence"]["historicalEvidenceCandidates"] = table.clone();
        assert_eq!(allowed_refs(&input), before);
        assert_eq!(
            input["evidence"]["candidateUse"],
            "HISTORICAL_EVIDENCE_ONLY"
        );
        assert_eq!(input["evidence"]["currentApplicability"], "UNKNOWN");
        let mut invalid = table.clone();
        invalid["rows"][0][6] = json!([candidates.len() + 1]);
        assert!(expand_history(&invalid).is_err());
        let mut unknown = original.clone();
        unknown[0]
            .as_array_mut()
            .unwrap()
            .push(json!("unknown metadata"));
        assert_eq!(compact_history(&unknown).unwrap(), unknown);
    }
    #[test]
    fn capacity_projection_preserves_small_request_bytes_and_rejects_indivisible_overflow() {
        let source = source(2);
        let batch = plan_batches(
            &source,
            &source
                .episodes
                .iter()
                .map(|episode| episode.id.clone())
                .collect::<Vec<_>>(),
        )
        .unwrap()
        .remove(0);
        let foundation = empty_foundation(&source);
        for stage in ["F2", "Q1"] {
            let input = input_for(
                stage,
                &source,
                &batch,
                &foundation,
                &json!({}),
                0,
                1,
                stage == "Q1",
                &[],
            );
            let schema = if stage == "F2" {
                f2_schema()
            } else {
                q1_schema()
            };
            let before = input.to_string();
            assert!(fits(stage, &input, &schema).unwrap());
            assert_eq!(
                capacity_input(stage, input, &schema).unwrap().to_string(),
                before
            );
        }
        let context = json!({"settings":{"direction":"字".repeat(REQUEST_BUDGET)}});
        assert!(preview_foundation_delivery(&source, &context)
            .unwrap_err()
            .contains("超过200k"));
    }
    #[test]
    fn light_transport_is_versioned_and_does_not_alias_the_old_evidence_inventory_request() {
        // Golden captured from the already accepted synthetic live fixture. This
        // test reads no fixture/database and performs no model call.
        let source=prepare_source("第1集\n场景：旧仓库\n△梁晨穿深蓝工作服，持有刻有‘L-17’的银色钥匙站在木门前。陈岚穿灰色风衣，站在梁晨身旁。\n梁晨：这把钥匙只能交给你。\n△梁晨把银色钥匙交给陈岚，陈岚接过收好。\n第2集\n场景：旧仓库\n△紧接上场。梁晨仍穿深蓝工作服，陈岚仍穿灰色风衣，从口袋取出同一把刻有‘L-17’的银色钥匙，打开木门。\n陈岚：钥匙没有离开我。\n△梁晨左臂受伤，袖口留下持续可见血迹；他与陈岚仍在门前等待。\n梁晨：先别走。\n").unwrap();
        let source = upgrade_source_dialogues(&source).unwrap();
        let context = json!({"settings":{"ratio":"16:9","medium":"真人","confirmedDirection":"双人交接关键钥匙的连续行动，保留原文人物、对白、服装与伤态，不补造设定。"}});
        let scope = source
            .episodes
            .iter()
            .map(|episode| episode.id.clone())
            .collect::<Vec<_>>();
        let mut pending = plan_batches(&source, &scope).unwrap();
        let (_, input) = prepare_capacity_batch(
            "F2",
            &source,
            &mut pending,
            &empty_foundation(&source),
            &context,
            0,
            &[],
        )
        .unwrap();
        let request = TextRequest {
            stage: "foundation:F2".into(),
            skill: F2_RULE.into(),
            model: "gpt-6.1-sol".into(),
            reasoning: "medium".into(),
            input,
            schema: f2_schema(),
            rule_snapshot: snapshot(F2_RULE, &[]).unwrap(),
        };
        assert_eq!(request.input["catalogueContract"],"light-catalogue/v1");
        assert_ne!(
            digest(&serde_json::to_value(request).unwrap().to_string()),
            "6198cfa2fc3aee8634dfd1fce7e84f70e53b71ad19fabca0d8c2907a405839cf"
        );
    }

    #[test]
    fn saved_real_ten_episode_catalogue_recovers_all_47_assets_without_guessing_source() {
        let fixture:Value=serde_json::from_str(include_str!("../../../reports/foundation-real-a-20261005/rejected-task.json")).unwrap();
        let source:LockedSource=serde_json::from_str(include_str!("../../../reports/foundation-real-a-20261005/source.json")).unwrap();
        let input=&fixture["snapshot"]["input"];
        let batch=Batch{scope:serde_json::from_value(input["scope"].clone()).unwrap(),pieces:whole_rows(&source,&serde_json::from_value::<Vec<String>>(input["scope"].clone()).unwrap()),fragment:None};
        let prior=empty_foundation(&source);
        assert!(apply_catalogue(&fixture["result"],&source,&batch,input,&prior,None,&HashSet::new()).unwrap_err().contains("未在本次提供"));
        let mut restored=fixture["result"].clone();
        normalize_legacy_catalogue(&mut restored,input).unwrap();
        let accepted=apply_catalogue(&restored,&source,&batch,input,&prior,None,&HashSet::new()).unwrap();
        assert_eq!(accepted.assets.len(),47);
        assert_eq!(source.sha256,fixture["result"]["sourceSha256"]);
        assert!(accepted.facts.is_empty());
        assert!(accepted.assets.iter().flat_map(|a|&a.variants).all(|v|v.metadata["sourceRefsPurpose"]=="SOURCE_SCOPE"));
        assert!(flatten_foundation_assets(&accepted).len()>=47);
        let raw=fixture["result"].clone();
        for invalid in ["row:5c086b98b4d4:14865:14915","row:5c086b98b4d4:507:512","row:000000000000:210:224"] {
            let mut damaged=raw.clone();damaged["assets"][0]["sourceRefs"]=json!([invalid]);
            assert!(normalize_legacy_catalogue(&mut damaged,input).is_err(),"invalid boundaries must not round to real rows");
            assert_eq!(damaged["assets"][0]["sourceRefs"],json!([invalid]),"failed normalization is atomic");
        }
        let second:Value=serde_json::from_str(include_str!("../../../reports/foundation-real-a-20261005/rejected-second-f2.json")).unwrap();
        assert_eq!(second["snapshot"],fixture["snapshot"]);
        let mut restored=second["result"].clone();normalize_legacy_catalogue(&mut restored,input).unwrap();
        let accepted=apply_catalogue(&restored,&source,&batch,input,&prior,None,&HashSet::new()).unwrap();
        assert_eq!(accepted.assets.len(),47);
    }

    #[test]
    fn compact_unlocated_catalogue_stays_unlocated_and_real_evidence_is_exactly_enumerated() {
        let s=source(2);let scope=s.episodes.iter().map(|e|e.id.clone()).collect::<Vec<_>>();
        let b=plan_batches(&s,&scope).unwrap().remove(0);let p=empty_foundation(&s);
        let input=input_for("F2",&s,&b,&p,&json!({}),0,1,false,&[]);
        let mut wire=empty_catalogue(&s,&b);
        wire["assets"]=json!([{"name":"小王｜默认","type":"CH","episodes":[],"sceneRefs":[],"preparation":{"mode":"REFERENCE"}}]);
        let next=apply_catalogue(&wire,&s,&b,&input,&p,None,&HashSet::new()).unwrap();
        assert!(next.assets[0].source_refs.is_empty());assert!(next.assets[0].variants[0].scope.scenes.is_empty());
        assert_eq!(next.assets[0].variants[0].scope.kind,"UNRESOLVED");
        let schema=delivery_schema("F2",&input);
        let ids=schema["$defs"]["sourceRow"]["enum"].as_array().unwrap();
        assert_eq!(ids.len(),allowed_refs(&input).len());
        assert!(ids.iter().all(|v|v.as_str().unwrap().starts_with("r:")));
        let row=&s.rows[2];let suffix=row.id.splitn(3,':').nth(2).unwrap();
        let mut reference=json!({"sourceRefs":[format!("r:{suffix}")]});
        restore_delivery_refs(&mut reference,&input).unwrap();assert_eq!(reference["sourceRefs"],json!([row.id]));
        assert!(restore_delivery_refs(&mut json!({"sourceRefs":["r:0:999999"]}),&input).is_err());
    }
    #[test]
    fn compact_profile_fits_saved_ten_episode_catalogue_in_one_editor_request() {
        let fixture:Value=serde_json::from_str(include_str!("../../../reports/foundation-real-a-20261005/rejected-task.json")).unwrap();
        let source:LockedSource=serde_json::from_str(include_str!("../../../reports/foundation-real-a-20261005/source.json")).unwrap();
        let frozen=&fixture["snapshot"]["input"];
        let scope:Vec<String>=serde_json::from_value(frozen["scope"].clone()).unwrap();
        let batch=Batch{scope:scope.clone(),pieces:whole_rows(&source,&scope),fragment:None};
        let empty=empty_foundation(&source);
        let mut raw=fixture["result"].clone();normalize_legacy_catalogue(&mut raw,frozen).unwrap();
        let prior=apply_catalogue(&raw,&source,&batch,frozen,&empty,None,&HashSet::new()).unwrap();
        let context=json!({"foundationModelInputProfile":super::super::foundation_wire::PROFILE});
        let legacy=input_for("Q1",&source,&batch,&prior,&json!({}),0,1,true,&[]);
        assert_eq!(legacy,input_for_legacy("Q1",&source,&batch,&prior,&json!({}),0,1,true,&[]));
        let compact=capacity_input("Q1",input_for("Q1",&source,&batch,&prior,&context,0,1,true,&[]),&q1_schema()).unwrap();
        assert_eq!(compact["scope"],json!(scope));
        assert_eq!(compact["source"],legacy["source"]);
        assert!(fits("Q1",&compact,&q1_schema()).unwrap());
        let (next,_)=prepare_capacity_batch("Q1",&source,&mut vec![batch],&prior,&context,0,&[]).unwrap();
        assert_eq!(next.scope.len(),10);
        assert_eq!(compact["registry"],json!([]));
        let aliases=super::super::foundation_wire::compile("Q1",&compact,&delivery_schema("Q1",&compact)).unwrap();
        let mut restored=aliases.input.clone();aliases.restore(&mut restored).unwrap();
        assert_eq!(restored["source"],compact["source"]);
        println!("10 episodes: legacy Q1={} compact exact Q1={} candidate {} -> {}, wire input={}",request_chars("Q1",&legacy,&q1_schema()).unwrap(),request_chars("Q1",&compact,&q1_schema()).unwrap(),units(&legacy["candidates"].to_string()),units(&compact["candidates"].to_string()),units(&aliases.input.to_string()));
    }
    #[test]
    fn compact_catalogue_preserves_real_evidence_and_unlocated_scope_and_existing_sources() {
        let source=source(2);let scope=source.episodes.iter().map(|e|e.id.clone()).collect::<Vec<_>>();
        let batch=Batch{scope:scope.clone(),pieces:whole_rows(&source,&scope),fragment:None};
        let input=input_for("F2",&source,&batch,&empty_foundation(&source),&json!({}),0,1,false,&[]);
        let mut raw=empty_catalogue(&source,&batch);
        raw["assets"]=json!([{"name":"小王｜默认","type":"CH","episodes":[scope[0]],"sceneRefs":[[scope[0],source.scenes[0].id]],"preparation":{"mode":"REFERENCE"},"variants":[{"name":"小王｜Q版","episodes":[],"sceneRefs":[],"preparation":{"mode":"REFERENCE","note":"既有独立制作"}}]},{"name":"未知道具","type":"PROP","episodes":[],"sceneRefs":[],"preparation":{"mode":"REFERENCE"}}]);
        let mut prior=apply_catalogue(&raw,&source,&batch,&input,&empty_foundation(&source),None,&HashSet::new()).unwrap();
        let context=json!({"foundationModelInputProfile":super::super::foundation_wire::PROFILE});
        let f2=input_for("F2",&source,&batch,&prior,&context,0,1,false,&[]);
        assert_eq!(f2["registry"][0]["variants"][1]["preparation"]["mode"],"REFERENCE");
        assert!(f2["registry"][0]["variants"][1]["fromKey"].is_null());
        let (catalogue,unlocated)=light_catalogue(&prior,&batch);
        assert!(catalogue[0].get("sourceRefs").is_none());
        assert_eq!(unlocated[0]["kind"],"VARIANT");
        assert_eq!(unlocated[0]["episodes"],json!([]));
        assert_eq!(unlocated[0]["use"],"CANDIDATE_ONLY");
        assert_eq!(unlocated[1]["kind"],"BASE");
        let a=&mut prior.assets[0];
        a.metadata.remove("sourceScope");a.metadata.insert("sourceRefsPurpose".into(),json!("VISUAL_FACT"));
        a.description="白衣的可见事实".into();
        let genuine_refs=a.source_refs.clone();
        let (catalogue,_)=light_catalogue(&prior,&batch);
        assert_eq!(catalogue[0]["sourceRefs"],json!(genuine_refs));
        assert_eq!(catalogue[0]["description"],"白衣的可见事实");
        assert_eq!(catalogue[0]["sourceRefsPurpose"],"VISUAL_FACT");
    }
    #[test]
    fn saved_real_editor_patches_base_and_exact_split_scenes_without_a_new_model_call() {
        let fixture:Value=serde_json::from_str(include_str!("../../../reports/foundation-real-a-20261005/rejected-task.json")).unwrap();
        let editor:Value=serde_json::from_str(include_str!("../../../reports/foundation-real-a-20261005/rejected-q1.json")).unwrap();
        let source:LockedSource=serde_json::from_str(include_str!("../../../reports/foundation-real-a-20261005/source.json")).unwrap();
        let input=&fixture["snapshot"]["input"];
        let scope:Vec<String>=serde_json::from_value(input["scope"].clone()).unwrap();
        let batch=Batch{scope:scope.clone(),pieces:whole_rows(&source,&scope),fragment:None};
        let mut catalogue=fixture["result"].clone();normalize_legacy_catalogue(&mut catalogue,input).unwrap();
        let prior=apply_catalogue(&catalogue,&source,&batch,input,&empty_foundation(&source),None,&HashSet::new()).unwrap();
        let mut value=editor["result"].clone();restore_delivery_refs(&mut value,&editor["snapshot"]["input"]).unwrap();
        let q_scope:Vec<String>=serde_json::from_value(editor["snapshot"]["input"]["scope"].clone()).unwrap();
        let q_batch=Batch{scope:q_scope.clone(),pieces:whole_rows(&source,&q_scope),fragment:None};
        let (mut accepted,_)=apply_optimization(&value,&source,&q_batch,&editor["snapshot"]["input"],&prior,None).unwrap();
        let final_editor:Value=serde_json::from_str(include_str!("../../../reports/foundation-real-a-20261005/rejected-q1-final.json")).unwrap();
        let final_scope:Vec<String>=serde_json::from_value(final_editor["snapshot"]["input"]["scope"].clone()).unwrap();
        let final_batch=Batch{scope:final_scope.clone(),pieces:whole_rows(&source,&final_scope),fragment:None};
        let projected=source_projection(&source,&accepted.issues,&scope).unwrap();
        let before=accepted.clone();
        let mut final_value=final_editor["result"].clone();restore_delivery_refs(&mut final_value,&final_editor["snapshot"]["input"]).unwrap();
        accepted=apply_optimization(&final_value,&projected,&final_batch,&final_editor["snapshot"]["input"],&accepted,None).unwrap().0;
        for patch in final_value["changes"]["assets"].as_array().unwrap() {
            let old=before.assets.iter().find(|a|a.id==patch["key"]).unwrap();
            let new=accepted.assets.iter().find(|a|a.id==old.id).unwrap();
            assert_eq!(old.variants.len(),new.variants.len());
            for variant in old.variants.iter().filter(|v|v.metadata.get("isBase")!=Some(&json!(true))) {
                assert_eq!(serde_json::to_value(variant).unwrap(),serde_json::to_value(new.variants.iter().find(|v|v.id==variant.id).unwrap()).unwrap(),"keyed base diff must preserve all omitted child variants");
            }
            assert!(new.variants[0].scope.scenes.iter().all(|p|!final_scope.contains(&p.episode_id)));
            assert_eq!(new.variants[0].scope.kind,"SCENES");
        }
        accepted.updated_episode_ids=scope;
        let revised=super::super::execute_foundation_scene_edits(&source,&mut accepted).unwrap().unwrap();
        assert_eq!(revised.text,source.text);assert_eq!(revised.sha256,source.sha256);
        assert_eq!(revised.scenes.len(),source.scenes.len()+6);
        assert_eq!(accepted.assets.len(),48);
        assert!(flatten_foundation_assets(&accepted).len()>=48);
        assert!(accepted.assets.iter().flat_map(|a|&a.variants).any(|v|v.scope.scenes.iter().any(|p|p.scene_id.ends_with("__L347"))));
        validate_foundation(&revised,&accepted).unwrap();
        // Without its actual split plan, the same guessed scene IDs fail closed.
        value["changes"]["sceneSplits"]=json!([]);
        assert!(apply_optimization(&value,&source,&q_batch,&editor["snapshot"]["input"],&prior,None).is_err());
    }
    #[test]
    fn new_scope_bound_identities_are_distinct_even_when_names_and_scope_match() {
        let s=source(1);let b=plan_batches(&s,&[s.episodes[0].id.clone()]).unwrap().remove(0);
        let p=empty_foundation(&s);let input=input_for("F2",&s,&b,&p,&json!({}),0,1,false,&[]);
        let mut wire=empty_catalogue(&s,&b);
        let asset=json!({"name":"小王｜默认","type":"CH","episodes":b.scope,"sceneRefs":[[s.episodes[0].id,s.scenes[0].id]],"preparation":{"mode":"REFERENCE"}});
        wire["assets"]=json!([asset,asset]);
        let next=apply_catalogue(&wire,&s,&b,&input,&p,None,&HashSet::new()).unwrap();
        assert_ne!(next.assets[0].id,next.assets[1].id);
        wire["assets"][0]["episodes"]=json!([]);wire["assets"][0]["sceneRefs"]=json!([]);
        wire["assets"][1]=wire["assets"][0].clone();
        let next=apply_catalogue(&wire,&s,&b,&input,&p,None,&HashSet::new()).unwrap();
        assert_ne!(next.assets[0].id,next.assets[1].id);
        assert!(next.assets.iter().all(|a|a.source_refs.is_empty()));
    }
    #[test]
    fn explicit_global_catalogue_requires_actually_supplied_author_rule_and_reason() {
        let make=|s:&LockedSource| {
            let b=plan_batches(s,&[s.episodes[0].id.clone()]).unwrap().remove(0);
            let p=empty_foundation(s);let input=input_for("F2",s,&b,&p,&json!({}),0,1,false,&[]);
            let mut wire=empty_catalogue(s,&b);
            wire["assets"]=json!([{"name":"校徽","type":"PROP","episodes":[],"sceneRefs":[],"preparation":{"mode":"REFERENCE"},"scope":{"kind":"GLOBAL","reason":"作者明确规定全校统一"}}]);
            (b,p,input,wire)
        };
        let s=prepare_source("【世界观设定】\n世界规则：全校校徽为同一形制。\n第1集\n场景：教室\n小王：我见过校徽。\n").unwrap();
        let (b,p,input,wire)=make(&s);
        let next=apply_catalogue(&wire,&s,&b,&input,&p,None,&HashSet::new()).unwrap();
        assert_eq!(next.assets[0].variants[0].scope.kind,"GLOBAL");
        assert!(next.assets[0].source_refs.iter().all(|id|s.rows.iter().any(|r|&r.id==id&&r.kind=="context")));
        assert!(next.facts.is_empty());
        let mut missing=wire.clone();missing["assets"][0]["scope"]["reason"]=json!("");
        assert!(apply_catalogue(&missing,&s,&b,&input,&p,None,&HashSet::new()).is_err());
        let no_rule=prepare_source("【人物小传】\n人物简介：小王见过校徽。\n第1集\n场景：教室\n小王：我见过校徽。\n").unwrap();
        let (b,p,input,wire)=make(&no_rule);
        assert!(apply_catalogue(&wire,&no_rule,&b,&input,&p,None,&HashSet::new()).is_err());
    }
    #[tokio::test]
    async fn eighty_episode_mock_execution_keeps_capacity_tails_packed_and_exactly_once() {
        eighty_episode_mock(false).await;
    }
    #[tokio::test]
    async fn compact_eighty_episode_mock_preserves_original_dependency_and_source_boundaries() {
        eighty_episode_mock(true).await;
    }
    async fn eighty_episode_mock(compact: bool) {
        let started=std::time::Instant::now();
        let context=if compact {json!({"foundationModelInputProfile":super::super::foundation_wire::PROFILE})} else {json!({})};
        let source = prepare_source(
            &(1..=80)
                .map(|number| {
                    format!(
                        "第{number}集\n场景：旧仓库\n{}\n梁晨：钥匙在这里。\n",
                        "△梁晨穿深色夹克站在仓库门口，陈岚检查门锁，钥匙的齿纹保持一致。\n"
                            .repeat(24)
                    )
                })
                .collect::<String>(),
        )
        .unwrap();
        let counter = Counter {
            requests: Mutex::new(vec![]),
        };
        let output =
            run_foundation_delivery(&source, &context, &counter, "gpt-6.1-sol", "medium")
                .await
                .unwrap();
        assert_eq!(output.updated_episode_ids.len(), 80);
        let requests = counter.requests.lock().unwrap();
        let all = source
            .episodes
            .iter()
            .map(|episode| json!(episode.id))
            .collect::<Vec<_>>();
        for stage in ["foundation:F2", "foundation:Q1"] {
            let calls = requests
                .iter()
                .filter(|request| request.stage == stage)
                .collect::<Vec<_>>();
            assert!(
                !calls.is_empty() && calls.len() < 10,
                "capacity tails were not packed: {stage} {} calls",
                calls.len()
            );
            assert!(
                calls
                    .iter()
                    .all(|request| request.input["scope"].as_array().unwrap().len() > 1),
                "a singleton tail must join the next fitting capacity batch"
            );
            let scopes = calls
                .iter()
                .flat_map(|request| request.input["scope"].as_array().unwrap())
                .cloned()
                .collect::<Vec<_>>();
            assert_eq!(
                scopes, all,
                "source episode coverage/order must stay exactly once for {stage}"
            );
            let raw_rows = calls
                .iter()
                .flat_map(|request| request.input["source"]["rows"].as_array().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(
                raw_rows.len(),
                source
                    .rows
                    .iter()
                    .filter(|row| row.episode_id.is_some())
                    .count()
            );
            assert_eq!(
                raw_rows
                    .iter()
                    .map(|row| row[0].as_str().unwrap())
                    .collect::<HashSet<_>>()
                    .len(),
                raw_rows.len()
            );
            for request in calls {
                assert!(fits(
                    stage.rsplit(':').next().unwrap(),
                    &request.input,
                    &request.schema
                )
                .unwrap());
                assert!(request.input["delivery"]["fragment"].is_null());
                for row in request.input["source"]["rows"].as_array().unwrap() {
                    let original = source
                        .rows
                        .iter()
                        .find(|original| original.id == row[0])
                        .unwrap();
                    assert_eq!(row[9], original.text);
                }
            }
        }
        let preview = preview_foundation_delivery(&source, &context).unwrap();
        assert_eq!(
            preview["f2PlannedCalls"],
            requests
                .iter()
                .filter(|request| request.stage == "foundation:F2")
                .count()
        );
        assert_eq!(
            preview["q1MinimumCalls"],
            requests
                .iter()
                .filter(|request| request.stage == "foundation:Q1")
                .count()
        );
        if let Ok(path)=std::env::var("DIRECTOR_TEST_80_REPORT") {
            let path=std::path::PathBuf::from(path);assert!(path.is_absolute());
            let report=json!({"ok":true,"mock":true,"realModelCalls":0,"episodes":80,"sourceCharacters":units(&source.text),"elapsedMilliseconds":started.elapsed().as_millis(),"profile":if cfg!(debug_assertions){"debug"}else{"release"},"modelInputProfile":context["foundationModelInputProfile"],"calls":requests.iter().map(|r|json!({"stage":r.stage,"episodeCount":r.input["scope"].as_array().unwrap().len(),"scope":r.input["scope"],"requestCharacters":request_chars(r.stage.rsplit(':').next().unwrap(),&r.input,&r.schema).unwrap(),"withinBudget":fits(r.stage.rsplit(':').next().unwrap(),&r.input,&r.schema).unwrap()})).collect::<Vec<_>>(),"preview":preview,"sourceExactlyOnce":true});
            std::fs::write(path,serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        }
    }
    #[test]
    fn scoped_program_split_cannot_be_marked_as_already_published() {
        let s = prepare_source("第1集\n场景：大厅\n小王：开始。\n△小王走到门外。\n小王：走。\n")
            .unwrap();
        let batch = plan_batches(&s, &[s.episodes[0].id.clone()])
            .unwrap()
            .remove(0);
        let p = empty_foundation(&s);
        let row = s.rows.iter().find(|r| r.text.contains("走到门外")).unwrap();
        let input = input_for("Q1", &s, &batch, &p, &json!({}), 0, 1, true, &[]);
        let mut wire = empty_edit(&s, &batch);
        wire["changes"] = json!({"sceneSplits":[{"episodeId":s.episodes[0].id,"sceneId":s.scenes[0].id,"cuts":[{"rowId":row.id,"anchor":row.text.trim_end_matches(['\r','\n'])}]}]});
        let (next, _) = apply_optimization(&wire, &s, &batch, &input, &p, None).unwrap();
        assert_eq!(next.issues[0].details.as_ref().unwrap()["owner"], "PROGRAM");
        assert!(!next.issues[0].blocking);
        assert_eq!(s.scenes.len(), 1);
        let mut receipt = empty_edit(&s, &batch);
        receipt["resolvedIssues"] = json!([next.issues[0].coordinate]);
        assert!(apply_optimization(&receipt, &s, &batch, &input, &next, None).is_err());
    }
    struct AcceptedCache {
        calls: Mutex<usize>,
        accepted: Mutex<HashMap<String, Value>>,
    }
    #[async_trait]
    impl TextExecutor for AcceptedCache {
        async fn execute(&self, request: TextRequest) -> Result<Value, String> {
            let key = digest(&serde_json::to_string(&request).unwrap());
            if let Some(value) = self.accepted.lock().unwrap().get(&key) {
                return Ok(value.clone());
            }
            *self.calls.lock().unwrap() += 1;
            Ok(if request.stage == "foundation:F2" {
                let row = request.input["source"]["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row[9].as_str().unwrap().contains("白衣"))
                    .unwrap();
                json!({"format":"ASSET_CATALOG_DESKTOP_V2","sourceSha256":request.input["sourceSha256"],"coverage":request.input["scope"],"assets":[{"name":"小王｜白衣","type":"CH","episodes":[row[2]],"sceneRefs":[[row[2],row[3]]],"sourceRefs":[row[0]],"role":"主角","preparation":{"mode":"REFERENCE"}}]})
            } else {
                json!({"format":"ASSET_OPTIMIZATION_DESKTOP_V2","sourceSha256":request.input["sourceSha256"],"coverage":request.input["scope"],"changes":{}})
            })
        }
        async fn accept(&self, request: &TextRequest, value: &Value) -> Result<(), String> {
            self.accepted.lock().unwrap().insert(
                digest(&serde_json::to_string(request).unwrap()),
                value.clone(),
            );
            Ok(())
        }
    }
    #[tokio::test]
    async fn exact_accepted_requests_replay_without_another_generation() {
        let s = source(10);
        let cache = AcceptedCache {
            calls: Mutex::new(0),
            accepted: Mutex::new(HashMap::new()),
        };
        let a = run_foundation_delivery(&s, &json!({}), &cache, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        let b = run_foundation_delivery(&s, &json!({}), &cache, "gpt-6.1-sol", "medium")
            .await
            .unwrap();
        assert_eq!(*cache.calls.lock().unwrap(), 2);
        assert_eq!(a.assets.len(), 1);
        assert_eq!(
            serde_json::to_value(a).unwrap(),
            serde_json::to_value(b).unwrap()
        );
        let preview = preview_foundation_delivery(&s, &json!({})).unwrap();
        assert_eq!(preview["f2PlannedCalls"], 1);
        assert_eq!(preview["q1MinimumCalls"], 1);
        assert_eq!(preview["sourceCoverageVerified"], true);
    }
    #[test]
    fn complete_choice_is_preserved_but_production_note_never_blocks() {
        let s = source(2);
        let batch = plan_batches(
            &s,
            &s.episodes.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
        )
        .unwrap()
        .remove(0);
        let p = empty_foundation(&s);
        let input = input_for("Q1", &s, &batch, &p, &json!({}), 0, 1, true, &[]);
        let refs = s
            .rows
            .iter()
            .filter(|r| r.text.contains("白衣"))
            .map(|r| r.id.clone())
            .collect::<Vec<_>>();
        let choice = json!({"decisionKey":"costume/conflict","kind":"SOURCE_CONFLICT","question":"冲突服装采用哪一份？","reason":"两处原文声明冲突","options":["保留前稿","保留后稿"],"recommended":"保留前稿","recommendationReason":"保留前稿来源","evidence":"两份锁定原句","episodes":batch.scope,"sourceRefs":refs,"changeTargets":{"assetKeys":[],"assetFields":[],"sceneFields":["characters"]}});
        let mut wire = empty_edit(&s, &batch);
        wire["humanChoices"] = json!([choice.clone()]);
        wire["notes"] = json!(["动作与表演交第三阶段处理"]);
        let (next, _) = apply_optimization(&wire, &s, &batch, &input, &p, None).unwrap();
        let issue = next
            .issues
            .iter()
            .find(|issue| issue.coordinate == "choice:costume/conflict")
            .unwrap();
        assert!(issue.blocking);
        assert_eq!(issue.details.as_ref().unwrap()["choice"], choice);
        assert_eq!(
            issue.details.as_ref().unwrap()["recommendedIsAdopted"],
            false
        );
        assert!(next
            .issues
            .iter()
            .filter(|issue| issue.coordinate.starts_with("note:"))
            .all(|issue| !issue.blocking));
    }
}
