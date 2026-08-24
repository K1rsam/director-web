"""E8 deterministic validator and Seedance prompt compiler."""

from __future__ import annotations

import re
from typing import Any


def _spoken_char_count(text: str) -> int:
    return len(re.sub(r"[\s，。！？、；：,.!?;:‘’“”\"'（）()《》【】—…-]", "", text))


def _error(code: str, coordinate: str, current: str, expected: str, unit_id: str) -> dict[str, Any]:
    return {
        "code": code,
        "coordinate": coordinate,
        "current": current,
        "expected": expected,
        "impact": [unit_id],
    }


def validate_episode_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Return deterministic blocking errors; an empty list means validation passed."""
    errors: list[dict[str, Any]] = []
    scenes = payload.get("scenes", {})

    if not payload.get("revision"):
        errors.append(_error("REVISION_MISSING", "revision", "空", "必须提供当前revision", "episode"))

    for unit in payload.get("units", []):
        unit_id = unit.get("unit_id", "unknown-unit")
        scene_id = unit.get("scene_id")
        scene = scenes.get(scene_id)
        if not scene:
            errors.append(_error("SCENE_NOT_FOUND", f"{unit_id}.scene_id", str(scene_id), "引用存在的场景ID", unit_id))
            continue

        shots = unit.get("shots", [])
        shot_duration = round(sum(float(shot.get("duration", 0)) for shot in shots), 1)
        unit_duration = round(float(unit.get("duration", 0)), 1)
        if shot_duration != unit_duration:
            errors.append(
                _error(
                    "UNIT_DURATION_MISMATCH",
                    f"{unit_id}.duration",
                    f"单元{unit_duration}秒 / 镜号合计{shot_duration}秒",
                    "单元时长等于镜号时长之和",
                    unit_id,
                )
            )

        if unit_duration < 12 and not unit.get("short_unit_reason"):
            errors.append(
                _error(
                    "SHORT_UNIT_REASON_MISSING",
                    f"{unit_id}.short_unit_reason",
                    f"{unit_duration}秒且原因为空",
                    "低于12秒时填写合理的短单元原因",
                    unit_id,
                )
            )

        for shot in shots:
            shot_id = shot.get("shot_id", "unknown-shot")
            if shot.get("scene_id") != scene_id:
                errors.append(
                    _error(
                        "UNIT_CROSSES_SCENE",
                        f"{shot_id}.scene_id",
                        str(shot.get("scene_id")),
                        f"与单元场景{scene_id}一致",
                        unit_id,
                    )
                )
            if shot.get("time_layer") != unit.get("time_layer"):
                errors.append(
                    _error(
                        "UNIT_CROSSES_TIME_LAYER",
                        f"{shot_id}.time_layer",
                        str(shot.get("time_layer")),
                        f"与单元时间层{unit.get('time_layer')}一致",
                        unit_id,
                    )
                )

            for index, speech in enumerate(shot.get("dialogue", [])):
                seconds = float(speech.get("duration", 0))
                count = _spoken_char_count(str(speech.get("text", "")))
                if seconds <= 0 or count > seconds * 6:
                    errors.append(
                        _error(
                            "DIALOGUE_CAPACITY_EXCEEDED",
                            f"{shot_id}.dialogue[{index}]",
                            f"{count}字 / {seconds:.1f}秒",
                            f"不超过{int(seconds * 6)}字，或由E1建立真实视觉切镜",
                            unit_id,
                        )
                    )

    return errors


def compile_unit_prompt(payload: dict[str, Any], unit_id: str) -> str:
    """Compile one unit in the fixed E8 order without model calls."""
    unit = next((item for item in payload.get("units", []) if item.get("unit_id") == unit_id), None)
    if not unit:
        raise ValueError(f"Unit not found: {unit_id}")

    errors = [error for error in validate_episode_payload(payload) if unit_id in error["impact"]]
    if errors:
        raise ValueError(f"Unit validation failed: {errors}")

    project = payload.get("project", {})
    scene = payload["scenes"][unit["scene_id"]]
    scene_line = "｜".join(
        str(scene.get(key, "")).strip()
        for key in ("name", "interior_exterior", "time", "weather", "time_layer")
        if str(scene.get(key, "")).strip()
    )

    assets = list(unit.get("character_assets", [])) + list(unit.get("prop_assets", []))
    stages: list[str] = []
    speech_lines: list[str] = []
    elapsed = 0.0
    for shot in unit.get("shots", []):
        duration = float(shot.get("duration", 0))
        end = elapsed + duration
        details = "；".join(
            str(shot.get(key, "")).strip()
            for key in ("story", "performance", "blocking", "camera")
            if str(shot.get(key, "")).strip()
        )
        stages.append(f"{elapsed:.1f}–{end:.1f}秒｜{shot.get('shot_id')}｜{details}")
        for speech in shot.get("dialogue", []):
            label = speech.get("type", "对白")
            speaker = speech.get("speaker", "")
            prefix = f"{label} {speaker}".strip() if label != "对白" else speaker
            speech_lines.append(f"{prefix}：{speech.get('text', '')}")
        elapsed = end

    sections = [
        f"[项目母提示词]\n{project.get('style_prompt', '')}",
        f"[场景]\n{scene_line}",
        f"[本单元资产]\n{'、'.join(assets) if assets else '无'}",
        f"[开始状态]\n{unit.get('start_premise', '')}",
        "[分镜执行]\n" + "\n".join(stages),
    ]
    if speech_lines:
        sections.append("[对白与声音]\n" + "\n".join(speech_lines))
    sections.extend(
        [
            f"[结束状态]\n{unit.get('end_state', '')}",
            f"[负面约束]\n{project.get('negative_prompt', '')}",
        ]
    )
    return "\n\n".join(sections).strip()
