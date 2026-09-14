#!/usr/bin/env python3
"""Deterministic, bounded source and scene parsing.  JSON in, JSON out."""
import json
import hashlib
import re
import sys
if hasattr(sys.stdin, "reconfigure"): sys.stdin.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stdout, "reconfigure"): sys.stdout.reconfigure(encoding="utf-8", errors="strict")

EPISODE_RE = re.compile(r"(?:(?<=\n)|(?<=\r)|\A)[\t \u00a0\u2000-\u200a\u202f\u205f\u3000\ufeff]*(?:(新增|增补)[\t \u00a0\u2000-\u200a\u202f\u205f\u3000]*)?第[\t \u00a0\u2000-\u200a\u202f\u205f\u3000]*([0-9零〇一二两三四五六七八九十百]+)(?:\r\n|\r|\n)?[\t \u00a0\u2000-\u200a\u202f\u205f\u3000]*集[^\r\n]*")
# V1 also supplies episode boundaries; new scene syntax must not widen this matcher.
SCENE_RE = re.compile(r"(?:(?<=\n)|(?<=\r)|\A)[\t ]*(?:场[\t ]*)?(\d+)[\t ]*[-－—][\t ]*(\d+)(?!\d)[^\r\n]*")
SCENE_DOT_RE = re.compile(r"(?:(?<=\n)|(?<=\r)|\A)[\t ]*(?:场[\t ]*)?(\d+)[\t ]*[.．][\t ]*(\d+)(?!\d|[\t ]*[.．])([^\r\n]*)")
MARKER_RE = re.compile(r"(?:(?<=\n)|(?<=\r)|\A)场景\s*[:：]?\s*([^\r\n：:]{1,30})(?=\r?\n|\r|$)")
DIGITS = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}

def js_len(value):
    return len(value.encode("utf-16-le")) // 2

def js_offset(text, py_index):
    return js_len(text[:py_index])

def episode_number(value):
    value = value.strip()
    if value.isdigit(): return int(value)
    repeated = re.fullmatch(r"([零〇一二两三四五六七八九十百]+)(\d+)", value)
    if repeated:
        left = episode_number(repeated.group(1))
        return left if left == int(repeated.group(2)) else None
    if value and all(char in DIGITS for char in value): return int("".join(str(DIGITS[char]) for char in value))
    if value.count("百") == 1:
        before, after = value.split("百")
        hundreds = DIGITS.get(before, 1) if len(before) <= 1 else None
        rest = episode_number(after) if after else 0
        return hundreds * 100 + rest if hundreds is not None and rest is not None else None
    if value.count("十") == 1:
        before, after = value.split("十")
        tens = DIGITS.get(before, 1) if len(before) <= 1 else None
        ones = DIGITS.get(after, 0) if len(after) <= 1 else None
        return tens * 10 + ones if tens is not None and ones is not None else None
    return None

def line_start(text, index):
    return index == 0 or text[index - 1] in "\r\n"

def profile_zero(title, body):
    lines = [line.strip() for line in re.split(r"\r\n|\r|\n", body)[1:] if line.strip()]
    first = lines[0] if lines else ""
    explicit = bool(re.match(r"^第\s*[0零〇]\s*集\s*(?:人物设定|角色设定|人物小传|故事大纲|故事梗概|分集概括|项目简介)(?:\s|[:：]|$)", title)) or bool(re.match(r"^(?:人物设定|角色设定|人物小传|故事大纲|故事梗概|分集概括|项目简介)\s*[:：]?$", first))
    scene = bool(re.search(r"(?:^|\n)\s*(?:(?:场\s*)?0\s*[-－—.]\s*\d+|[△▲])", body))
    if scene: return False
    if explicit: return True
    marker = bool(re.match(r"^第\s*0\s*集\s*(?:人物|角色|资料|设定|世界观)(?:\s*设定|\s*资料|\s*说明|\s*卡|\s*表)?(?:\s|：|:|$)", title))
    stage = bool(re.search(r"(?:^|\n)\s*0\s*[-－—]\s*\d+", body))
    dialogue = bool(re.search(r"(?:^|\n)\s*(?!人物\s*[：:]|角色\s*[：:]|关系\s*[：:]|设定\s*[：:]|资料\s*[：:])[\u4e00-\u9fff]{2,8}\s*[：:]", body))
    action = bool(re.search(r"冲进|冲出|跑向|跑进|翻过|追上|推开|抬头|转身|跌倒|站起|坐下|走进|离开|回到|醒来|喊道|哭着|笑着|开枪|打在", body))
    return marker and not stage and not dialogue and not action

