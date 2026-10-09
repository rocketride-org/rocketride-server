# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================
"""System One node v2: text (buffered), questions (truncate + warn) and answers lanes."""

from types import SimpleNamespace

import pytest

from ai.common.systemone.client import SystemOneError

from .conftest import Answer, Prevented, group


def test_text_is_buffered_then_decided_once_at_closing_and_replayed_in_order(node):
    for chunk in ('Hello ', 'world'):
        with pytest.raises(Prevented):
            node.inst.writeText(chunk)
    assert node.written['text'] == [] and node.client.states == []
    node.inst.closing()
    assert node.client.states == ['Hello world']
    item = group(node)['items'][0]
    assert item['lane'] == 'text' and item['status'] == 'ok' and 'item' not in item
    assert item['preview'] == 'Hello world'
    assert node.written['text'] == ['Hello ', 'world']


def test_text_over_the_limit_fails_early_without_buffering_more(node):
    with pytest.raises(ValueError, match='never decides on part of an input'):
        node.inst.writeText('x' * 2000)
    assert node.client.states == []


def test_closing_after_a_too_long_text_failure_is_quiet_and_makes_no_call(node):
    with pytest.raises(ValueError, match='too long'):
        node.inst.writeText('x' * 2000)
    node.inst.closing()  # must not raise a second too-long error
    assert node.client.states == [] and node.written['text'] == []
    assert node.inst._text is None or node.inst._text == []
    node.inst.open(None)
    with pytest.raises(Prevented):
        node.inst.writeText('hello')
    node.inst.closing()
    assert len(node.client.states) == 1 and node.written['text'] == ['hello']


def test_blank_text_fails_at_closing(node):
    with pytest.raises(Prevented):
        node.inst.writeText('   ')
    with pytest.raises(ValueError, match='no text to decide on'):
        node.inst.closing()


def test_no_text_writes_means_no_item_and_no_error(node):
    node.inst.closing()
    assert 'decisions' not in node.inst.instance.currentObject.response


def test_open_clears_the_text_buffer(node):
    with pytest.raises(Prevented):
        node.inst.writeText('left over')
    node.inst.open(None)
    node.inst.closing()
    assert node.written['text'] == []


def test_backend_too_large_on_text_fails_the_object(node):
    node.client.error = SystemOneError('too_large', '413', status=413)
    with pytest.raises(Prevented):
        node.inst.writeText('hello')
    with pytest.raises(ValueError, match='never decides on part of an input'):
        node.inst.closing()


def _question(text='Is this urgent?', history=(), documents=()):
    return SimpleNamespace(
        questions=[SimpleNamespace(text=text)],
        history=[SimpleNamespace(role='user', content=h) for h in history],
        context=[],
        documents=[SimpleNamespace(page_content=d) for d in documents],
    )


def test_question_is_decided_and_forwarded_by_default(node):
    assert node.inst.writeQuestions(_question()) is None
    assert node.client.states == [{'question': 'Is this urgent?', 'history': [], 'context': [], 'documents': []}]
    item = group(node)['items'][0]
    assert item['lane'] == 'questions' and 'truncated' not in item


def test_long_question_history_is_truncated_with_a_warning(node):
    node.inst.writeQuestions(_question(history=('old ' * 200, 'recent')))
    sent = node.client.states[0]
    assert sent['history'] == [{'role': 'user', 'content': 'recent'}]
    item = group(node)['items'][0]
    assert item['truncated'] is True and item['size']['limit'] == 400
    assert any('truncated' in w for w in node.warnings)


def test_question_too_long_on_its_own_fails(node):
    with pytest.raises(ValueError, match='question does not fit'):
        node.inst.writeQuestions(_question(text='q' * 3000))


def test_empty_question_fails(node):
    with pytest.raises(ValueError, match='no text'):
        node.inst.writeQuestions(_question(text='  '))


def test_json_answer_is_sent_as_json_state(node):
    assert node.inst.writeAnswers(Answer({'summary': 'urgent outage'}, expectJson=True)) is None
    assert node.client.states == [{'summary': 'urgent outage'}]
    assert group(node)['items'][0]['lane'] == 'answers'


def test_text_answer_is_sent_as_text(node):
    node.inst.writeAnswers(Answer('the outage is urgent'))
    assert node.client.states == ['the outage is urgent']


def test_json_flagged_plain_text_answer_is_sent_as_its_text(node):
    node.inst.writeAnswers(Answer('the outage is urgent', expectJson=True))
    assert node.client.states == ['the outage is urgent']


def test_json_flagged_non_string_answer_is_sent_as_its_text(node):
    node.inst.writeAnswers(Answer(42, expectJson=True))
    assert node.client.states == ['42']


def test_empty_answer_fails(node):
    with pytest.raises(ValueError, match='empty'):
        node.inst.writeAnswers(Answer('  '))


def test_too_long_answer_fails(node):
    with pytest.raises(ValueError, match='never decides on part of an input'):
        node.inst.writeAnswers(Answer('x' * 2000))


def test_text_and_documents_on_one_node_write_separate_items(node):
    from .conftest import Doc, Meta

    with pytest.raises(Prevented):
        node.inst.writeText('whole email')
    with pytest.raises(Prevented):
        node.inst.writeDocuments([Doc('chunk', Meta(objectId='o', chunkId=0))])
    node.inst.closing()
    lanes = [i['lane'] for i in group(node)['items']]
    assert lanes == ['documents', 'text']
