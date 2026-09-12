"""E8 deterministic validator and Seedance prompt compiler."""

from __future__ import annotations

import re
from typing import Any


SEEDANCE_UNIT_ABSOLUTE_MIN_SECONDS = 4.0
SEEDANCE_UNIT_SHORT_MIN_SECONDS = 10.0
SHORT_UNIT_MAX_EXCEPTION_RATIO = 0.1
SHORT_UNIT_MAX_EXCEPTION_COUNT = 2
SHORT_UNIT_EXCEPTION_CODES = {
    "SCENE_BOUNDARY",
    "SHORT_REACTION",
    "PROP_LANDING",
    "QUICK_ACTION_CUT",
    "SOUND_VIEW_BREAK",
    "DRIFT_PREVENTION",
    "OVERLOAD_AVOIDANCE",
}
SHORT_UNIT_EXCEPTION_PATTERN = re.compile(r"^SHORT_EXCEPTION/([A-Z_]+)\s*[|｜:：]\s*(.+)$")
SHORT_UNIT_GENERIC_REASON = re.compile(
    r"^(?:本场)?(?:分镜)?时长组合余数不足\s*\d+(?:\.\d+)?秒?$|^场次边界余数$|^余数不足\s*\d+(?:\.\d+)?秒?$"
)


def _valid_short_unit_exception(value: Any) -> bool:
    text = str(value or "").strip()
    match = SHORT_UNIT_EXCEPTION_PATTERN.fullmatch(text)
    if not match:
        return False
    code, detail = match.groups()
    return code in SHORT_UNIT_EXCEPTION_CODES and len(detail.strip()) >= 8 and not SHORT_UNIT_GENERIC_REASON.fullmatch(detail.strip())


def _max_short_unit_exceptions(total_units: int) -> int:
    total = max(0, int(total_units))
    if total == 0:
        return 0
    return min(SHORT_UNIT_MAX_EXCEPTION_COUNT, max(1, int(total * SHORT_UNIT_MAX_EXCEPTION_RATIO)))


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
    valid_short_exceptions: list[str] = []

    if not payload.get("revision"):
        errors.append(_error("REVISION_MISSING", "revision", "空", "必须提供当前revision", "episode"))

    units = payload.get("units", [])
    for unit in units:
        unit_id = str(unit.get("unit_id", "unknown-unit"))
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

        if unit_duration < SEEDANCE_UNIT_SHORT_MIN_SECONDS:
            reason = str(unit.get("short_unit_reason") or "").strip()
            if unit_duration < SEEDANCE_UNIT_ABSOLUTE_MIN_SECONDS:
                errors.append(
                    _error(
                        "SHORT_UNIT_BELOW_ABSOLUTE_MIN",
                        f"{unit_id}.duration",
                        f"单元{unit_duration}秒，低于{SEEDANCE_UNIT_ABSOLUTE_MIN_SECONDS:g}秒技术下限",
                        f"单元默认至少{SEEDANCE_UNIT_SHORT_MIN_SECONDS:g}秒，且不得低于{SEEDANCE_UNIT_ABSOLUTE_MIN_SECONDS:g}秒",
                        unit_id,
                    )
                )
            elif not reason:
                errors.append(
                    _error(
                        "SHORT_UNIT_EXCEPTION_REQUIRED",
                        f"{unit_id}.short_unit_reason",
                        f"单元{unit_duration}秒，低于{SEEDANCE_UNIT_SHORT_MIN_SECONDS:g}秒且原因为空",
                        "低于10秒默认退回；确需保留时必须填写规范例外事实",
                        unit_id,
                    )
                )
            elif not _valid_short_unit_exception(reason):
                errors.append(
                    _error(
                        "SHORT_UNIT_EXCEPTION_INVALID",
                        f"{unit_id}.short_unit_reason",
                        f"单元{unit_duration}秒的理由不是规范例外格式",
                        "使用SHORT_EXCEPTION/<CODE>|<具体不可合并事实>，不得使用泛化余数理由",
                        unit_id,
                    )
                )
            else:
                valid_short_exceptions.append(unit_id)

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

    max_exceptions = _max_short_unit_exceptions(len(units))
    for index, unit_id in enumerate(valid_short_exceptions):
        if index < max_exceptions:
            continue
        errors.append(
            _error(
                "SHORT_UNIT_EXCEPTION_LIMIT",
                f"{unit_id}.short_unit_reason",
                f"本集第{index + 1}个低于{SEEDANCE_UNIT_SHORT_MIN_SECONDS:g}秒例外，超过最多{max_exceptions}个",
                f"每集低于{SEEDANCE_UNIT_SHORT_MIN_SECONDS:g}秒的例外最多{max_exceptions}个",
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
