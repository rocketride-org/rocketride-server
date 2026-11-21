# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
The two-replica test of memory_persistent (plan 4.3, 5.7, section 12).

The calls of one control alternate between two replicas, each with its own
import of the node and its own IGlobal, sharing only the server's state
store: a session written on one replica is read on the other, every answer
equals a single replica's, and another owner naming the same session id
never sees it. The questions and answers are plain objects carrying the
``metadata`` the node reads, as the node's other tests use.
"""

from __future__ import annotations

from types import SimpleNamespace

from ..framework.replicas import NODES_DIR, Call, Owner, run_alternating_and_alone

NODE_DIR = NODES_DIR / 'memory_persistent'
NODE_ID = 'memory_1'

ALICE = Owner(orgId='org-a', userId='alice')
BOB = Owner(orgId='org-a', userId='bob')


def _text(value):
    """A stable text accessor (one function object, so outputs compare equal)."""
    return lambda: value


def _answer(owner, session, text, **params):
    """One call carrying an answer for a session."""
    answer = SimpleNamespace(metadata={'session_id': session}, getText=_text(text))
    return Call(owner=owner, params=params, invoke=lambda instance: instance.writeAnswers(answer))


def _question(owner, session, **params):
    """One call carrying a question for a session."""
    question = SimpleNamespace(metadata={'session_id': session})
    return Call(owner=owner, params=params, invoke=lambda instance: instance.writeQuestions(question))


def _contexts(outputs):
    """The memory context each forwarded question carried (None when it carried none)."""
    return [
        args[0].metadata.get('memory_context') for call in outputs for name, args in call if name == 'writeQuestions'
    ]


def _run(calls):
    """Play the calls alternately on two replicas and on one."""
    return run_alternating_and_alone(NODE_DIR, 'memory_persistent', NODE_ID, calls)


def test_a_session_written_on_one_replica_is_read_on_the_other():
    calls = [
        _answer(ALICE, 's1', 'first'),
        _question(ALICE, 's1'),
        _answer(ALICE, 's1', 'second'),
        _question(ALICE, 's1'),
        _question(ALICE, 's2'),
    ]
    alternating, reference = _run(calls)
    assert alternating == reference
    assert _contexts(reference) == [
        {'last_answer': 'first', 'answer_count': 1},
        {'last_answer': 'second', 'answer_count': 2},
        None,
    ]


def test_per_call_settings_reach_the_store_on_either_replica():
    # A short history cap with summarization on: the session keeps working
    # whichever replica summarizes it
    calls = [_answer(ALICE, 's1', f'a{i}', max_history=2) for i in range(5)] + [_question(ALICE, 's1')]
    alternating, reference = _run(calls)
    assert alternating == reference
    assert _contexts(reference) == [{'last_answer': 'a4', 'answer_count': 5}]


def test_another_owner_naming_the_same_session_never_sees_it():
    alice = [_answer(ALICE, 'shared', 'secret'), _question(ALICE, 'shared')]
    bob = [_question(BOB, 'shared'), _answer(BOB, 'shared', 'mine'), _question(BOB, 'shared')]
    together, _ = _run([alice[0], bob[0], bob[1], alice[1], bob[2]])
    contexts = _contexts(together)
    # Bob's first question finds nothing, Alice's finds only her own answer, Bob's last only his
    assert contexts == [None, {'last_answer': 'secret', 'answer_count': 1}, {'last_answer': 'mine', 'answer_count': 1}]
