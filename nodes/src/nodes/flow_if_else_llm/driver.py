# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""IfElseLLMDriver — evaluates a natural-language question via a wired LLM.

Same contract as ``IfElseDriver`` (returns truthy → THEN, falsy → ELSE)
but the boolean comes from an LLM's response to a yes/no question
instead of a sandboxed Python expression.
"""

from __future__ import annotations

import base64
from typing import Any, Optional

from ..flow_base import (
    Decision,
    FlowContext,
    FlowDriverBase,
    FlowResult,
)


# System instruction prepended to every LLM call. Keeps the model
# narrowly focused on yes/no output so the parser is reliable.
_SYSTEM_INSTRUCTION = 'You are a routing classifier. Read the user-supplied content and answer the user-supplied question with EXACTLY one word: either YES or NO. No explanation, no punctuation, no hedging. If the question cannot be answered from the content, reply NO.'

# Suffix appended to the user's question to enforce single-word output.
_FORMAT_INSTRUCTION = '\n\nReply with EXACTLY one word: YES or NO.'


class IfElseLLMDriver(FlowDriverBase):
    """Two-branch driver that delegates the decision to an LLM.

    Every chunk is routed to exactly one branch. When the LLM raises,
    times out, or returns a response that does not start with YES, the
    driver fails closed to ELSE — same contract as ``IfElseDriver``.

    Construction arguments:

    - ``question``: the user-supplied natural-language yes/no question.
    - ``llm_node_id``: the engine node id of the wired LLM (resolved by
      ``IInstance`` via ``getControllerNodeIds('llm')``).
    - ``mime_type``: optional MIME type for binary chunks (image/audio/
      video). Used when wrapping the chunk as a data URL for vision LLMs.
      Defaults to ``'image/png'`` since most vision LLMs accept it.
    - ``payload_name``: the lane binding name (``'text'`` / ``'image'`` /
      etc.) — informational only, used to choose the data-URL vs raw-text
      shape when building the question.
    """

    driver_name = 'flow_if_else_llm'

    def __init__(
        self,
        *,
        question: str,
        llm_node_id: str,
        payload_name: str = 'text',
        mime_type: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        """Configure the LLM-backed condition driver."""
        super().__init__(**kwargs)
        if not question or not question.strip():
            raise ValueError('IfElseLLMDriver requires a non-empty question')
        if not llm_node_id:
            raise ValueError('IfElseLLMDriver requires a wired LLM node id')
        self.question = question.strip()
        self.llm_node_id = llm_node_id
        self.payload_name = payload_name
        self.mime_type = mime_type or 'image/png'

    async def evaluate(self, ctx: FlowContext) -> bool:
        """Build a Question, invoke the wired LLM, return True if the
        answer starts with YES.

        Fails closed to ELSE on any error (LLM exception, timeout, empty
        response, malformed text). The error is surfaced via
        ``ctx.trace.error`` so the UI Errors panel shows the underlying
        cause.
        """
        run_id = ctx.state.get('_run_id', '') if ctx.state else ''
        try:
            question_obj = self._build_question(ctx.chunk)
        except Exception as exc:
            ctx.trace.error(
                run_id,
                f'failed to build question payload: {exc}',
                question=self.question,
                payload_name=self.payload_name,
                action='fail_closed_to_else',
            )
            return False

        try:
            param = self._build_invoke_param(question_obj)
            result = await self.invoker.invoke(param, component_id=self.llm_node_id)
        except Exception as exc:
            ctx.trace.error(
                run_id,
                f'LLM invocation failed: {exc}',
                question=self.question,
                llm_node_id=self.llm_node_id,
                action='fail_closed_to_else',
            )
            return False

        text = self._extract_text(result, param)
        decision = self._parse_yes_no(text)
        ctx.trace.dispatch(
            run_id,
            llm_response=text[:200] if isinstance(text, str) else repr(text)[:200],
            decision='YES' if decision else 'NO',
        )
        return decision

    async def dispatch(self, ctx: FlowContext, decision: bool) -> FlowResult:
        """Wrap the bool decision into a FlowResult with the correct branch."""
        branch = Decision.THEN if decision else Decision.ELSE
        run_id = ctx.state.get('_run_id', '')
        ctx.trace.decision(run_id, decision=branch.value, truthy=decision)
        return FlowResult.emit(payload=ctx.chunk, decision=branch)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _build_question(self, chunk: Any) -> Any:
        """Build a `Question` with the chunk as context and the user's
        prompt + format instruction as the question text.

        For binary lanes (image/audio/video) the chunk is wrapped as a
        data URL so vision LLMs accept it. For text lanes the chunk is
        added verbatim.
        """
        # Lazy import to keep the module test-importable without rocketlib.
        from ai.common.schema import Question

        question_obj = Question()

        if isinstance(chunk, (bytes, bytearray)):
            b64 = base64.b64encode(bytes(chunk)).decode('utf-8')
            question_obj.addContext(f'data:{self.mime_type};base64,{b64}')
        elif chunk is not None:
            # Text-like chunks: include the content directly so a text
            # LLM sees the material without any encoding overhead.
            question_obj.addContext(str(chunk))

        # Put the system instruction INSIDE the user question text rather
        # than as a separate context entry. Reason: vision LLM nodes
        # (e.g. llm_vision_mistral) read images from `question.context`
        # but pull the user prompt from `question.questions[0].text` and
        # ignore non-image context entries. Baking the instruction into
        # the question itself ensures it actually reaches the model
        # regardless of which LLM provider is wired.
        question_obj.addQuestion(
            f'{_SYSTEM_INSTRUCTION}\n\n'
            f'Question: {self.question}'
            f'{_FORMAT_INSTRUCTION}'
        )
        return question_obj

    def _build_invoke_param(self, question_obj: Any) -> Any:
        """Construct the `IInvokeLLM.Ask` envelope for the engine invoke."""
        # Lazy import — keeps the module loadable in pure-Python tests.
        from rocketlib.types import IInvokeLLM

        return IInvokeLLM.Ask(question=question_obj)

    def _extract_text(self, result: Any, param: Any) -> str:
        """Pull the text out of the LLM's response.

        The engine populates the answer either as the return value of
        ``invoke`` or as a field on the param object — depending on the
        LLM node implementation. Try both paths and return the first
        non-empty string.
        """
        for candidate in (result, param):
            if candidate is None:
                continue
            # Direct text on the object
            text = getattr(candidate, 'answer', None) or getattr(candidate, 'output', None)
            if isinstance(text, str) and text.strip():
                return text
            # Answer object with `getText()`
            answer = getattr(candidate, 'answer', None)
            if answer is not None and hasattr(answer, 'getText'):
                try:
                    out = answer.getText()
                    if isinstance(out, str) and out.strip():
                        return out
                except Exception:
                    pass
            # Direct getText() on the candidate
            if hasattr(candidate, 'getText'):
                try:
                    out = candidate.getText()
                    if isinstance(out, str) and out.strip():
                        return out
                except Exception:
                    pass
        return ''

    def _parse_yes_no(self, text: str) -> bool:
        """Return True if the LLM answered YES, False otherwise.

        Matches loosely (case-insensitive, ignores trailing punctuation
        / whitespace) so models that say "Yes." or "Yes!" still resolve
        correctly. Anything that doesn't start with the literal "YES"
        is treated as NO — including malformed or empty responses.
        """
        if not isinstance(text, str):
            return False
        normalized = text.strip().upper().lstrip('"\'').rstrip('.,!?"\'')
        return normalized.startswith('YES')
