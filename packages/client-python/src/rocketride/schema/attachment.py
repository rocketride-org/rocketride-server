# Copyright (c) 2026 Aparavi Software AG
# SPDX-License-Identifier: MIT
"""Attachment schema for binary attachments on chat messages.

Distinct from Doc (text-oriented). Carries a filestore path; the bytes
live in the per-user filestore under the chat's directory.
"""

from pydantic import BaseModel, Field


class Attachment(BaseModel):
    """First-class schema type for one binary attachment."""

    attachment_id: str = Field(..., description='uuid4 generated client-side at upload time')
    mime: str = Field(..., description='RFC 6838 MIME type, e.g. "image/png"')
    filename: str = Field(..., description='User-visible original filename')
    size_bytes: int = Field(..., ge=0, description='Byte length on disk')
    path: str = Field(..., description='Filestore path relative to the user root')
