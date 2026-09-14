"""Isolated SQLite coverage for conservative parser metadata refresh."""
import hashlib
import json
import sqlite3
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from refresh_scene_header_metadata import plan_patch, refresh
from source_parser import make_scene

raw = "第11集\r\n11-1：日 外 大比擂台区\r\n楚天野：来了🙂。  \r\n"
parsed = make_scene(11, "11-1", 1, raw)
metadata = {**parsed.pop("metadata"), "sourceHash": hashlib.sha256(raw.encode()).hexdigest()}
row = dict(parsed, id="scene", episodeId="episode", number=11, revision="V1", metadata=json.dumps(metadata), location="：日 大比擂台区", timeOfDay=None)
assert plan_patch(row) == {"location": "大比擂台区", "timeOfDay": "日"}
for changed in [
    {"location": "人工指定地点"}, {"consumed": 1}, {"revision": "V2"},
    {"sourceText": raw + "新原文"}, {"metadata": "broken"},
    {"metadata": json.dumps({**metadata, "sourceFieldPatch": {}})},
    {"metadata": json.dumps({**metadata, "aiReview": "approved"})},
    {"metadata": json.dumps({**metadata, "characters": ["人工修改人物"]})},
]:
    assert plan_patch({**row, **changed}) is None, changed

db = sqlite3.connect(":memory:")
db.execute("CREATE TABLE Episode(id TEXT,number INTEGER,projectId TEXT)")
db.execute("CREATE TABLE StoryboardShot(sceneId TEXT)")
db.execute("CREATE TABLE SeedanceUnit(sceneId TEXT)")
columns = [key for key in row if key != "number"]
db.execute("CREATE TABLE ScriptScene(" + ",".join(f'"{key}" ' + ("INTEGER" if key == "sortOrder" else "TEXT") for key in columns) + ")")
db.execute("INSERT INTO Episode VALUES ('episode',11,'project')")
db.execute("INSERT INTO ScriptScene VALUES (" + ",".join("?" for _ in columns) + ")", [row[key] for key in columns])
db.commit()
before = tuple(db.execute("SELECT * FROM ScriptScene").fetchone())
preview = refresh(db, "project")
assert len(preview) == 1
assert tuple(db.execute("SELECT * FROM ScriptScene").fetchone()) == before
assert refresh(db, "other", True) == []
assert refresh(db, "project", True) == preview
after = dict(db.execute("SELECT * FROM ScriptScene").fetchone())
assert {key: after[key] for key in columns if key not in ("location", "timeOfDay")} == {key: row[key] for key in columns if key not in ("location", "timeOfDay")}
assert after["location"] == "大比擂台区" and after["timeOfDay"] == "日"
assert refresh(db, "project", True) == [], "refresh is idempotent"
db.close()
print("scene header refresh: parser ownership, immutable source, preview, project boundary, idempotence passed")
