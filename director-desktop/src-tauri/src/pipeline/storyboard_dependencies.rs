//! Source-owned dependency exits from the original Stage 3 handoff contract.
//!
//! The old `runtime/storyboard-v4/core/pipeline.mjs:64-75` sends one six-field
//! exit per external package, not that package's complete adopted draft. Its
//! separate `acceptedContinuity` input still carries the full accepted unit.
//! This projection must be enabled only by a new frozen workflow profile;
//! historical unmarked requests keep their original input and cache identity.

use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

pub(crate) const PROFILE: &str = "dependency-exit/v1";
pub(crate) const PROFILE_FIELD: &str = "storyboardDependencyInputProfile";

pub(crate) fn uses_profile(input: &Value) -> Result<bool, String> {
    match input.get(PROFILE_FIELD) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::String(profile)) if profile == PROFILE => Ok(true),
        _ => Err("分镜依赖出口输入版本未知；原快照和缓存已保留，未派发模型请求".into()),
    }
}

/// Project external dependencies for the current author group.
///
/// `source_row_ids` is the frozen source order, not draft completion order.
/// `accepted_outputs` contains only domain-accepted drafts, keyed by their
/// exact owning package ID; an owner may have multiple execution batches.
/// A joint draft may therefore occur under several owner IDs. Only shots whose
/// sourceRefs intersect the dependency owner's refs determine its final unit.
/// Tied source ranks retain accepted unit order, as in the old stable JS sort
/// (two consecutive fragments may legitimately own the same source row).
///
/// No source text or creative state is rewritten. All six handoff fields are
/// copied verbatim. Extra unit/draft fields stay in the accepted draft and the
/// independent full acceptedContinuity packet; they are not dependency exits.
pub(crate) fn project(
    plan: &Value,
    current_package_ids: &[String],
    source_row_ids: &[String],
    accepted_outputs: &[(String, Value)],
) -> Result<Value, String> {
    let packages = plan
        .get("workPackages")
        .and_then(Value::as_array)
        .ok_or("分镜依赖出口缺少冻结工作包目录")?;
    let mut by_id = HashMap::new();
    for package in packages {
        let id = nonempty_string(package, "id", "冻结工作包")?;
        if by_id.insert(id, package).is_some() {
            return Err(format!("分镜依赖出口工作包身份重复：{id}"));
        }
    }

    // Match the old ordered Set: first declared external dependency wins its
    // position. In-group dependencies are written in the current call itself.
    let current: HashSet<_> = current_package_ids.iter().map(String::as_str).collect();
    let mut seen = HashSet::new();
    let mut external = Vec::new();
    for id in current_package_ids {
        let owner = by_id
            .get(id.as_str())
            .ok_or_else(|| format!("分镜依赖出口当前工作包不存在：{id}"))?;
        for dependency in string_array(owner, "dependsOn", "冻结工作包")? {
            if !current.contains(dependency) && seen.insert(dependency) {
                external.push(dependency);
            }
        }
    }
    if external.is_empty() {
        return Ok(Value::Object(Map::new()));
    }

    let mut rank = HashMap::new();
    for (position, id) in source_row_ids.iter().enumerate() {
        if id.is_empty() || rank.insert(id.as_str(), position).is_some() {
            return Err("分镜依赖出口冻结原文行身份为空或重复".into());
        }
    }
    let mut exits = Map::new();
    for dependency in external {
        let owner = by_id
            .get(dependency)
            .ok_or_else(|| format!("分镜依赖出口引用未知工作包：{dependency}"))?;
        let owned_refs: HashSet<_> = string_array(owner, "sourceRefs", "依赖工作包")?
            .into_iter()
            .collect();
        if owned_refs.is_empty() {
            return Err(format!("依赖工作包{dependency}没有冻结制作源引用"));
        }
        for reference in &owned_refs {
            if !rank.contains_key(reference) {
                return Err(format!("依赖工作包{dependency}引用未知冻结原文行"));
            }
        }

        let mut last: Option<(&Value, usize)> = None;
        for (_, draft) in accepted_outputs.iter().filter(|(id, _)| id == dependency) {
            let units = draft
                .get("units")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("依赖工作包{dependency}缺少已采用完整单元"))?;
            for unit in units {
                let shots = unit
                    .get("shots")
                    .and_then(Value::as_array)
                    .ok_or_else(|| format!("依赖工作包{dependency}已采用单元缺少镜头"))?;
                let mut owned_rank = None;
                for shot in shots {
                    for reference in string_array(shot, "sourceRefs", "已采用镜头")? {
                        if owned_refs.contains(reference) {
                            // Exact owner/source intersection is the sole
                            // selector. A later shot from another package must
                            // not shift this dependency's exit to that package.
                            let position = rank[reference];
                            owned_rank = Some(
                                owned_rank.map_or(position, |prior: usize| prior.max(position)),
                            );
                        }
                    }
                }
                if let Some(position) = owned_rank {
                    if last.map_or(true, |(_, prior)| position >= prior) {
                        last = Some((unit, position));
                    }
                }
            }
        }
        let (unit, _) =
            last.ok_or_else(|| format!("依赖工作包{dependency}缺少可定位的出口单元"))?;
        let unit_id = nonempty_string(unit, "id", "已采用出口单元")?;
        let mut exit = Map::new();
        exit.insert("unitId".into(), Value::String(unit_id.into()));
        for field in ["scene", "lighting", "props", "participants", "exitState"] {
            let value = unit
                .get(field)
                .ok_or_else(|| format!("依赖工作包{dependency}出口单元缺少{field}"))?;
            let valid = if matches!(field, "props" | "participants") {
                value
                    .as_array()
                    .map(|items| items.iter().all(Value::is_string))
                    .unwrap_or(false)
            } else {
                value.is_string()
            };
            if !valid {
                return Err(format!("依赖工作包{dependency}出口单元{field}类型不合法"));
            }
            exit.insert(field.into(), value.clone());
        }
        exits.insert(dependency.into(), Value::Object(exit));
    }
    Ok(Value::Object(exits))
}