def logical_headings(text):
    raw = []
    for match in EPISODE_RE.finditer(text):
        number = episode_number(match.group(2) or "")
        if number is not None:
            raw.append({"start": match.start(), "end": match.end(), "number": number, "title": match.group(0).strip(), "kind": "SUPPLEMENT" if match.group(1) else "EPISODE"})
    result = []; cursor = 0
    while cursor < len(raw):
        first = raw[cursor]; labels = [first]; end = first["end"]
        while cursor + len(labels) < len(raw):
            candidate = raw[cursor + len(labels)]
            if candidate["number"] != first["number"] or text[end:candidate["start"]].strip(): break
            labels.append(candidate); end = candidate["end"]
        result.append({**first, "end": end, "kind": "SUPPLEMENT" if any(x["kind"] == "SUPPLEMENT" for x in labels) else first["kind"]})
        cursor += len(labels)
    return result

def boundaries(text):
    headings = logical_headings(text); candidates = []
    for match in SCENE_RE.finditer(text):
        number = int(match.group(1)); start = match.start()
        previous = sorted([*headings, *candidates], key=lambda item: item["start"])
        previous = [item for item in previous if item["start"] < start]
        previous = previous[-1] if previous else None
        if previous and previous["number"] == number: continue
        next_heading = next((item for item in headings if item["start"] > start), None)
        explicit = bool(re.match(r"^\s*场", match.group(0))) or bool(re.search(r"(?:^|\s)(?:日|夜|晨|午|黄昏|内|外)(?:\s|$)", match.group(0)))
        inferred = (previous is not None and previous["kind"] != "SCENE_CANDIDATE" and number == previous["number"] + 1 and (next_heading is None or number < next_heading["number"])) or (previous is None and next_heading is not None and next_heading["number"] == number + 1) or (previous is None and next_heading is None and explicit)
        candidates.append({"start": start, "end": match.end(), "number": number, "title": match.group(0).strip(), "kind": "SCENE_INFERRED" if inferred else "SCENE_CANDIDATE"})
    return sorted([*headings, *candidates], key=lambda item: item["start"])

