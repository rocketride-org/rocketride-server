# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pins _make_stream_content_parser: the provider-shape → (text, reasoning) seam
that the LLM adapters will absorb. Behavior must not drift during that refactor.
"""

from ai.common.llm_adapter import _make_stream_content_parser


def test_str_passthrough():
    # think-splitter holds a possible partial `<think>` tail until flush.
    parse = _make_stream_content_parser(True)
    text, thinking = parse('hello world')
    tail_text, _ = parse.flush()
    assert text + tail_text == 'hello world'
    assert thinking == ''


def test_anthropic_thinking_then_text():
    parse = _make_stream_content_parser(True)
    text, thinking = parse(
        [
            {'type': 'thinking', 'thinking': 'reasoning...'},
            {'type': 'text', 'text': 'answer'},
        ]
    )
    assert text == 'answer'
    assert thinking == 'reasoning...'


def test_reasoning_block_langchain_v1():
    parse = _make_stream_content_parser(True)
    assert parse([{'type': 'reasoning', 'reasoning': 'r'}]) == ('', 'r')


def test_text_block_without_type():
    parse = _make_stream_content_parser(True)
    assert parse([{'text': 'plain'}]) == ('plain', '')


def test_non_dict_blocks_skipped():
    parse = _make_stream_content_parser(True)
    assert parse(['stray', {'type': 'text', 'text': 'y'}]) == ('y', '')


def test_signature_only_note_emitted_once():
    parse = _make_stream_content_parser(True)
    _, first = parse([{'type': 'thinking', 'signature': 'sig1'}])
    assert 'verification signature' in first
    _, second = parse([{'type': 'thinking', 'signature': 'sig2'}])
    assert second == ''


def test_signature_note_suppressed_without_reasoning_sink():
    parse = _make_stream_content_parser(False)
    _, thinking = parse([{'type': 'thinking', 'signature': 'sig'}])
    assert thinking == ''


def test_inline_think_split_across_feed_and_flush():
    parse = _make_stream_content_parser(True)
    text, thinking = parse('before<think>cot</think>after')
    tail_text, tail_thinking = parse.flush()
    assert text + tail_text == 'beforeafter'
    assert thinking + tail_thinking == 'cot'
