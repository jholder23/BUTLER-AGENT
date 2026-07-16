"""sd_prompt_enhance: user base prompts merged before Butler auto-tags."""

import json

import sd_prompt_enhance as spe


def test_merge_prompts_user_first_then_base(monkeypatch, tmp_path):
    cfg = tmp_path / "comfy_config.json"
    cfg.write_text(
        json.dumps(
            {
                "base_positive_prompt": "bedroom, dslr",
                "base_negative_prompt": "low quality",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(spe, "_comfy_config_json_path", lambda: cfg)
    monkeypatch.setattr(spe, "_sd_project_path_for_prompts", lambda: tmp_path)
    monkeypatch.delenv("BUTLER_SD_BASE_POSITIVE", raising=False)
    monkeypatch.delenv("BUTLER_SD_BASE_NEGATIVE", raising=False)
    monkeypatch.delenv("BUTLER_SD_BASE_PROMPTS_JSON", raising=False)

    pos, neg = spe.merge_prompts_with_user_sd_base("smiling, warm light", "extra fog")
    assert pos.lower().startswith("smiling")
    assert "warm light" in pos
    assert "bedroom" in pos
    assert "dslr" in pos
    assert "low quality" in neg
    assert "fog" in neg


def test_enhance_for_comfy_respects_base_and_user_tokens_for_style_gate(monkeypatch, tmp_path):
    cfg = tmp_path / "comfy_config.json"
    cfg.write_text(json.dumps({"base_positive_prompt": "8k uhd, bedroom", "base_negative_prompt": ""}), encoding="utf-8")
    monkeypatch.setattr(spe, "_comfy_config_json_path", lambda: cfg)
    monkeypatch.setattr(spe, "_sd_project_path_for_prompts", lambda: tmp_path)
    monkeypatch.delenv("BUTLER_SD_BASE_POSITIVE", raising=False)
    monkeypatch.delenv("BUTLER_SD_BASE_NEGATIVE", raising=False)
    monkeypatch.delenv("BUTLER_SD_BASE_PROMPTS_JSON", raising=False)
    monkeypatch.delenv("BUTLER_SKIP_SD_PROMPT_ENHANCE", raising=False)

    # Style classification uses user message only — "oil painting" is user text, not in base.
    pos, _neg = spe.enhance_for_comfy("oil painting of a vase", "", mode="txt2img")
    assert "oil painting" in pos.lower()
    assert "bedroom" in pos.lower()
    assert "RAW photo" not in pos
    assert "hyperdetailed" not in pos.lower()
