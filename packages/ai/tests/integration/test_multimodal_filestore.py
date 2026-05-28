# Copyright (c) 2026 Aparavi Software AG
# SPDX-License-Identifier: MIT
"""Multimodal round-trip per FileStore backend.

Exercises the end-to-end Feature 2 happy path against each supported
FileStore backend:

    upload payload  →  persist Question.attachments to chat.jsonl
                    →  reopen chat
                    →  read the bytes back from
                       .chats/<chat-guid>/<attachment-id>.<ext>

``filesystem://`` runs unconditionally in CI; ``s3://`` and ``azure://``
are gated on the presence of credential environment variables so the
test matrix can run in either an offline contributor environment or a
fully-credentialed CI lane.

The full body of this test requires a live FileStore harness + engine
pipeline.  It is intentionally a SKIPPING stub: it asserts the gating
logic up to the point where the live harness would take over.  When
the CI matrix gains a FileStore + engine fixture, fill in the body in
place of the ``pytest.skip(...)`` call.
"""

from __future__ import annotations

import os

import pytest


def _filestore_available_for(backend: str) -> bool:
    """Return True if the test process can reach ``backend``.

    Filesystem backends are always available.  Cloud backends require
    their credential env vars to be present; otherwise we skip the
    parameterization rather than fail.
    """
    if backend.startswith('filesystem://'):
        return True
    if backend.startswith('s3://'):
        return all(os.getenv(k) for k in ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'))
    if backend.startswith('azure://'):
        return all(os.getenv(k) for k in ('AZURE_STORAGE_ACCOUNT', 'AZURE_STORAGE_KEY'))
    return False


@pytest.mark.parametrize(
    'backend_url',
    [
        'filesystem://./tmp-test-multimodal',
        's3://rocketride-test/multimodal-test',
        'azure://rocketride-test/container/multimodal-test',
    ],
)
def test_upload_persist_reload_delete_round_trip(backend_url: str) -> None:
    """Stub: round-trip the full upload→persist→reload→delete cycle.

    Steps the live version exercises:

      1. Build a per-account FileStore against ``backend_url``.
      2. Upload a ~5 MB binary payload through the chunked write path
         that mirrors ``apps/chat-ui/src/utils/uploadAttachment.ts``.
      3. Append a turn line carrying the resulting Attachment under
         ``question.attachments`` to ``.chats/<chat-guid>/chat.jsonl``.
      4. Close + reopen the chat; verify the catalog entry is correct
         and the turn line round-trips with attachment metadata intact.
      5. Read the bytes back from the path; assert byte-for-byte
         equality with the original payload.
      6. Hard-delete the chat; assert the whole ``.chats/<chat-guid>/``
         directory is gone (recursive `fsRmdir`).

    Until the FileStore + engine harness lands in CI, we skip with a
    clear reason so the matrix stays green and the intent is preserved
    in code.
    """
    if not _filestore_available_for(backend_url):
        pytest.skip(f'{backend_url} credentials not present in env')
    pytest.skip(
        'Live FileStore + engine harness not yet wired; placeholder pending follow-up.',
    )