def base_parse(text, read_issues):
    headings = boundaries(text); sections = []; episodes = []; issues = []; notes = []
    if not headings:
        sections.append({"key": "BACKGROUND-1", "kind": "BACKGROUND", "start": 0, "end": js_len(text)})
        issues.append({"code": "NO_RECOGNIZED_EPISODE", "message": "未找到可识别的分集标题；原文以可读背景资料保存，需人工划分正剧。", "sectionKeys": ["BACKGROUND-1"]})
    else:
        if headings[0]["start"] > 0: sections.append({"key": "BACKGROUND-1", "kind": "BACKGROUND", "start": 0, "end": js_offset(text, headings[0]["start"])})
        counts = {item["number"]: sum(1 for candidate in headings if candidate["number"] == item["number"]) for item in headings}
        unresolved = {}; bg = len(sections); unresolved_count = 0
        for idx, heading in enumerate(headings):
            end = headings[idx + 1]["start"] if idx + 1 < len(headings) else len(text)
            start16, end16 = js_offset(text, heading["start"]), js_offset(text, end)
            if heading["kind"] == "SCENE_CANDIDATE" or counts[heading["number"]] > 1:
                unresolved_count += 1; key = f"UNRESOLVED-{heading['number']}-{unresolved_count}"
                sections.append({"key": key, "kind": "UNRESOLVED", "start": start16, "end": end16, "episodeNumber": heading["number"]})
                code = "DUPLICATE_EPISODE_NUMBER" if counts[heading["number"]] > 1 else "UNNUMBERED_SCENE_EPISODE_CANDIDATE"
                unresolved.setdefault(code, []).append(key)
            elif heading["number"] == 0 and profile_zero(heading["title"], text[heading["start"]:end]):
                bg += 1; sections.append({"key": f"BACKGROUND-{bg}", "kind": "BACKGROUND", "start": start16, "end": end16, "episodeNumber": 0})
            else:
                basis = "SCENE_NUMBER" if heading["kind"] == "SCENE_INFERRED" else "SUPPLEMENT_HEADING" if heading["kind"] == "SUPPLEMENT" else "EXPLICIT_HEADING"
                sections.append({"key": f"EPISODE-{heading['number']}", "kind": "EPISODE", "start": start16, "end": end16, "episodeNumber": heading["number"], "boundaryBasis": basis})
                episodes.append({"number": heading["number"], "title": f"第{heading['number']}集（按原场号定位）" if basis == "SCENE_NUMBER" else heading["title"], "content": text[heading["start"]:end]})
                if basis == "SCENE_NUMBER": notes.append(f"第{heading['number']}集按原场号及相邻编号定位；这是读取边界，不声称作者写了独立集标题，原文未加字。")
                if basis == "SUPPLEMENT_HEADING": notes.append(f"第{heading['number']}集保留新增/增补标记，按本文件独立读取，未覆盖或合并其它稿件。")
        for code, keys in unresolved.items():
            message = "存在同号异文，未自动择稿或覆盖；请人工确认归属。" if code == "DUPLICATE_EPISODE_NUMBER" else "发现无独立集标题的场号候选，未自动改号或归入相邻分集。"
            issues.append({"code": code, "message": message, "sectionKeys": keys})
    issues.extend({"code": item["code"], "message": item["message"], "sectionKeys": []} for item in read_issues)
    return sections, episodes, issues, notes

def py_at_js(text, target):
    offset = 0
    for index, char in enumerate(text):
        if offset == target: return index
        offset += js_len(char)
    if offset == target: return len(text)
    return None

