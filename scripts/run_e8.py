#!/usr/bin/env python3
"""JSON stdin/stdout wrapper for the deterministic E8 compiler."""

from __future__ import annotations

import json
import sys

from e8_pipeline import compile_unit_prompt, validate_episode_payload


def main() -> None:
    payload = json.load(sys.stdin)
    errors = validate_episode_payload(payload)
    prompts = {}
    if not errors:
        for unit in payload.get("units", []):
            unit_id = unit.get("unit_id")
            if unit_id:
                prompts[unit_id] = compile_unit_prompt(payload, unit_id)
    json.dump({"errors": errors, "prompts": prompts}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
