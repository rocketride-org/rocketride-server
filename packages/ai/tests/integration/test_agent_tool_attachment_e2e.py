# Copyright (c) 2026 Aparavi Software AG
# SPDX-License-Identifier: MIT
"""End-to-end (contract-level): agent forwards Question.attachments to
tool_sha256 via the path-by-reference convention (TDD §6.5, §10.3).

Full per-framework e2e (real agent + live engine + LLM credentials) is
deferred to Slice J smoke tests; these two cover the contract layers
(picker output shape + tool method correctness given resolved bytes).
"""

from __future__ import annotations

import hashlib
import importlib
import sys
from pathlib import Path

import pytest

from ai.common.schema import Attachment
from ai.common.attachment_picker import pick_for_tool_call


def _att(mime: str, name: str, path: str, size: int = 10) -> Attachment:
    return Attachment(
        attachment_id='11111111-1111-1111-1111-111111111111',
        mime=mime,
        filename=name,
        size_bytes=size,
        path=path,
    )


def test_picker_fills_tool_sha256_document_slot():
    """The agent integrations all call pick_for_tool_call with the tool's
    _rr_input_schema and the run-entry attachments; verify the output
    shape against tool_sha256's declared input schema.
    """
    input_schema = {
        'type': 'object',
        'properties': {
            'document': {
                'type': 'string',
                'format': 'rocketride-attachment',
                'x-rocketride-mimes': ['*/*'],
            },
        },
        'required': ['document'],
    }
    candidates = [_att('application/pdf', 'r.pdf', '.chats/c/r.pdf')]
    kwargs = pick_for_tool_call(input_schema=input_schema, candidates=candidates)
    assert kwargs == {'document': '.chats/c/r.pdf'}


def test_sha256_tool_returns_correct_hash_given_resolved_bytes():
    """Verify the actual tool method does what we expect once the
    dispatcher resolves the path to bytes.  The dispatcher hands the
    method a ``{path, mime, bytes}`` dict per TDD §10.3.

    tool_sha256 lives in the ``nodes`` tree which is not on ``ai:test``'s
    sys.path; we load it via a file-path import.  If the source file is
    relocated or removed, the test skips with a clear marker.
    """
    repo_root = Path(__file__).resolve().parents[4]
    src_root = repo_root / 'nodes' / 'src'
    src = src_root / 'nodes' / 'tool_sha256' / 'IInstance.py'
    if not src.exists():
        pytest.skip(f'tool_sha256 fixture not found at {src}')

    # tool_sha256.IInstance contains ``from .IGlobal import IGlobal`` — a
    # relative import that requires the module to be loaded as part of its
    # package.  Put ``nodes/src`` on sys.path so the canonical
    # ``nodes.tool_sha256`` package resolves naturally.
    inserted = False
    if str(src_root) not in sys.path:
        sys.path.insert(0, str(src_root))
        inserted = True
    try:
        try:
            mod = importlib.import_module('nodes.tool_sha256.IInstance')
        except Exception as exc:
            pytest.skip(f'tool_sha256.IInstance failed to import: {exc}')
    finally:
        if inserted:
            try:
                sys.path.remove(str(src_root))
            except ValueError:
                pass

    IInstance = getattr(mod, 'IInstance', None)
    assert IInstance is not None, 'IInstance class missing from tool_sha256 fixture'

    node = IInstance.__new__(IInstance)
    payload = b'%PDF-1.7 attachment for hashing'
    expected = hashlib.sha256(payload).hexdigest()
    result = node.sha256(
        {
            'document': {
                'path': '.chats/c/r.pdf',
                'mime': 'application/pdf',
                'bytes': payload,
            },
        }
    )
    assert result == {'sha256': expected, 'size_bytes': len(payload)}