def apply_plan(text, sections, episodes, issues, plan):
    if not plan: return sections, episodes, issues
    assignments = plan.get("assignments") or []; new_boundaries = plan.get("boundaries") or []
    if assignments and new_boundaries: raise ValueError("plan cannot combine assignments and boundaries")
    if assignments:
        known = {section["key"]: section for section in sections}; seen = set()
        for assignment in assignments:
            key = assignment.get("sectionKey"); target = known.get(key)
            if not target or target["kind"] != "UNRESOLVED": raise ValueError("assignments may target only existing unresolved sections")
            if key in seen: raise ValueError("assignment overlaps another assignment")
            seen.add(key); kind = assignment.get("kind")
            if kind not in ("EPISODE", "BACKGROUND"): raise ValueError("invalid assignment kind")
            if kind == "EPISODE" and (not isinstance(assignment.get("episodeNumber"), int) or assignment["episodeNumber"] < 0): raise ValueError("episode assignment needs a valid number")
            target["kind"] = kind
            if kind == "EPISODE": target["episodeNumber"] = assignment["episodeNumber"]
            else: target.pop("episodeNumber", None)
        resolved = set(seen)
        issues = [{**issue, "sectionKeys": [key for key in issue["sectionKeys"] if key not in resolved]} for issue in issues]
        issues = [issue for issue in issues if issue["sectionKeys"] or not issue["sectionKeys"] and issue["code"] not in ("DUPLICATE_EPISODE_NUMBER", "UNNUMBERED_SCENE_EPISODE_CANDIDATE")]
    elif new_boundaries:
        allowed = any(issue["code"] == "NO_RECOGNIZED_EPISODE" for issue in issues) and not any(section["kind"] == "EPISODE" for section in sections)
        if not allowed: raise ValueError("boundaries are allowed only when the whole source has no recognized episode")
        starts = []
        for boundary in new_boundaries:
            start = boundary.get("start"); kind = boundary.get("kind")
            if not isinstance(start, int) or start < 0 or start >= js_len(text) or not line_start(text, py_at_js(text, start) if py_at_js(text, start) is not None else -1): raise ValueError("boundary start must be an in-range line boundary")
            if kind not in ("EPISODE", "BACKGROUND"): raise ValueError("invalid boundary kind")
            if kind == "EPISODE" and (not isinstance(boundary.get("episodeNumber"), int) or boundary["episodeNumber"] < 0): raise ValueError("episode boundary needs a valid number")
            starts.append(boundary)
        if starts != sorted(starts, key=lambda item: item["start"]) or len({item["start"] for item in starts}) != len(starts): raise ValueError("boundaries must be sorted and non-overlapping")
        rebuilt = []
        for index, boundary in enumerate(starts):
            end = starts[index + 1]["start"] if index + 1 < len(starts) else js_len(text)
            if end <= boundary["start"]: raise ValueError("boundaries must create nonempty ranges")
            key = f"EPISODE-{boundary['episodeNumber']}" if boundary["kind"] == "EPISODE" else f"BACKGROUND-{index + 1}"
            item = {"key": key, "kind": boundary["kind"], "start": boundary["start"], "end": end}
            if boundary["kind"] == "EPISODE": item["episodeNumber"] = boundary["episodeNumber"]
            rebuilt.append(item)
        sections, issues = rebuilt, [issue for issue in issues if issue["code"] != "NO_RECOGNIZED_EPISODE"]
    else: return sections, episodes, issues
    grouped = {}; title = {}
    for section in sections:
        if section["kind"] != "EPISODE": continue
        number = section["episodeNumber"]; start, end = py_at_js(text, section["start"]), py_at_js(text, section["end"])
        grouped.setdefault(number, []).append(text[start:end]); title.setdefault(number, f"第{number}集")
    episodes = [{"number": number, "title": title[number], "content": "".join(parts)} for number, parts in grouped.items()]
    return sections, episodes, issues

def parse_source(payload):
    text = payload.get("text")
    if not isinstance(text, str): raise ValueError("text must be a string")
    sections, episodes, issues, notes = base_parse(text, payload.get("readIssues") or [])
    sections, episodes, issues = apply_plan(text, sections, episodes, issues, payload.get("plan"))
    rebuilt = "".join(text[py_at_js(text, section["start"]):py_at_js(text, section["end"])] for section in sections)
    if rebuilt != text: raise ValueError("source sections must exactly cover source text")
    return {"episodes": episodes, "sourceStructure": {"version": "SOURCE_STRUCTURE_V1", "sections": sections, "issues": issues}, "boundaryNotes": notes}

def split_names(value):
    return [item.strip() for item in re.split(r"[、，,；;]", value or "") if item.strip()]

def field(lines, name):
    for line in lines:
        match = re.match(rf"^{name}\s*[:：]\s*(.*)$", line.strip())
        if match: return match.group(1).strip() or None
    return None

def find_token(text, values):
    return next((value for value in values if re.search(rf"(?:^|\s){re.escape(value)}(?:\s|$)", text)), None)

def infer_location(heading):
    cleaned = re.sub(r"(?:^|\s)(?:日|夜|晨|午|黄昏|内|外|闪回|梦境|想象|暴雨|雨|大雪|雪|薄雾|雾|晴|阴|大风|风)(?=\s|$)", " ", heading)
    return re.sub(r"\s+", " ", cleaned).strip() or None

