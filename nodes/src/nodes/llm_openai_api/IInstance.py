# Copyright (c) 2026 Aparavi Software AG

from ai.common.llm_base import LLMBase


class IInstance(LLMBase):
    provider_shape = 'openai'
    provider_name = 'openai-compat'
