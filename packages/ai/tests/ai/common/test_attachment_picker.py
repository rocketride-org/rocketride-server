# Copyright (c) 2026 Aparavi Software AG
# SPDX-License-Identifier: MIT
"""Attachment picker contract (TDD §6.5, §10.3)."""

from ai.common.schema import Attachment
from ai.common.attachment_picker import pick_for_property, pick_for_tool_call


def _att(mime: str, name: str = 'x') -> Attachment:
    return Attachment(
        attachment_id=f'{mime.replace("/", "-")}-id'.ljust(36, 'a')[:36],
        mime=mime,
        filename=name,
        size_bytes=1,
        path=f'.chats/c/{name}.bin',
    )


def test_picker_matches_first_attachment_whose_mime_matches_pattern():
    candidates = [_att('image/png'), _att('application/pdf'), _att('image/jpeg')]
    picked = pick_for_property(
        prop_schema={'format': 'rocketride-attachment', 'x-rocketride-mimes': ['application/pdf']},
        candidates=candidates,
    )
    assert picked is not None and picked.mime == 'application/pdf'


def test_picker_supports_wildcard_mime_patterns():
    candidates = [_att('application/pdf'), _att('image/png')]
    picked = pick_for_property(
        prop_schema={'format': 'rocketride-attachment', 'x-rocketride-mimes': ['image/*']},
        candidates=candidates,
    )
    assert picked is not None and picked.mime == 'image/png'


def test_picker_returns_none_when_no_candidate_matches():
    candidates = [_att('image/png')]
    picked = pick_for_property(
        prop_schema={'format': 'rocketride-attachment', 'x-rocketride-mimes': ['application/pdf']},
        candidates=candidates,
    )
    assert picked is None


def test_picker_accepts_any_attachment_when_x_rocketride_mimes_absent():
    candidates = [_att('application/zip')]
    picked = pick_for_property(
        prop_schema={'format': 'rocketride-attachment'},
        candidates=candidates,
    )
    assert picked is not None


def test_pick_for_tool_call_builds_path_kwargs_for_each_attachment_property():
    schema = {
        'type': 'object',
        'properties': {
            'document': {
                'type': 'string',
                'format': 'rocketride-attachment',
                'x-rocketride-mimes': ['application/pdf'],
            },
            'topic': {'type': 'string'},
        },
        'required': ['document'],
    }
    candidates = [_att('application/pdf', 'r.pdf')]
    kwargs = pick_for_tool_call(input_schema=schema, candidates=candidates)
    assert kwargs == {'document': '.chats/c/r.pdf.bin'}
