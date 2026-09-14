#!/usr/bin/env python3
"""Zero-model, conservative header repair. Preview by default; explicit DB only."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from source_parser import make_scene, infer_location, find_token


def plan_patch(row):
    """Only repair an unchanged parser-owned, unconsumed hyphen-header row."""
    try:
        metadata = json.loads(row["metadata"])
    except (TypeError, ValueError):
        return None
    allowed = {"characters", "props", "sourceHash", "sourceSceneKey", "sceneKeyAmbiguous"}
    if not isinstance(metadata, dict) or set(metadata) - allowed:
        return None
    if row.get("consumed", 0) or row.get("revision", "V1") != "V1":
        return None
    if metadata.get("sourceHash") != hashlib.sha256(row["sourceText"].encode("utf-8")).hexdigest():
        return None
    if not re.search(r"(?m)^\s*(?:场?\s*)?\d+\s*[-－—]\s*\d+\s*[:：]", row["sourceText"]):
        return None
    # Both historical versions must yield the same correction. Ambiguous comma
    # syntax is skipped rather than assuming the source's locked parser version.
    candidates = []
    for version in ("SCENE_PARSER_V1", "SCENE_PARSER_V2"):
        parsed = make_scene(row["number"], row["sceneKey"], row["sortOrder"], row["sourceText"], version=version)
        if parsed["heading"] != row["heading"] or any(metadata.get(key) != parsed["metadata"][key] for key in ("characters", "props")):
            return None
        heading = re.sub(r"[，,]", " ", parsed["heading"]) if version.endswith("V2") else parsed["heading"]
        legacy = dict(parsed, location=infer_location(heading), timeOfDay=find_token(heading, ["日", "夜", "晨", "午", "黄昏"]))
        # Explicit fields take precedence and must never be reinterpreted here.
        if re.search(r"(?m)^\s*(?:场景|时间)\s*[:：]", row["sourceText"]):
            return None
        if any(row[key] != legacy[key] for key in ("location", "timeOfDay", "interiorExterior", "weather", "timeLayer")):
            return None
        candidates.append({key: parsed[key] for key in ("location", "timeOfDay") if row[key] != parsed[key]})
    return candidates[0] if candidates[0] and candidates[0] == candidates[1] else None


def refresh(connection, project_id, apply=False):
    connection.row_factory = sqlite3.Row
    result = []
    # A transaction locks the read/compare/write interval when applying. No row
    # reconstruction, source writes, metadata writes, or downstream invalidation.
    connection.execute("BEGIN IMMEDIATE" if apply else "BEGIN")
    try:
        rows = connection.execute('''SELECT s.*, e.number,
          (EXISTS(SELECT 1 FROM StoryboardShot b WHERE b.sceneId=s.id)
           OR EXISTS(SELECT 1 FROM SeedanceUnit u WHERE u.sceneId=s.id)) AS consumed
          FROM ScriptScene s JOIN Episode e ON e.id=s.episodeId
          WHERE e.projectId=? ORDER BY e.number,s.sortOrder''', (project_id,)).fetchall()
        for raw in rows:
            row = dict(raw)
            patch = plan_patch(row)
            if not patch:
                continue
            result.append({"id": row["id"], "episode": row["number"], "sceneKey": row["sceneKey"], "before": {key: row[key] for key in patch}, "after": patch})
            if apply:
                keys = list(patch)
                changed = connection.execute('UPDATE ScriptScene SET ' + ','.join(f'"{key}"=?' for key in keys) + ' WHERE id=? AND sourceText=? AND metadata=? AND ' + ' AND '.join(f'"{key}" IS ?' for key in keys), [*(patch[key] for key in keys), row["id"], row["sourceText"], row["metadata"], *(row[key] for key in keys)])
                if changed.rowcount != 1:
                    raise RuntimeError("Scene changed during metadata refresh")
        connection.commit() if apply else connection.rollback()
    except BaseException:
        connection.rollback()
        raise
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    database = Path(args.database).resolve(strict=True)
    with sqlite3.connect(database.as_uri() + ("?mode=rw" if args.apply else "?mode=ro"), uri=True) as connection:
        print(json.dumps({"applied": args.apply, "changes": refresh(connection, args.project, args.apply)}, ensure_ascii=False, indent=2))
