use director_core::{
    importer, portable,
    store::{hash_file, s, Store},
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{collections::BTreeSet, fs, io::Write, path::Path};
use tempfile::TempDir;
use zip::{write::SimpleFileOptions, ZipWriter};

fn project(path: &Path) -> Store {
    let store = Store::open(path.to_path_buf()).unwrap();
    store.create("迁移测试", "new-project").unwrap();
    store
}
fn png(path: &Path) {
    image::RgbImage::from_pixel(3, 2, image::Rgb([12, 90, 150]))
        .save_with_format(path, image::ImageFormat::Png)
        .unwrap();
}
fn snapshot(connection: &Connection, id: &str, key: &str, title: &str, value: Value) {
    connection
        .execute(
            "INSERT INTO SceneSnapshot VALUES(?1,'legacy-project',?2,?3,?4,?5)",
            params![id, key, title, value.to_string(), id],
        )
        .unwrap();
}
fn document(path: &Path, episode: &str, number: u64, settled: &str, groups: Value, extra: bool) {
    let value = json!({"id":"same-document-id","web":{"createdAt":"2026-09-01T00:00:00Z","binding":{"projectId":"legacy-project","episodeId":episode,"episodeNumber":number}},
        "adopted":groups,"candidates":[{"id":"accepted","attemptId":"accepted-call","status":"adopted"},{"id":"failed","status":"needs_repair","output":{"units":[{"id":"REJECTED","prompt":"不能导入"}]}}],
        "operations":[{"attemptId":"accepted-call","localSettledAt":settled}],
        "result":if extra{json!({"units":[{"id":"REJECTED","prompt":"不能导入"}]})}else{Value::Null}});
    fs::write(path, value.to_string()).unwrap();
}
fn group(package: &str, id: &str, prompt: &str) -> Value {
    json!({"packageIds":[package],"candidateId":"accepted","stage":"finish","draft":{"units":[{"id":id,"prompt":prompt,"sourceRefs":["old-row"],"sceneId":"old-scene","shots":[{"duration":5,"sourceRefs":["old-row"]}]}]}})
}

#[test]
fn legacy_import_preserves_current_groups_and_manual_adopted_images() {
    let temporary = TempDir::new().unwrap();
    let legacy = temporary.path().join("old");
    fs::create_dir_all(legacy.join("prisma")).unwrap();
    let documents = legacy.join(".storyboard-stage3-v2/documents");
    fs::create_dir_all(&documents).unwrap();
    let references = legacy.join("outputs/asset-references");
    fs::create_dir_all(&references).unwrap();
    let manual = references.join("manual-reference");
    png(&manual);
    let (digest, size) = hash_file(&manual).unwrap();
    let database = legacy.join("prisma/dev.db");
    let connection = Connection::open(&database).unwrap();
    connection.execute_batch("CREATE TABLE Project(id TEXT,title TEXT,createdAt TEXT); CREATE TABLE Episode(id TEXT,projectId TEXT,number INTEGER,title TEXT,content TEXT); CREATE TABLE SceneSnapshot(id TEXT,projectId TEXT,sceneKey TEXT,title TEXT,content TEXT,createdAt TEXT);").unwrap();
    connection
        .execute(
            "INSERT INTO Project VALUES('legacy-project','旧项目','2026-09-01')",
            [],
        )
        .unwrap();
    for number in 1..=2 {
        connection
            .execute(
                "INSERT INTO Episode VALUES(?1,'legacy-project',?2,NULL,'场景：门口\n甲：走。\n')",
                params![format!("old-episode-{number}"), number],
            )
            .unwrap();
    }
    let reference = json!({"id":"manual-reference","name":"人工上传.png","size":size,"sha256":digest,"width":3,"height":2});
    snapshot(
        &connection,
        "01",
        "ASSET_PROMPT_V1",
        "manual-character",
        json!({"key":"manual-character","body":"人工保存的全身形象"}),
    );
    snapshot(
        &connection,
        "02",
        "ASSET_IMAGE_OPTIONS_V1",
        "manual-character",
        json!({"references":[reference.clone()]}),
    );
    snapshot(
        &connection,
        "03",
        "ASSET_DESIGN_ADOPTION_V1",
        "manual-character",
        json!({"action":"ADOPT","assetKey":"manual-character","version":3,"referenceIds":["manual-reference"],"references":[reference]}),
    );
    snapshot(
        &connection,
        "04",
        "ASSET_DESIGN_CURRENT_V1",
        "manual-character",
        json!({"assetKey":"manual-character","currentVersion":3}),
    );
    drop(connection);
    let old_database_hash = hash_file(&database).unwrap().0;
    document(
        &documents.join("z-older.json"),
        "old-episode-1",
        1,
        "2026-10-01T10:00:00Z",
        json!([group("old", "U1", "较旧采用稿")]),
        false,
    );
    document(
        &documents.join("a-newer.json"),
        "old-episode-1",
        1,
        "2026-10-02T10:00:00Z",
        json!([
            group("one", "U1", "当前组一"),
            group("two", "U1", "当前组二，不同正文"),
            group("three", "U2", "当前组三")
        ]),
        true,
    );
    document(
        &documents.join("other-episode.json"),
        "old-episode-2",
        2,
        "2026-10-02T12:00:00Z",
        json!([group("one", "U1", "另一集同ID")]),
        false,
    );
    document(
        &documents.join("latest-but-unadopted.json"),
        "old-episode-2",
        2,
        "2026-10-03T12:00:00Z",
        json!([]),
        true,
    );
    let store = project(&temporary.path().join("new"));
    // Passing an explicit DB file must resolve project files from its parent project, not prisma/.
    let report = importer::import_legacy(&store, &database, &json!({})).unwrap();
    assert_eq!(report["units"], 4);
    assert_eq!(report["adoptedGroups"], 4);
    assert_eq!(report["media"], 1);
    assert_eq!(report["adoptedImages"], 1);
    let units = store.values("units").unwrap();
    assert_eq!(
        units
            .iter()
            .map(|unit| s(unit, "id"))
            .collect::<BTreeSet<_>>()
            .len(),
        4
    );
    assert_eq!(
        units
            .iter()
            .filter(|unit| unit["legacyUnitId"] == "U1")
            .count(),
        3
    );
    assert_eq!(
        units
            .iter()
            .filter(|unit| unit["legacyIdConflict"] == true)
            .count(),
        2
    );
    assert!(!units
        .iter()
        .any(|unit| s(unit, "prompt").contains("较旧") || s(unit, "prompt").contains("不能导入")));
    assert!(units.iter().all(|unit| unit["needsSourceMapping"] == true
        && unit["needsAssetMapping"] == true
        && unit["sourceRefs"] == json!([])
        && unit["duration"] == 5.0));
    let asset = store.values("assets").unwrap().pop().unwrap();
    let adopted = store.adopted(s(&asset, "id"), "legacy").unwrap().unwrap();
    assert_eq!(store.get("media", &adopted).unwrap()["sha256"], digest);
    assert!(report["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["code"] == "LEGACY_UNADOPTED_DOCUMENT"));
    assert!(report["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["code"] == "LEGACY_UNIT_ID_CONFLICT"));
    let saved_report: String = store
        .conn()
        .unwrap()
        .query_row(
            "SELECT value FROM metadata WHERE key LIKE 'legacy_import_report:%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&saved_report).unwrap()["reportId"],
        report["reportId"]
    );
    assert!(store.jobs().unwrap().is_empty());
    assert_eq!(hash_file(&database).unwrap().0, old_database_hash);
    assert_eq!(hash_file(&manual).unwrap().0, digest);
}

#[test]
fn standalone_legacy_json_does_not_promote_unadopted_results() {
    let temporary = TempDir::new().unwrap();
    let store = project(&temporary.path().join("project"));
    let file = temporary.path().join("unadopted.json");
    document(
        &file,
        "old-episode-1",
        1,
        "2026-10-01T00:00:00Z",
        json!([]),
        true,
    );
    let report = importer::import_legacy(&store, &file, &json!({})).unwrap();
    assert_eq!(report["units"], 0);
    assert!(store.values("units").unwrap().is_empty());
    assert_eq!(report["diagnostics"][0]["artifacts"]["resultUnits"], 1);
}

fn media_project(root: &Path) -> (Store, Value) {
    let store = project(root);
    let file = root.join("source.png");
    png(&file);
    let media = store.import_media(&file, "image", None, None).unwrap();
    (store, media)
}
fn queue(store: &Store, entity: &str, state: &str, media: &Value) -> String {
    let snapshot = json!({"kind":"video","references":[{"mediaId":media["id"],"relativePath":media["relativePath"],"sha256":media["sha256"],"path":media["path"]}],"preparedPackage":{"path":media["path"]}});
    let id = store
        .add_job("video", entity, "dreamina", "account", &snapshot, state)
        .unwrap();
    store
        .update_job(
            &id,
            state,
            &json!({"prepared":{"request":{"references":snapshot["references"]}}}),
        )
        .unwrap();
    id
}
fn raw_snapshot(store: &Store, id: &str) -> String {
    store
        .conn()
        .unwrap()
        .query_row("SELECT snapshot FROM jobs WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn portable_relocation_invalidates_unsent_work_and_preserves_receipts_byte_for_byte() {
    let temporary = TempDir::new().unwrap();
    let (store, media) = media_project(&temporary.path().join("original"));
    let pending: Vec<String> = [
        "queued",
        "ready",
        "preparing",
        "prepared",
        "waiting_dependency",
    ]
    .iter()
    .enumerate()
    .map(|(index, state)| queue(&store, &format!("pending-{index}"), state, &media))
    .collect();
    let null_receipt = queue(&store, "null-receipt", "ready", &media);
    store
        .update_job(&null_receipt, "ready", &json!({"receipt":null}))
        .unwrap();
    let submitted = queue(&store, "submitted", "submitted", &media);
    store
        .update_job(
            &submitted,
            "submitted",
            &json!({"providerTaskId":"cloud-1","receipt":{"taskId":"cloud-1"}}),
        )
        .unwrap();
    let unknown = queue(&store, "unknown", "submission_unknown", &media);
    let submitting = queue(&store, "submitting", "submitting", &media);
    let acknowledged = queue(&store, "acknowledged", "ready", &media);
    store
        .update_job(
            &acknowledged,
            "ready",
            &json!({"receipt":{"taskId":"cloud-before-local-id"}}),
        )
        .unwrap();
    let protected = [submitted, unknown, submitting, acknowledged];
    for id in &protected {
        let old = raw_snapshot(&store, id);
        store
            .conn()
            .unwrap()
            .execute(
                "UPDATE jobs SET snapshot=?1 WHERE id=?2",
                params![format!("\n  {old}\n"), id],
            )
            .unwrap();
    }
    let frozen: Vec<(String, String, Value, Value)> = protected
        .iter()
        .map(|id| {
            let job = store.job(id).unwrap();
            (
                id.clone(),
                raw_snapshot(&store, id),
                job["prepared"].clone(),
                job["receipt"].clone(),
            )
        })
        .collect();
    let package = temporary.path().join("project.zip");
    portable::export(&store, &package).unwrap();
    let imported = portable::import(&package, &temporary.path().join("moved")).unwrap();
    for id in pending.iter().chain(std::iter::once(&null_receipt)) {
        let job = imported.job(id).unwrap();
        assert_eq!(job["status"], "stale");
        assert!(job["prepared"].is_null());
        assert!(job["snapshot"]["references"][0].get("path").is_none());
        assert!(job["snapshot"].get("preparedPackage").is_none());
    }
    for (id, raw, prepared, receipt) in &frozen {
        assert_eq!(raw_snapshot(&imported, id), *raw);
        let job = imported.job(id).unwrap();
        assert_eq!(job["prepared"], *prepared);
        assert_eq!(job["receipt"], *receipt);
    }
    assert_eq!(
        imported.job(&protected[2]).unwrap()["status"],
        "submission_unknown"
    );
    let projected = imported.get("media", s(&media, "id")).unwrap();
    assert_eq!(
        Path::new(s(&projected, "path")),
        imported.absolute_media(&projected).unwrap()
    );
    assert!(Path::new(s(&projected, "thumbnailPath")).is_file());
    // The same relocation entry point is used by restoring a consistent backup to a new project copy.
    let copied = temporary.path().join("backup-copy");
    fs::create_dir_all(&copied).unwrap();
    store.backup_db(&copied.join("project.sqlite")).unwrap();
    let restored = Store::open(copied).unwrap();
    let destination = restored.absolute_media(&media).unwrap();
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    fs::copy(store.verify_media(&media).unwrap(), destination).unwrap();
    assert_eq!(portable::relocate(&restored).unwrap(), 6);
    assert_eq!(raw_snapshot(&restored, &protected[0]), frozen[0].1);
    assert_eq!(restored.job(&pending[0]).unwrap()["status"], "stale");
}

fn package(path: &Path, database: &Path, manifest: Value) {
    let mut zip = ZipWriter::new(fs::File::create(path).unwrap());
    zip.start_file("manifest.json", SimpleFileOptions::default())
        .unwrap();
    zip.write_all(manifest.to_string().as_bytes()).unwrap();
    zip.start_file("project.sqlite", SimpleFileOptions::default())
        .unwrap();
    std::io::copy(&mut fs::File::open(database).unwrap(), &mut zip).unwrap();
    zip.finish().unwrap();
}

#[test]
fn project_package_rejects_unknown_or_inconsistent_schema_before_migration() {
    let temporary = TempDir::new().unwrap();
    let store = project(&temporary.path().join("source"));
    let snapshot = temporary.path().join("snapshot.sqlite");
    store.backup_db(&snapshot).unwrap();
    let version: String = store
        .conn()
        .unwrap()
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let version: u64 = version.parse().unwrap();
    let cases = [
        json!({"format":"director-project-v1","schemaVersion":99,"mediaCount":0}),
        json!({"format":"director-project-v1","mediaCount":0}),
        json!({"format":"director-project-v1","schemaVersion":if version==2{1}else{2},"mediaCount":0}),
    ];
    for (index, manifest) in cases.into_iter().enumerate() {
        let file = temporary.path().join(format!("bad-{index}.zip"));
        package(&file, &snapshot, manifest);
        assert!(
            portable::import(&file, &temporary.path().join(format!("bad-target-{index}"))).is_err()
        );
    }
    let raw = Connection::open(&snapshot).unwrap();
    raw.execute(
        "UPDATE metadata SET value='99' WHERE key='schema_version'",
        [],
    )
    .unwrap();
    drop(raw);
    let file = temporary.path().join("unknown-db.zip");
    package(
        &file,
        &snapshot,
        json!({"format":"director-project-v1","schemaVersion":2,"mediaCount":0}),
    );
    let error = portable::import(&file, &temporary.path().join("unknown-target"))
        .err()
        .unwrap();
    assert!(error.contains("schema_version=99"));
}

#[test]
fn known_v1_database_is_checked_then_migrated_to_current_schema() {
    let temporary = TempDir::new().unwrap();
    let store = project(&temporary.path().join("source"));
    let snapshot = temporary.path().join("v1.sqlite");
    store.backup_db(&snapshot).unwrap();
    let raw = Connection::open(&snapshot).unwrap();
    raw.execute(
        "UPDATE metadata SET value='1' WHERE key='schema_version'",
        [],
    )
    .unwrap();
    drop(raw);
    let file = temporary.path().join("v1.zip");
    package(
        &file,
        &snapshot,
        json!({"format":"director-project-v1","schemaVersion":1,"mediaCount":0}),
    );
    let imported = portable::import(&file, &temporary.path().join("v1-import")).unwrap();
    let version: String = imported
        .conn()
        .unwrap()
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, "2");
}