fn nonempty_string<'a>(value: &'a Value, field: &str, subject: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("{subject}{field}身份为空或类型不合法"))
}

fn string_array<'a>(value: &'a Value, field: &str, subject: &str) -> Result<Vec<&'a str>, String> {
    value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{subject}{field}必须为精确身份数组"))?
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|text| !text.is_empty())
                .ok_or_else(|| format!("{subject}{field}身份为空或类型不合法"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ids(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).into()).collect()
    }

    fn owner(id: &str, refs: &[&str], dependencies: &[&str]) -> Value {
        json!({"id":id,"sourceRefs":refs,"dependsOn":dependencies})
    }

    fn unit(id: &str, refs: &[&str], state: &str) -> Value {
        json!({
            "id":id,
            "scene":"乌云下的屋顶（东侧栏杆）。",
            "lighting":"冷光从左后方切入；火把仍在右侧。",
            "props":["手杖","未点燃的灯"],
            "participants":["小王·白衣","小王·黑衣"],
            "exitState":state,
            "sourceRefs":["TOP_LEVEL_IS_NOT_AN_OWNERSHIP_SELECTOR"],
            "shots":[{"id":format!("{id}:shot"),"sourceRefs":refs,
                "picture":"完整已采用动作和视线不在出口包重抄。",
                "dialogueParts":[{"text":"e1：别动。"}]}],
            "initialState":"原起态不属于旧六字段依赖出口。",
            "imagePrompt":"禁止进入分镜依赖输入的图片提示词",
            "history":["禁止进入依赖输入的历史"],
            "unknownFutureMetadata":{"keepInCanonicalDraft":true}
        })
    }

    #[test]
    fn exact_six_fields_preserve_state_identity_and_leave_canonical_inputs_untouched() {
        let plan =
            json!({"workPackages":[owner("p1", &["r1"], &[]),owner("p2", &["r2"], &["p1"])]});
        let upstream = unit(
            "p1:u1",
            &["r1"],
            "左脚仍踩栏杆；右手握杖，视线停在门口。\n停步，不转身。",
        );
        let accepted = vec![(
            "p1".into(),
            json!({"units":[upstream],"history":["private"]}),
        )];
        let before = (plan.clone(), accepted.clone());
        let projected = project(&plan, &ids(&["p2"]), &ids(&["r1", "r2"]), &accepted).unwrap();
        assert_eq!(projected["p1"]["unitId"], "p1:u1");
        for field in ["scene", "lighting", "props", "participants", "exitState"] {
            assert_eq!(projected["p1"][field], accepted[0].1["units"][0][field]);
        }
        assert_eq!(projected["p1"].as_object().unwrap().len(), 6);
        assert!(!projected.to_string().contains("imagePrompt"));
        assert!(!projected.to_string().contains("dialogueParts"));
        assert!(!projected.to_string().contains("unknownFutureMetadata"));
        assert_eq!((plan, accepted), before);
    }

    #[test]
    fn joint_group_exit_excludes_later_units_owned_only_by_another_package() {
        // Mirrors old pipeline.test.mjs:52, including a unit crossing owners.
        let plan = json!({"workPackages":[owner("p1", &["r1"], &[]),owner("p2", &["r2"], &[]),owner("p3", &["r3"], &["p1"])]});
        let joint = unit("joint-u", &["r1", "r2"], "甲在冷光中停住。");
        let mut later = unit("p2-later", &["r2"], "乙走入日光。");
        later["lighting"] = json!("日光");
        let draft = json!({"units":[joint,later]});
        let accepted = vec![("p1".into(), draft.clone()), ("p2".into(), draft)];
        let result = project(&plan, &ids(&["p3"]), &ids(&["r1", "r2", "r3"]), &accepted).unwrap();
        assert_eq!(result["p1"]["unitId"], "joint-u");
        assert!(!result.to_string().contains("日光"));
        assert!(result.get("p2").is_none());
    }

    #[test]
    fn exit_uses_owned_source_order_across_execution_batches_not_completion_or_foreign_refs() {
        let plan =
            json!({"workPackages":[owner("p1", &["r1","r2"], &[]),owner("p2", &["r3"], &["p1"])]});
        // Completion/list order is deliberately reversed. The foreign late
        // row in the earlier unit cannot outrank p1's real last owned row.
        let accepted = vec![
            (
                "p1".into(),
                json!({"units":[unit("p1:later", &["r2"], "真实末态")]}),
            ),
            (
                "p1".into(),
                json!({"units":[unit("p1:earlier", &["r1","r9"], "较早状态")]}),
            ),
        ];
        let result = project(
            &plan,
            &ids(&["p2"]),
            &ids(&["r1", "r2", "r3", "r9"]),
            &accepted,
        )
        .unwrap();
        assert_eq!(result["p1"]["unitId"], "p1:later");
        assert_eq!(result["p1"]["exitState"], "真实末态");
    }

    #[test]
    fn fragments_of_one_source_row_keep_stable_adopted_unit_order() {
        let plan =
            json!({"workPackages":[owner("p1", &["r1"], &[]),owner("p2", &["r2"], &["p1"])]});
        let accepted = vec![(
            "p1".into(),
            json!({"units":[unit("p1:first", &["r1"], "一句台词前半"),unit("p1:second", &["r1"], "一句台词后半的末态")]}),
        )];
        let result = project(&plan, &ids(&["p2"]), &ids(&["r1", "r2"]), &accepted).unwrap();
        assert_eq!(result["p1"]["unitId"], "p1:second");
    }

    #[test]
    fn exact_package_identity_multiple_dependencies_and_internal_exclusion() {
        let plan = json!({"workPackages":[
            owner("same-name-a", &["r1"], &[]),owner("same-name-b", &["r2"], &[]),
            owner("current-a", &["r3"], &["same-name-a","current-b","same-name-a"]),
            owner("current-b", &["r4"], &["same-name-b"])
        ]});
        let accepted = vec![
            (
                "same-name-a".into(),
                json!({"units":[unit("a:exit", &["r1"], "甲仍握杖")]}),
            ),
            (
                "same-name-b".into(),
                json!({"units":[unit("b:exit", &["r2"], "乙已经放杖")]}),
            ),
        ];
        let result = project(
            &plan,
            &ids(&["current-a", "current-b"]),
            &ids(&["r1", "r2", "r3", "r4"]),
            &accepted,
        )
        .unwrap();
        assert_eq!(result.as_object().unwrap().len(), 2);
        assert_eq!(result["same-name-a"]["exitState"], "甲仍握杖");
        assert_eq!(result["same-name-b"]["exitState"], "乙已经放杖");
        assert!(result.get("current-b").is_none());
    }

    #[test]
    fn missing_or_unowned_exit_never_falls_back_to_name_tail_or_top_level_refs() {
        let plan =
            json!({"workPackages":[owner("p1", &["r1"], &[]),owner("p2", &["r2"], &["p1"])]});
        let source = ids(&["r1", "r2"]);
        assert!(project(&plan, &ids(&["p2"]), &source, &[])
            .unwrap_err()
            .contains("缺少可定位"));
        let mut wrong = unit("looks-like-p1", &["r2"], "不能冒充p1");
        wrong["sourceRefs"] = json!(["r1"]);
        let accepted = vec![("p1".into(), json!({"units":[wrong]}))];
        assert!(project(&plan, &ids(&["p2"]), &source, &accepted)
            .unwrap_err()
            .contains("缺少可定位"));
        let mismatched = vec![(
            "different-p1".into(),
            json!({"units":[unit("p1:u", &["r1"], "真源但错包")]}),
        )];
        assert!(project(&plan, &ids(&["p2"]), &source, &mismatched).is_err());
    }

    #[test]
    fn malformed_or_unknown_frozen_identity_fails_closed() {
        let plan =
            json!({"workPackages":[owner("p1", &["r1"], &[]),owner("p2", &["r2"], &["p1"])]});
        let accepted = vec![(
            "p1".into(),
            json!({"units":[unit("p1:u", &["r1"], "末态")]}),
        )];
        assert!(project(&plan, &ids(&["p2"]), &ids(&["r2"]), &accepted)
            .unwrap_err()
            .contains("未知冻结原文行"));
        assert!(
            project(&plan, &ids(&["p2"]), &ids(&["r1", "r1", "r2"]), &accepted)
                .unwrap_err()
                .contains("为空或重复")
        );
        assert!(project(
            &plan,
            &ids(&["not-a-package"]),
            &ids(&["r1", "r2"]),
            &accepted
        )
        .is_err());
        let mut duplicate = plan.clone();
        duplicate["workPackages"]
            .as_array_mut()
            .unwrap()
            .push(owner("p1", &["r2"], &[]));
        assert!(
            project(&duplicate, &ids(&["p2"]), &ids(&["r1", "r2"]), &accepted)
                .unwrap_err()
                .contains("身份重复")
        );
        let mut malformed = accepted.clone();
        malformed[0].1["units"][0]["shots"][0]["sourceRefs"] = json!([7]);
        assert!(project(&plan, &ids(&["p2"]), &ids(&["r1", "r2"]), &malformed).is_err());
        malformed = accepted.clone();
        malformed[0].1["units"][0]
            .as_object_mut()
            .unwrap()
            .remove("lighting");
        assert!(
            project(&plan, &ids(&["p2"]), &ids(&["r1", "r2"]), &malformed)
                .unwrap_err()
                .contains("缺少lighting")
        );
    }

    #[test]
    fn new_marker_is_explicit_and_historical_marker_absence_remains_legacy() {
        assert!(!uses_profile(&json!({})).unwrap());
        assert!(!uses_profile(&json!({PROFILE_FIELD:null})).unwrap());
        assert!(uses_profile(&json!({PROFILE_FIELD:PROFILE})).unwrap());
        assert!(uses_profile(&json!({PROFILE_FIELD:"dependency-exit/v999"})).is_err());
        assert!(uses_profile(&json!({PROFILE_FIELD:7})).is_err());
        let plan = json!({"workPackages":[owner("p1", &["r1"], &[])]});
        assert_eq!(project(&plan, &ids(&["p1"]), &[], &[]).unwrap(), json!({}));
    }
}