def dot_scene_header(match):
    if match is None: return False
    if re.match(r"^\s*场", match.group(0)): return True
    fields = [field for field in re.split(r"[\s，,]+", match.group(3)) if field]
    times = ("日", "夜", "晨", "午", "黄昏"); spaces = ("内", "外")
    if fields and fields[0] in (*times, *spaces): return True
    # Location-first headers need an adjacent time/interior pair, not a trailing time word.
    return any((left in times and right in spaces) or (left in spaces and right in times) for left, right in zip(fields[1:], fields[2:]))

def make_scene(episode, key, order, source, marker_location=None, version="SCENE_PARSER_V1"):
    lines = [line.strip() for line in re.split(r"\r\n|\r|\n", source) if line.strip()]
    if version == "SCENE_PARSER_V1":
        scene_line = next((line for line in lines if re.match(r"^(?:场?\s*)?\d+\s*[-－—]\s*\d+", line)), None)
        inline = re.sub(r"^(?:场?\s*)?\d+\s*[-－—]\s*\d+\s*", "", scene_line or "")
        heading_line = inline or next((line for line in lines if not re.match(r"^(?:第.*集|(?:场?\s*)?\d+\s*[-－—]\s*\d+)", line)), key)
    else:
        scene_line = next((line for line in lines if re.match(r"^(?:场?\s*)?\d+\s*[-－—]\s*\d+", line) or dot_scene_header(SCENE_DOT_RE.match(line))), None)
        inline = re.sub(r"^(?:场?\s*)?\d+\s*[-－—.．]\s*\d+\s*", "", scene_line or "")
        heading_line = inline or next((line for line in lines if not re.match(r"^(?:第.*集|(?:场?\s*)?\d+\s*[-－—]\s*\d+)", line) and not dot_scene_header(SCENE_DOT_RE.match(line))), key)
    is_marker = bool(re.match(r"^场景\s*[:：]?", heading_line))
    heading = key if is_marker or re.match(r"^(?:场景|人物|道具)\s*[:：]", heading_line) else heading_line
    # A colon immediately after a recognized scene number is a separator, not
    # part of its location. Normalize only metadata: source, heading and scene
    # boundaries remain byte-for-byte unchanged for both parser versions.
    metadata_heading = re.sub(r"^[:：]\s*", "", heading) if scene_line else heading
    metadata_line = re.sub(r"^[:：]\s*", "", heading_line) if scene_line else heading_line
    if version == "SCENE_PARSER_V2":
        metadata_heading = re.sub(r"[，,]", " ", metadata_heading)
        metadata_line = re.sub(r"[，,]", " ", metadata_line)
    loc = marker_location or field(lines, "场景") or infer_location(metadata_heading)
    chars = split_names(field(lines, "人物"))
    for line in lines:
        speaker = re.match(r"^([\u4e00-\u9fff][\u4e00-\u9fff·]{1,11})(?:（[^）]*）)?\s*[:：]", line)
        if speaker and speaker.group(1) in ("人物", "场景", "道具", "时间", "天气"): speaker = None
        if speaker and speaker.group(1) not in chars: chars.append(speaker.group(1))
    props = field(lines, "道具")
    return {"sceneKey": key, "sortOrder": order, "heading": heading, "location": loc, "interiorExterior": field(lines, "内外") or find_token(metadata_line, ["内", "外"]), "timeOfDay": field(lines, "时间") or find_token(metadata_line, ["日", "夜", "晨", "午", "黄昏"]), "weather": field(lines, "天气") or find_token(metadata_line, ["暴雨", "雨", "大雪", "雪", "薄雾", "雾", "晴", "阴", "大风", "风"]), "timeLayer": field(lines, "时间层") or find_token(metadata_line, ["闪回", "梦境", "想象"]) or "现实", "sourceText": source, "metadata": {"characters": chars, "props": [] if props == "无" else split_names(props)}}

