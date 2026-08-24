from e8_pipeline import compile_unit_prompt, validate_episode_payload


def sample_payload():
    return {
        "revision": "V1_08141600",
        "project": {
            "style_prompt": "16:9，3D国漫电影级质感",
            "negative_prompt": "无字幕、无文字、无重影、无闪烁",
        },
        "scenes": {
            "SC1": {
                "name": "大考秘境·森林空地",
                "interior_exterior": "外",
                "time": "日",
                "weather": "薄雾",
                "time_layer": "现实",
            }
        },
        "units": [
            {
                "unit_id": "1-1-U01",
                "scene_id": "SC1",
                "time_layer": "现实",
                "duration": 12.0,
                "character_assets": ["赵清雅｜校服·正常", "苏远｜校服·受伤"],
                "prop_assets": ["长剑"],
                "start_premise": "赵清雅站在苏远前方一步，苏远半跪扶剑。",
                "end_state": "苏远起身站稳，赵清雅仍面向他。",
                "shots": [
                    {
                        "shot_id": "1-1-S01",
                        "scene_id": "SC1",
                        "time_layer": "现实",
                        "duration": 5.0,
                        "story": "赵清雅回头确认苏远伤势。",
                        "performance": "赵清雅目光停在苏远肩部伤口。",
                        "blocking": "赵清雅原地回身；苏远保持半跪。",
                        "camera": "双人中景，固定镜头。",
                        "dialogue": [],
                    },
                    {
                        "shot_id": "1-1-S02",
                        "scene_id": "SC1",
                        "time_layer": "现实",
                        "duration": 7.0,
                        "story": "苏远撑剑起身。",
                        "performance": "苏远咬紧牙关，呼吸压住后起身。",
                        "blocking": "苏远以长剑支撑，由半跪起身站稳。",
                        "camera": "中近景，轻缓跟随起身。",
                        "dialogue": [{"speaker": "苏远", "type": "对白", "text": "我还能走。", "duration": 2.0}],
                    },
                ],
            }
        ],
    }


payload = sample_payload()
assert validate_episode_payload(payload) == []

prompt = compile_unit_prompt(payload, "1-1-U01")
expected_order = [
    "16:9，3D国漫电影级质感",
    "大考秘境·森林空地｜外｜日｜薄雾｜现实",
    "赵清雅｜校服·正常、苏远｜校服·受伤",
    "赵清雅站在苏远前方一步，苏远半跪扶剑。",
    "赵清雅回头确认苏远伤势。",
    "苏远：我还能走。",
    "苏远起身站稳，赵清雅仍面向他。",
    "无字幕、无文字、无重影、无闪烁",
]
positions = [prompt.index(part) for part in expected_order]
assert positions == sorted(positions)

bad = sample_payload()
bad["units"][0]["shots"][1]["dialogue"][0] = {
    "speaker": "苏远",
    "type": "对白",
    "text": "这句话明显超过两秒钟能够稳定说完的容量",
    "duration": 2.0,
}
errors = validate_episode_payload(bad)
assert any(error["code"] == "DIALOGUE_CAPACITY_EXCEEDED" for error in errors)

print("PASS E8 validation and deterministic compilation")
