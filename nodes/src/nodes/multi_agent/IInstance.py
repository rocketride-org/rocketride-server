# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Multi-Agent orchestration node instance.

IInstance handles per-request lifecycle.  One IInstance is created per
concurrent incoming question.  It constructs a fresh
:class:`MultiAgentOrchestrator` for each request (so blackboard and
message queues are isolated between requests), runs the orchestration
loop, and writes the unified answer to the ``answers`` lane.
"""

from __future__ import annotations

import copy

from rocketlib import IInstanceBase
from ai.common.schema import Question, Answer

from .IGlobal import IGlobal
from .orchestrator import MultiAgentOrchestrator


class IInstance(IInstanceBase):
    """Pipeline instance for the Multi-Agent orchestration node.

    Receives questions on the ``questions`` lane, runs the multi-agent
    orchestration loop, and emits the merged answer on the ``answers``
    lane with per-agent attribution metadata.
    """

    IGlobal: IGlobal

    def writeQuestions(self, question: Question) -> None:
        """Entry point for the ``questions`` lane.

        Steps:
            1. Parse agent definitions from config.
            2. Create the orchestrator with an LLM callback.
            3. Build the execution plan (supervisor decomposes the task).
            4. Execute agents per plan.
            5. Merge results into a unified answer.
            6. Write the answer with per-agent attribution metadata.
            7. Deep-copy the answer to prevent downstream mutation.
        """
        config = self.IGlobal.config or {}

        # Extract the user's question text.
        question_text = ''
        if hasattr(question, 'questions') and question.questions:
            question_text = ' '.join(q.text if hasattr(q, 'text') else str(q) for q in question.questions)
        if not question_text and hasattr(question, 'getPrompt'):
            question_text = question.getPrompt()
        if not question_text:
            question_text = str(question)

        # LLM callback — routes through the engine's invoke seam.
        def call_llm(system_prompt: str, user_prompt: str) -> str:
            q = Question()
            q.role = system_prompt
            q.addQuestion(user_prompt)
            result = self.instance.invoke('llm', {'op': 'ask', 'question': q})
            if isinstance(result, Answer):
                return result.getText()
            if hasattr(result, 'getText'):
                return result.getText()
            return str(result)

        # Create a fresh orchestrator per request.
        orchestrator = MultiAgentOrchestrator(config, call_llm=call_llm)
        run_result = orchestrator.run(question_text)

        # Build the answer.
        answer = Answer()
        answer.setAnswer(run_result['answer'])

        # Deep-copy to prevent downstream mutation of shared state.
        answer = copy.deepcopy(answer)

        # Emit the answer on the answers lane.
        self.instance.writeAnswers(answer)
