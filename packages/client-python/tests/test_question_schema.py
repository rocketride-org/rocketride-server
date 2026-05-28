# Copyright (c) 2026 Aparavi Software AG
# SPDX-License-Identifier: MIT
"""Unit tests for Attachment schema and Question.attachments round-trip."""

from rocketride.schema import Attachment, Question, QuestionHistory


def _att() -> Attachment:
    return Attachment(
        attachment_id='11111111-1111-1111-1111-111111111111',
        mime='application/pdf',
        filename='report.pdf',
        size_bytes=482113,
        path='.chats/22222222-2222-2222-2222-222222222222/11111111-1111-1111-1111-111111111111.pdf',
    )


def test_attachment_round_trips_through_question():
    q = Question()
    q.attachments = [_att()]
    round_q = Question.model_validate(q.model_dump())
    assert round_q.attachments == [_att()]


def test_question_attachments_defaults_to_empty_list():
    q = Question()
    assert q.attachments == []
    round_q = Question.model_validate(q.model_dump())
    assert round_q.attachments == []


def test_question_history_attachments_round_trips():
    q = Question()
    q.history = [
        QuestionHistory(role='user', content='first', attachments=[_att()]),
        QuestionHistory(role='assistant', content='second'),
    ]
    round_q = Question.model_validate(q.model_dump())
    assert round_q.history[0].attachments == [_att()]
    assert round_q.history[1].attachments is None
