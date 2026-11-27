from memory_engine.llm import chat_template_kwargs


def test_inkling_gets_reasoning_effort_none() -> None:
    assert chat_template_kwargs("Inkling-2-Mini-UD-Q8_K_XL") == {"enable_thinking": False, "reasoning_effort": "none"}


def test_other_models_get_only_enable_thinking() -> None:
    for model in ("gemma-4-e4b-it-obliterated-q8_0", "gpt-oss-20b", "qwen"):
        assert chat_template_kwargs(model) == {"enable_thinking": False}
