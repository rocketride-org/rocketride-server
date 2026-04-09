# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Persistent Memory node instance.

Intercepts questions to attach session context from persistent memory,
and stores answers back into the session for future retrieval.
"""

from __future__ import annotations

import copy

from rocketlib import IInstanceBase, Entry, debug
from ai.common.schema import Question, Answer

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Pipeline instance for the memory_persistent node."""

    IGlobal: IGlobal
    _current_session_id: str | None = None

    def open(self, _obj: Entry) -> None:
        """Reset per-object state for the current pipeline item."""
        self._current_session_id = None

    def writeQuestions(self, question: Question) -> None:
        """Load session context from memory and attach to question metadata, then forward.

        If a ``session_id`` is present in the question metadata, retrieves all
        stored keys for that session and injects them as context so downstream
        nodes (e.g. LLMs) can use prior conversation state.
        """
        store = self.IGlobal.store
        if store is None:
            self.instance.writeQuestions(question)
            return

        # Deep copy to prevent mutation of the original question
        question = copy.deepcopy(question)

        # Extract session_id from question metadata (if present)
        session_id = None
        if hasattr(question, 'metadata') and isinstance(question.metadata, dict):
            session_id = question.metadata.get('session_id')
        self._current_session_id = session_id

        if session_id:
            # Ensure session exists (resume or create).
            # Catch ValueError from malformed session_id so the pipeline
            # continues with the question forwarded unchanged.
            try:
                resume = store.resume_session(session_id)
                if not resume.get('ok'):
                    store.create_session(session_id)
            except ValueError:
                self._current_session_id = None
                debug(f'Ignoring invalid session_id in question metadata: {session_id!r}')
                self.instance.writeQuestions(question)
                return

            # Load all keys from the session
            keys_result = store.list_keys(session_id)
            if keys_result.get('ok'):
                memory_context = {}
                for key in keys_result.get('keys', []):
                    val_result = store.get(session_id, key)
                    if val_result.get('ok'):
                        memory_context[key] = val_result['value']

                if memory_context:
                    # Attach memory context to question metadata
                    if not hasattr(question, 'metadata') or question.metadata is None:
                        question.metadata = {}
                    question.metadata['memory_context'] = memory_context
                    debug(f'Attached {len(memory_context)} memory keys to question for session {session_id}')

        # Forward the (possibly enriched) question downstream
        self.instance.writeQuestions(question)

    def writeAnswers(self, answer: Answer) -> None:
        """Store answer text in session memory for future retrieval, then forward.

        If the answer carries a ``session_id`` in its metadata, persists the
        answer text under the key ``last_answer`` (and increments a counter).
        """
        store = self.IGlobal.store
        if store is None:
            self.instance.writeAnswers(answer)
            return

        # Deep copy to prevent mutation
        answer = copy.deepcopy(answer)

        # Extract session_id from answer metadata
        session_id = None
        if hasattr(answer, 'metadata') and isinstance(answer.metadata, dict):
            session_id = answer.metadata.get('session_id')
        if not session_id:
            session_id = self._current_session_id

        if session_id:
            # Ensure session exists.
            # Catch ValueError from malformed session_id so the pipeline
            # continues with the answer forwarded unchanged.
            try:
                resume = store.resume_session(session_id)
                if not resume.get('ok'):
                    store.create_session(session_id)
            except ValueError:
                debug(f'Ignoring invalid session_id in answer metadata: {session_id!r}')
                self.instance.writeAnswers(answer)
                return

            # Store the answer text
            answer_text = answer.getText() if hasattr(answer, 'getText') else str(answer)
            store.put(session_id, 'last_answer', answer_text)

            # Atomic increment: in-memory backend uses a lock, Redis uses INCRBY
            store.increment(session_id, 'answer_count')

            debug(f'Stored answer in session {session_id}')

        # Forward the answer downstream
        self.instance.writeAnswers(answer)
