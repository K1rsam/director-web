//! Lossless local references for repeated, complete output-schema nodes.
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

fn node(value: &Value) -> Option<String> {
    let map = value.as_object()?;
    // A properties map, defaults or arbitrary data are not schema positions.
    // Complete constraints stay in the definition, including descriptions,
    // item limits, required fields and additionalProperties.
    (map.contains_key("type")
        || map.contains_key("anyOf")
        || map.contains_key("oneOf")
        || map.contains_key("allOf")
        || map.contains_key("enum")
        || map.contains_key("const"))
    .then(|| value.to_string())
}

pub(super) fn project(schema: &Value) -> Value {
    fn scan(value: &Value, counts: &mut BTreeMap<String, usize>, reserved: &mut bool) {
        if let Some(map) = value.as_object() {
            *reserved |= map.contains_key("$defs") || map.contains_key("$ref");
            // Arbitrary literal JSON in these annotations is not a nested
            // schema. Keep the entire schema untouched rather than interpreting
            // a default/example/enum value that happens to contain `type`.
            *reserved |= map.contains_key("default")
                || map.contains_key("examples")
                || map
                    .get("const")
                    .is_some_and(|value| value.is_object() || value.is_array())
                || map
                    .get("enum")
                    .and_then(Value::as_array)
                    .is_some_and(|items| {
                        items
                            .iter()
                            .any(|value| value.is_object() || value.is_array())
                    });
        }
        if let Some(key) = node(value) {
            *counts.entry(key).or_default() += 1;
        }
        match value {
            Value::Object(map) => {
                for item in map.values() {
                    scan(item, counts, reserved);
                }
            }
            Value::Array(items) => {
                for item in items {
                    scan(item, counts, reserved);
                }
            }
            _ => {}
        }
    }
    let mut counts = BTreeMap::new();
    let mut reserved = false;
    scan(schema, &mut counts, &mut reserved);
    if reserved {
        return schema.clone();
    }
    let mut names = BTreeMap::new();
    let mut definitions = Map::new();
    for (key, count) in counts {
        let name = format!("enum{}", names.len() + 1);
        let reference = json!({"$ref":format!("#/$defs/{name}")}).to_string();
        let chars = key.encode_utf16().count();
        let cost = json!(name).to_string().encode_utf16().count() + 1 + chars + 1;
        if count < 2
            || chars < 100
            || count * chars <= count * reference.encode_utf16().count() + cost
        {
            continue;
        }
        definitions.insert(name.clone(), serde_json::from_str(&key).unwrap());
        names.insert(key, name);
    }
    if names.is_empty() {
        return schema.clone();
    }
    fn visit(value: &Value, names: &BTreeMap<String, String>) -> Value {
        if let Some(name) = node(value).and_then(|key| names.get(&key)) {
            return json!({"$ref":format!("#/$defs/{name}")});
        }
        match value {
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, item)| (key.clone(), visit(item, names)))
                    .collect(),
            ),
            Value::Array(items) => Value::Array(items.iter().map(|v| visit(v, names)).collect()),
            _ => value.clone(),
        }
    }
    let mut projected = visit(schema, &names);
    // An outer repeated node can subsume repeated children. Do not charge the
    // request for unused child definitions; definitions themselves stay full,
    // with no chained references.
    fn used(value: &Value, names: &mut Vec<String>) {
        if let Some(reference) = value.get("$ref").and_then(Value::as_str) {
            if let Some(name) = reference.strip_prefix("#/$defs/") {
                if !names.iter().any(|old| old == name) {
                    names.push(name.into());
                }
            }
        }
        match value {
            Value::Object(map) => map.values().for_each(|value| used(value, names)),
            Value::Array(items) => items.iter().for_each(|value| used(value, names)),
            _ => {}
        }
    }
    let mut referenced = Vec::new();
    used(&projected, &mut referenced);
    definitions.retain(|name, _| referenced.contains(name));
    projected["$defs"] = Value::Object(definitions);
    if projected.to_string().encode_utf16().count() < schema.to_string().encode_utf16().count() {
        projected
    } else {
        schema.clone()
    }
}

