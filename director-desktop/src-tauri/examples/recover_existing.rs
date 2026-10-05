//! Explicit recovery of one saved cloud task. This never starts the scheduler or submits generation.
use director_core::{store::s, Engine};
use serde_json::json;
use std::path::PathBuf;

fn recover() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let home = PathBuf::from(args.next().ok_or("需要绝对应用目录、项目ID和原任务ID")?);
    let project = args.next().ok_or("需要项目ID")?;
    let job_id = args.next().ok_or("需要本地原任务ID")?;
    if !home.is_absolute() || args.next().is_some() {
        return Err("恢复参数必须为绝对应用目录、项目ID和本地原任务ID".into());
    }
    let engine = Engine::new(home)?;
    let store = engine.store(&project)?;
    let before = store.job(&job_id)?;
    let task_id = s(&before, "providerTaskId").to_owned();
    if task_id.is_empty() || task_id.starts_with("sync:") || s(&before, "provider") != "dreamina" {
        return Err("仅恢复已经保存官方云端ID的即梦原任务".into());
    }
    let count = store.jobs()?.len();
    engine.dispatch(json!({"action":"backup.create","projectId":project}))?;
    engine.dispatch(json!({"action":"jobs.download","projectId":project,"jobId":job_id}))?;
    while !engine.await_worker_shutdown(1) {}
    let after = store.job(&job_id)?;
    if s(&after, "providerTaskId") != task_id
        || before["snapshot"] != after["snapshot"]
        || store.jobs()?.len() != count
    {
        return Err("原任务身份、材料或生成任务数量发生异常变化".into());
    }
    if s(&after, "status") != "downloaded" {
        return Err(format!(
            "原任务恢复状态：{}；{}",
            s(&after, "status"),
            s(&after, "error")
        ));
    }
    let mut media = Vec::new();
    for id in after["resultMediaIds"].as_array().ok_or("没有结果媒体")? {
        let id = id.as_str().ok_or("结果媒体身份无效")?;
        let item = store.get("media", id)?;
        let path = store.verify_media(&item)?;
        let dimensions = if s(&item, "kind") == "image" {
            Some(image::image_dimensions(path).map_err(|e| e.to_string())?)
        } else {
            None
        };
        media.push(json!({"mediaId":id,"kind":item["kind"],"sha256":item["sha256"],"relativePath":item["relativePath"],"dimensions":dimensions}));
    }
    println!(
        "{}",
        json!({"ok":true,"status":after["status"],"originalTaskUnchanged":true,"originalSnapshotUnchanged":true,"newGenerationJobs":0,"schedulerStarted":false,"media":media})
    );
    Ok(())
}
fn main() {
    if let Err(error) = recover() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