def apply_scene_splits(number, raw, scenes, plans, version="SCENE_PARSER_V1"):
    starts = [0] + [match.end() for match in re.finditer(r"\r\n|\r|\n", raw)]
    fields = ("location", "interiorExterior", "timeOfDay", "timeLayer")
    by_key = {plan["sceneKey"]: plan for plan in plans}
    unknown = set(by_key) - {scene["sceneKey"] for scene in scenes}
    if unknown: raise ValueError("scene split target is not an original source scene")
    result = []; offset = 0
    for scene in scenes:
        end = offset + len(scene["sourceText"]); plan = by_key.get(scene["sceneKey"])
        if not plan:
            result.append(scene); offset = end; continue
        if plan.get("sourceHash") != hashlib.sha256(raw.encode("utf-8")).hexdigest():
            raise ValueError(f"scene split sourceHash mismatch: 第{number}集原文已变化，请提交绑定新原文的替代拆场计划")
        cuts = plan.get("cuts")
        if not isinstance(cuts, list) or not cuts: raise ValueError("scene split cuts must be a nonempty list")
        positions = [offset]
        for cut in cuts:
            if not isinstance(cut, dict) or set(cut) - {"startLine", "anchor", *fields}: raise ValueError("invalid scene split cut fields")
            line = cut.get("startLine"); anchor = cut.get("anchor")
            if type(line) is not int or line < 1 or line > len(starts): raise ValueError("scene split line is out of range")
            start = starts[line - 1]
            if start <= positions[-1] or start >= end: raise ValueError("scene split lines must increase strictly inside their target scene")
            actual = raw[start:starts[line] if line < len(starts) else len(raw)].rstrip("\r\n")
            if not isinstance(anchor, str) or not anchor.strip() or anchor != actual: raise ValueError("scene split anchor must match the exact original line")
            if any(name in cut and (not isinstance(cut[name], str) or not cut[name].strip()) for name in fields): raise ValueError("scene split field values must be nonempty text")
            positions.append(start)
        positions.append(end)
        for index, (start, stop) in enumerate(zip(positions, positions[1:])):
            if not raw[start:stop].strip(): raise ValueError("scene split must create nonempty source ranges")
            line = starts.index(start) + 1
            key = scene["sceneKey"] if index == 0 else f"{scene['sceneKey']}__L{line}"
            part = make_scene(number, key, 0, raw[start:stop], version=version)
            if index == 0:
                part["metadata"] = {**scene["metadata"], **part["metadata"]}
            else:
                # An action sentence is not a location header. Only plan fields locate new parts.
                part.update({"heading": key, "location": None, "interiorExterior": None, "timeOfDay": None, "weather": None, "timeLayer": scene["timeLayer"]})
                part.update({name: cuts[index - 1][name] for name in fields if name in cuts[index - 1]})
                part["metadata"]["sourceSceneKey"] = scene["sceneKey"]
            source_fields = {name: part[name] for name in ("heading", "location", "interiorExterior", "timeOfDay", "weather", "timeLayer")}
            source_fields.update({name: part["metadata"][name] for name in ("characters", "props")})
            part["metadata"]["sourceSplit"] = {"episodeSourceHash": plan["sourceHash"], "sceneKey": scene["sceneKey"], "startLine": line, "fields": source_fields}
            result.append(part)
        offset = end
    for order, scene in enumerate(result, 1): scene["sortOrder"] = order
    if len({scene["sceneKey"] for scene in result}) != len(result): raise ValueError("scene split creates duplicate scene keys")
    if "".join(scene["sourceText"] for scene in result) != raw: raise ValueError("scene split ranges must exactly cover source text")
    return result

