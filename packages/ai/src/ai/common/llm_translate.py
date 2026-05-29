# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Provider-shape translators for Question.attachments.

Each translator turns a (prompt_text, attachments, file_store) triple into
the provider's native content-block list. Unsupported attachment x provider
pairs are dropped and reported. FileStore read failures raise
(data-plane breakage propagates).
"""

from __future__ import annotations

import base64
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

from ai.common.schema import Attachment

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AttachmentDropReport:
    """One drop-and-warn record emitted when an attachment cannot be carried.

    ``provider`` is the concrete node provider name (e.g. ``'openai'``,
    ``'groq'``, ``'mistral'``) so telemetry can tag the dropping node even
    though many providers share the same block shape.
    """

    provider: str
    mime: str
    reason: str  # 'unsupported' | (future) 'too_large' | etc.


# --- OpenAI shape -------------------------------------------------------
#
# Covers our OpenAI-compatible LLM nodes — those that inherit the default
# provider_shape='openai': llm_openai, llm_openai_api, llm_deepseek,
# llm_gmi_cloud, llm_ibm_watson, llm_mistral, llm_ollama, llm_perplexity,
# llm_qwen, llm_xai. (The anthropic, gemini, and bedrock nodes declare their
# own shapes and use the dedicated translators further down.)

_OPENAI_IMAGE_MIMES = {'image/png', 'image/jpeg', 'image/webp', 'image/gif'}
_OPENAI_AUDIO_FORMATS = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
}
_OPENAI_FILE_MIMES = {'application/pdf'}


def translate_openai_shape(
    prompt_text: str,
    attachments: List[Attachment],
    file_store: Any,
    provider_name: str,
) -> Tuple[List[Dict[str, Any]], List[AttachmentDropReport]]:
    """Translate (prompt, attachments) into an OpenAI-compat content list.

    Attachments first, prompt text last (mirrors OpenAI examples). FileStore
    reads happen here; bytes are base64-inline. Drop-and-warn for unsupported
    MIMEs. File-store IO errors propagate.

    Args:
        prompt_text: The synthesized question text.
        attachments: List of Attachment carrying filestore paths.
        file_store: Object with ``read_bytes(path) -> bytes`` (sync).
        provider_name: Concrete node provider name; tags drop reports.

    Returns:
        ``(blocks, dropped)`` — blocks is the content list ready for the
        OpenAI ``messages[0].content`` field; dropped is the per-attachment
        report for telemetry.
    """
    blocks: List[Dict[str, Any]] = []
    dropped: List[AttachmentDropReport] = []

    for att in attachments:
        if att.mime in _OPENAI_IMAGE_MIMES:
            data = file_store.read_bytes(att.path)
            b64 = base64.b64encode(data).decode('ascii')
            blocks.append(
                {
                    'type': 'image_url',
                    'image_url': {'url': f'data:{att.mime};base64,{b64}'},
                }
            )
        elif att.mime in _OPENAI_FILE_MIMES:
            data = file_store.read_bytes(att.path)
            b64 = base64.b64encode(data).decode('ascii')
            blocks.append(
                {
                    'type': 'file',
                    'file': {'file_data': f'data:{att.mime};base64,{b64}', 'filename': att.filename},
                }
            )
        elif att.mime in _OPENAI_AUDIO_FORMATS:
            data = file_store.read_bytes(att.path)
            b64 = base64.b64encode(data).decode('ascii')
            blocks.append(
                {
                    'type': 'input_audio',
                    'input_audio': {
                        'data': b64,
                        'format': _OPENAI_AUDIO_FORMATS[att.mime],
                    },
                }
            )
        else:
            logger.warning(
                'Dropped attachment: provider %s does not support %s',
                provider_name,
                att.mime,
            )
            dropped.append(AttachmentDropReport(provider=provider_name, mime=att.mime, reason='unsupported'))

    blocks.append({'type': 'text', 'text': prompt_text})
    return blocks, dropped


# --- Anthropic shape ----------------------------------------------------
#
# Native ``messages[*].content`` block list. Images and PDFs ride as
# base64 sources; audio/video have no native carriage.

_ANTHROPIC_IMAGE_MIMES = {'image/png', 'image/jpeg', 'image/gif', 'image/webp'}
_ANTHROPIC_DOCUMENT_MIMES = {'application/pdf'}


def translate_anthropic_shape(
    prompt_text: str,
    attachments: List[Attachment],
    file_store: Any,
    provider_name: str,
) -> Tuple[List[Dict[str, Any]], List[AttachmentDropReport]]:
    """Translate (prompt, attachments) into an Anthropic content-block list.

    Images become ``{'type': 'image', 'source': {'type': 'base64', ...}}``;
    PDFs become ``{'type': 'document', 'source': {'type': 'base64', ...}}``.
    Unsupported MIMEs drop+warn. FileStore IO errors propagate.
    """
    blocks: List[Dict[str, Any]] = []
    dropped: List[AttachmentDropReport] = []

    for att in attachments:
        if att.mime in _ANTHROPIC_IMAGE_MIMES:
            data = file_store.read_bytes(att.path)
            b64 = base64.b64encode(data).decode('ascii')
            blocks.append(
                {
                    'type': 'image',
                    'source': {'type': 'base64', 'media_type': att.mime, 'data': b64},
                }
            )
        elif att.mime in _ANTHROPIC_DOCUMENT_MIMES:
            data = file_store.read_bytes(att.path)
            b64 = base64.b64encode(data).decode('ascii')
            blocks.append(
                {
                    'type': 'document',
                    'source': {'type': 'base64', 'media_type': att.mime, 'data': b64},
                }
            )
        else:
            logger.warning(
                'Dropped attachment: provider %s does not support %s',
                provider_name,
                att.mime,
            )
            dropped.append(AttachmentDropReport(provider=provider_name, mime=att.mime, reason='unsupported'))

    blocks.append({'type': 'text', 'text': prompt_text})
    return blocks, dropped


# --- Gemini shape -------------------------------------------------------
#
# Google GenAI ``contents[*].parts`` shape — every modality uses the same
# ``inlineData`` wrapper with the original MIME type.

_GEMINI_INLINE_MIMES = {
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/heic',
    'application/pdf',
    'audio/wav',
    'audio/mpeg',
    'audio/aiff',
    'audio/aac',
    'audio/ogg',
    'audio/flac',
    'video/mp4',
    'video/mpeg',
    'video/quicktime',
    'video/x-msvideo',
    'video/x-flv',
    'video/webm',
}


def translate_gemini_shape(
    prompt_text: str,
    attachments: List[Attachment],
    file_store: Any,
    provider_name: str,
) -> Tuple[List[Dict[str, Any]], List[AttachmentDropReport]]:
    """Translate (prompt, attachments) into a Gemini ``parts`` list.

    Every supported modality (image/pdf/audio/video) emits an
    ``{'inlineData': {'mimeType': ..., 'data': base64}}`` part. Unsupported
    MIMEs drop+warn. FileStore IO errors propagate.
    """
    parts: List[Dict[str, Any]] = []
    dropped: List[AttachmentDropReport] = []

    for att in attachments:
        if att.mime in _GEMINI_INLINE_MIMES:
            data = file_store.read_bytes(att.path)
            b64 = base64.b64encode(data).decode('ascii')
            parts.append({'inlineData': {'mimeType': att.mime, 'data': b64}})
        else:
            logger.warning(
                'Dropped attachment: provider %s does not support %s',
                provider_name,
                att.mime,
            )
            dropped.append(AttachmentDropReport(provider=provider_name, mime=att.mime, reason='unsupported'))

    parts.append({'text': prompt_text})
    return parts, dropped


# --- Bedrock (Nova / Converse) shape -----------------------------------
#
# AWS Bedrock Converse API blocks: ``image``, ``document``, ``video``,
# ``text``. Bytes ride raw (not base64) under ``source.bytes`` per the
# Converse spec. Audio has no native Converse carriage today.

_BEDROCK_IMAGE_FORMATS = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/gif': 'gif',
    'image/webp': 'webp',
}
_BEDROCK_DOC_FORMATS = {
    'application/pdf': 'pdf',
    'text/html': 'html',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'doc',
}
_BEDROCK_VIDEO_FORMATS = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'video/webm': 'webm',
    'video/x-flv': 'flv',
}


def translate_bedrock_shape(
    prompt_text: str,
    attachments: List[Attachment],
    file_store: Any,
    provider_name: str,
) -> Tuple[List[Dict[str, Any]], List[AttachmentDropReport]]:
    """Translate (prompt, attachments) into a Bedrock Converse content list.

    Images, documents, and videos each become their typed Converse block
    with ``source.bytes`` as raw bytes (not base64). Unsupported MIMEs
    drop+warn. FileStore IO errors propagate.
    """
    blocks: List[Dict[str, Any]] = []
    dropped: List[AttachmentDropReport] = []

    for att in attachments:
        if att.mime in _BEDROCK_IMAGE_FORMATS:
            data = file_store.read_bytes(att.path)
            blocks.append(
                {
                    'image': {
                        'format': _BEDROCK_IMAGE_FORMATS[att.mime],
                        'source': {'bytes': data},
                    }
                }
            )
        elif att.mime in _BEDROCK_DOC_FORMATS:
            data = file_store.read_bytes(att.path)
            blocks.append(
                {
                    'document': {
                        'format': _BEDROCK_DOC_FORMATS[att.mime],
                        'name': att.filename,
                        'source': {'bytes': data},
                    }
                }
            )
        elif att.mime in _BEDROCK_VIDEO_FORMATS:
            data = file_store.read_bytes(att.path)
            blocks.append(
                {
                    'video': {
                        'format': _BEDROCK_VIDEO_FORMATS[att.mime],
                        'source': {'bytes': data},
                    }
                }
            )
        else:
            logger.warning(
                'Dropped attachment: provider %s does not support %s',
                provider_name,
                att.mime,
            )
            dropped.append(AttachmentDropReport(provider=provider_name, mime=att.mime, reason='unsupported'))

    blocks.append({'text': prompt_text})
    return blocks, dropped
