# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
LangChain adapter that routes ragas LLM calls through the pipeline's connected LLM.

ragas uses LangChain's BaseChatModel interface internally. This bridge wraps
the engine's synchronous invoke('llm', ...) call so ragas uses the pipeline's
own judge model — no separate API key required.
"""

from typing import Any, List, Optional
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage, AIMessage
from langchain_core.outputs import ChatResult, ChatGeneration
from pydantic import PrivateAttr
from rocketlib.types import IInvokeLLM
from ai.common.schema import Question, QuestionType


class RocketRideChatModel(BaseChatModel):
    """
    LangChain BaseChatModel that routes calls through the pipeline's connected LLM.

    ragas wraps this with LangchainLLMWrapper and calls it during metric scoring.
    Both sync (_generate) and async (_agenerate) paths delegate to the engine's
    synchronous invoke — safe because the engine has no running event loop.
    """

    _instance: Any = PrivateAttr()

    def __init__(self, instance: Any):
        super().__init__()
        self._instance = instance

    @property
    def _llm_type(self) -> str:
        return 'rocketride'

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        # Flatten the LangChain message list into a single prompt string
        prompt_parts = []
        for msg in messages:
            role = getattr(msg, 'type', 'human').upper()
            prompt_parts.append(f'{role}: {msg.content}')
        prompt = '\n'.join(prompt_parts)

        question = Question(type=QuestionType.QUESTION)
        question.addContext(prompt)

        result = self._instance.invoke('llm', IInvokeLLM(op='ask', question=question))
        text = result.getText()

        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text))])

    async def _agenerate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        # ragas calls this async path — delegate to the sync engine invoke
        return self._generate(messages, stop, run_manager, **kwargs)