def parse_scenes(payload):
    versions = payload.get("sceneParserVersions", {})
    if not isinstance(versions, dict) or any(version not in ("SCENE_PARSER_V1", "SCENE_PARSER_V2") for version in versions.values()): raise ValueError("unknown scene parser version")
    plans = payload.get("plans", [])
    if not isinstance(plans, list): raise ValueError("scene split plans must be a list")
    known = {episode.get("number") for episode in payload.get("episodes") or []}; targets = set()
    for plan in plans:
        if not isinstance(plan, dict) or set(plan) != {"episode", "sourceHash", "sceneKey", "cuts"}: raise ValueError("invalid scene split plan fields")
        if type(plan.get("episode")) is not int or plan["episode"] not in known: raise ValueError("scene split episode target does not exist")
        if not isinstance(plan.get("sceneKey"), str) or not plan["sceneKey"]: raise ValueError("scene split needs a scene target")
        target = (plan["episode"], plan["sceneKey"])
        if target in targets: raise ValueError("duplicate scene split target")
        targets.add(target)
    result = []
    for episode in payload.get("episodes") or []:
        number, raw = episode.get("number"), episode.get("content")
        if not isinstance(number, int) or not isinstance(raw, str): raise ValueError("episodes need number and content")
        # Already-running TS workers send no version metadata and must retain V1.
        version = versions.get(str(number), "SCENE_PARSER_V1")
        marks = list(SCENE_RE.finditer(raw)); scenes = []
        if version == "SCENE_PARSER_V2": marks = sorted([*marks, *(match for match in SCENE_DOT_RE.finditer(raw) if dot_scene_header(match))], key=lambda match: match.start())
        if marks:
            groups = []; index = 0
            while index < len(marks):
                match = marks[index]; base_key = f"{match.group(1)}-{match.group(2)}"; heading = re.sub(r"\s+", " ", match.group(0).strip())
                cursor = index + 1
                # A consecutive, identical page header is continuation, not a new scene.
                while cursor < len(marks) and f"{marks[cursor].group(1)}-{marks[cursor].group(2)}" == base_key and re.sub(r"\s+", " ", marks[cursor].group(0).strip()) == heading: cursor += 1
                groups.append({"match": match, "base_key": base_key, "start": 0 if index == 0 else match.start(), "end": marks[cursor].start() if cursor < len(marks) else len(raw)})
                index = cursor
            seen = {}
            for order, group in enumerate(groups, 1):
                seen[group["base_key"]] = seen.get(group["base_key"], 0) + 1
                key = group["base_key"] if seen[group["base_key"]] == 1 else f"{group['base_key']}__{seen[group['base_key']]}"
                scene = make_scene(number, key, order, raw[group["start"]:group["end"]], version=version)
                if key != group["base_key"]: scene["metadata"].update({"sourceSceneKey": group["base_key"], "sceneKeyAmbiguous": True})
                scenes.append(scene)
        else:
            markers = list(MARKER_RE.finditer(raw))
            if markers:
                for index, match in enumerate(markers):
                    start = 0 if index == 0 else match.start(); end = markers[index + 1].start() if index + 1 < len(markers) else len(raw)
                    scenes.append(make_scene(number, f"{number}-{index + 1}", index + 1, raw[start:end], match.group(1).strip(), version=version))
            else: scenes = [make_scene(number, f"{number}-1", 1, raw, version=version)]
        scenes = apply_scene_splits(number, raw, scenes, [plan for plan in plans if plan["episode"] == number], version=version)
        result.append({"episodeNumber": number, "scenes": scenes})
    return result

def main():
    try:
        payload = json.load(sys.stdin); operation = payload.get("operation")
        value = parse_source(payload) if operation == "parse_source" else parse_scenes(payload) if operation == "parse_scenes" else (_ for _ in ()).throw(ValueError("unknown operation"))
        json.dump({"ok": True, "value": value}, sys.stdout, ensure_ascii=False)
    except Exception as error:
        json.dump({"ok": False, "error": {"code": "SOURCE_PARSER_ERROR", "message": str(error)}}, sys.stdout, ensure_ascii=False)
        sys.exit(1)

if __name__ == "__main__": main()