pub(super) fn expand(schema: &Value) -> Result<Value, String> {
    if schema.get("$defs").is_none() {
        return Ok(schema.clone());
    }
    fn visit(value: &Value, schema: &Value) -> Result<Value, String> {
        if let Some(map) = value.as_object() {
            if let Some(reference) = map.get("$ref") {
                if map.len() != 1 {
                    return Err("整编共享schema引用含额外约束".into());
                }
                let target = reference
                    .as_str()
                    .and_then(|s| s.strip_prefix("#/$defs/"))
                    .ok_or("整编共享schema引用不是本地定义")?;
                let definition = schema["$defs"]
                    .get(target)
                    .ok_or("整编共享schema定义缺失")?;
                if node(definition).is_none() {
                    return Err("整编共享schema目标不是完整约束节点".into());
                }
                return Ok(definition.clone());
            }
            return Ok(Value::Object(
                map.iter()
                    .filter(|(key, _)| *key != "$defs")
                    .map(|(key, item)| Ok((key.clone(), visit(item, schema)?)))
                    .collect::<Result<_, String>>()?,
            ));
        }
        match value {
            Value::Array(items) => Ok(Value::Array(
                items
                    .iter()
                    .map(|v| visit(v, schema))
                    .collect::<Result<_, _>>()?,
            )),
            _ => Ok(value.clone()),
        }
    }
    visit(schema, schema)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_exact_repeated_string_enums_share_with_order_and_extra_constraints_preserved() {
        let ids: Vec<_> = (0..16)
            .map(|i| format!("canonical-coordinate-long-{i}"))
            .collect();
        let mut reversed = ids.clone();
        reversed.reverse();
        let enumeration = json!({"type":"string","enum":ids});
        let schema = json!({"type":"object","properties":{"first":{"type":"array","items":enumeration.clone()},"second":enumeration,"reversed":{"type":"string","enum":reversed},"guarded":{"type":"string","enum":ids,"description":"此独有约束不能丢失"}},"required":["first","second"],"additionalProperties":false});
        let before = schema.clone();
        let projected = project(&schema);
        assert!(projected["$defs"].is_object());
        assert_eq!(expand(&projected).unwrap(), schema);
        assert_eq!(schema, before);
        assert_eq!(
            projected["properties"]["reversed"],
            schema["properties"]["reversed"]
        );
        assert_eq!(
            projected["properties"]["guarded"],
            schema["properties"]["guarded"]
        );
    }
    #[test]
    fn existing_definitions_references_small_or_single_enums_remain_exact() {
        let literal = json!({"type":"object","properties":{"id":{"type":"string","description":"这是数据字面量，不是新schema。".repeat(60)}},"required":["id"]});
        for schema in [
            json!({"type":"string","enum":["yes","no"]}),
            json!({"$defs":{"existing":{"type":"string","enum":["keep"]}},"type":"object"}),
            json!({"type":"object","properties":{"a":{"$ref":"#"}}}),
            json!({"type":"object","properties":{"a":{"type":"object","default":literal.clone()},"b":{"type":"object","default":literal.clone()}}}),
            json!({"type":"object","examples":[literal.clone(),literal.clone()]}),
            json!({"type":"object","properties":{"a":{"const":literal.clone()},"b":{"const":literal.clone()}}}),
            json!({"enum":[literal.clone(),literal]}),
        ] {
            assert_eq!(project(&schema), schema);
        }
    }

    #[test]
    fn complete_repeated_objects_share_every_constraint_without_chained_definitions() {
        let labels: Vec<_> = (0..24)
            .map(|i| format!("source-coordinate-long-{i}"))
            .collect();
        let item = json!({"type":"object","properties":{"id":{"type":"string","enum":labels},"note":{"type":"string","description":"完整创作约束。".repeat(80)}},"required":["id","note"],"additionalProperties":false});
        let list = json!({"type":"array","items":item,"minItems":1,"maxItems":24,"description":"完整范围不能裁剪"});
        let schema = json!({"type":"object","properties":{"first":list.clone(),"second":list.clone(),"different":{"type":"array","items":list["items"],"minItems":2,"maxItems":24}},"required":["first","second","different"],"additionalProperties":false});
        let projected = project(&schema);
        assert!(projected["properties"]["first"].get("$ref").is_some());
        assert_eq!(
            projected["properties"]["first"],
            projected["properties"]["second"]
        );
        assert_eq!(projected["properties"]["different"]["minItems"], 2);
        assert_eq!(expand(&projected).unwrap(), schema);
        assert!(projected.to_string().len() < schema.to_string().len());
        fn has_ref(value: &Value) -> bool {
            match value {
                Value::Object(map) => map.contains_key("$ref") || map.values().any(has_ref),
                Value::Array(items) => items.iter().any(has_ref),
                _ => false,
            }
        }
        assert!(projected["$defs"]
            .as_object()
            .unwrap()
            .values()
            .all(|value| !has_ref(value)));
    }
}
