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
import uuid

from rocketlib import IInstanceBase, Entry, debug
from ai.common.schema import Question, Answer

from .IGlobal import IGlobal
from .memory_store import PersistentMemoryStore, StateBackend

# ==== Constants ==================================================================

#: Where the owner's namespace in the control's Redis is kept, in the owner's file store.
REDIS_NAMESPACE_PATH = '.memory_persistent/redis-namespace.json'

#: The state key whose lock makes the first calls of an owner mint one namespace.
_NAMESPACE_LOCK = 'redis-namespace'


class IInstance(IInstanceBase):
    """
    One call's view of the control's sessions.

    preventDefault() raises immediately, so no code may follow it — anything
    added after a preventDefault() call is unreachable at runtime.
    """

    IGlobal: IGlobal
    _current_session_id: str | None = None

    def _store(self) -> PersistentMemoryStore:
        """
        This call's store: the control's backend with this call's history cap, summarization and session ttl.

        A session id names a session of one owner only, on whichever replica
        serves the call. On the ``memory`` branch the backend is this binding's
        ``self.state``, which the server keys by the control's owner. On the
        ``redis`` branch it is the control's pool, which every owner whose
        control points at that Redis reaches, so the call's view keeps the
        owner's sessions under the owner's namespace (plan 12 B).

        Returns:
            The store this call reads and writes.
        """
        settings = self.settings
        redis = self.IGlobal.redis
        backend = redis.for_namespace(self._redis_namespace()) if redis is not None else StateBackend(self.state)
        return PersistentMemoryStore(
            backend,
            max_history=settings.max_history,
            auto_summarize=settings.auto_summarize,
            session_ttl_hours=float(settings.session_ttl_hours),
        )

    def _redis_namespace(self) -> str:
        """
        The owner's namespace in the control's Redis.

        The node never keys what it keeps by the caller (plan 4.1 rule 7,
        5.7): the namespace is a random id minted once into the owner's file
        store, which the server roots at the binding's owner, and read back by
        every later call on any replica. A file, not state: a session in Redis
        may outlive the state store's seven days. The state lock makes the
        first calls of one node agree on one id; two pipelines of one owner
        minting at the same instant can each write one, and the call whose id
        is overwritten loses what it stored (never another owner's data).

        Returns:
            The namespace id.
        """
        files = self.files
        if files.stat(REDIS_NAMESPACE_PATH).get('exists'):
            return files.get_json(REDIS_NAMESPACE_PATH)['namespace']
        with self.state.lock(_NAMESPACE_LOCK):
            if files.stat(REDIS_NAMESPACE_PATH).get('exists'):
                return files.get_json(REDIS_NAMESPACE_PATH)['namespace']
            namespace = uuid.uuid4().hex
            files.put_json(REDIS_NAMESPACE_PATH, {'namespace': namespace})
            return namespace

    def open(self, _obj: Entry) -> None:
        """Reset per-object state for the current pipeline item.

        Args:
            _obj: The object being opened (unused).
        """
        self._current_session_id = None

    def writeQuestions(self, question: Question) -> None:
        """Load session context from memory and attach to question metadata, then forward.

        If a ``session_id`` is present in the question metadata, retrieves all
        stored keys for that session and injects them as context so downstream
        nodes (e.g. LLMs) can use prior conversation state.

        Args:
            question: The question from the questions lane; it is copied, never mutated.
        """
        store = self._store()

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
                return self.preventDefault()

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

        # Forward the (possibly enriched) question downstream. preventDefault()
        # suppresses the engine's automatic default forward, which would
        # otherwise deliver the question a second time (the unenriched original).
        self.instance.writeQuestions(question)
        return self.preventDefault()

    def writeAnswers(self, answer: Answer) -> None:
        """Store answer text in session memory for future retrieval, then forward.

        If the answer carries a ``session_id`` in its metadata, persists the
        answer text under the key ``last_answer`` (and increments a counter).

        Args:
            answer: The answer from the answers lane; it is copied, never mutated.
        """
        store = self._store()

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
                return self.preventDefault()

            # Store the answer text
            answer_text = answer.getText() if hasattr(answer, 'getText') else str(answer)
            store.put(session_id, 'last_answer', answer_text)

            # Atomic increment: in-memory backend uses a lock, Redis uses INCRBY
            store.increment(session_id, 'answer_count')

            debug(f'Stored answer in session {session_id}')

        # Forward the answer downstream. preventDefault() suppresses the
        # engine's automatic default forward, which would otherwise deliver
        # the answer a second time (a separate deep-copied object).
        self.instance.writeAnswers(answer)
        return self.preventDefault()
