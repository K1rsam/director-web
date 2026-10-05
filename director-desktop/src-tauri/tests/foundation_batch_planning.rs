//! Capacity planning of a representative 80-episode source; no models or stores.
use director_core::pipeline::{foundation_delivery::preview_foundation_delivery, prepare_source};
use serde_json::json;
use std::collections::HashSet;
#[test]
fn eighty_episodes_are_capacity_packed_in_order_instead_of_eighty_complete_calls() {
    let mut script = String::new();
    for number in 1..=80 {
        script.push_str(&format!(
            "第{number}集\n场景：旧仓库\n{}\n梁晨：钥匙在这里。\n",
            "△梁晨穿深色夹克站在仓库门口，陈岚检查门锁，钥匙的齿纹保持一致。\n".repeat(24)
        ));
    }
    let source = prepare_source(&script).unwrap();
    assert_eq!(source.episodes.len(), 80);
    let plan = preview_foundation_delivery(&source, &json!({})).unwrap();
    assert_eq!(plan["f1ModelCalls"], 0);
    let batches = plan["f2Batches"].as_array().unwrap();
    assert!(batches.len() > 1 && batches.len() < 80);
    let scope: Vec<_> = batches
        .iter()
        .flat_map(|b| b["scope"].as_array().unwrap())
        .cloned()
        .collect();
    assert_eq!(
        scope,
        json!(source.episodes.iter().map(|e| &e.id).collect::<Vec<_>>())
            .as_array()
            .unwrap()
            .to_vec()
    );
    assert_eq!(
        scope
            .iter()
            .map(|id| id.as_str().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        80
    );
    let within_budget = batches
        .iter()
        .all(|b| b["withinBudget"] == true && b["fragment"].is_null());
    let evidence = json!({"ok":within_budget,"scopeEpisodes":80,"utf16SourceChars":script.encode_utf16().count(),"plan":plan,"generationRequestsSent":0,"productionDatabaseAccess":false,"limits":"Offline planning only; final Q1 packing depends on actual F2 catalog. No elapsed-time or generated-content claim."});
    if let Ok(path) = std::env::var("DIRECTOR_BATCH_PLAN_REPORT") {
        director_core::store::atomic_json(&std::path::PathBuf::from(path), &evidence).unwrap();
    }
    println!(
        "{}",
        json!({"episodes":80,"f2Batches":batches.len(),"f1ModelCalls":0,"q1MinimumCalls":plan["q1MinimumCalls"],"batches":batches.iter().map(|batch|json!({"episodes":batch["scope"].as_array().unwrap().len(),"sourceChars":batch["sourceChars"],"requestChars":batch["requestChars"],"withinBudget":batch["withinBudget"]})).collect::<Vec<_>>()})
    );
    assert!(within_budget);
}
