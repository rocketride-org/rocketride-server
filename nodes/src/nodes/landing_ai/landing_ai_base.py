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

"""Shared helpers for the Landing.ai ADE sub-nodes (parse, extract)."""

import json
import os
from typing import Any, Dict, Optional

from ai.common.config import Config
from ai.common.utils import decode_data_url

_MAX_SCHEMA_BYTES = 2 * 1024 * 1024


def ensure_dependencies() -> None:
    """Install the shared landing_ai dependencies (requirements.txt sits next to this module)."""
    from depends import load_depends

    load_depends(__file__)


def resolve_api_key(config: Dict[str, Any]) -> Optional[str]:
    """Return the config api_key, else the ``ROCKETRIDE_LANDING_AI_KEY`` env var, else None."""
    return (config.get('api_key') or '').strip() or (os.environ.get('ROCKETRIDE_LANDING_AI_KEY') or '').strip() or None


def get_node_config(logical_type: str, conn_config: Dict[str, Any]) -> Dict[str, Any]:
    """Read this node's config, unwrapping the nested ``default`` profile (always a dict)."""
    config = Config.getNodeConfig(logical_type, conn_config)
    if not isinstance(config, dict):
        return {}
    inner = config.get('default')
    return inner if isinstance(inner, dict) else config


def build_client(api_key: Optional[str], environment: Optional[str] = None):
    """Build a fresh ``LandingAIADE`` client (one per call for concurrency safety)."""
    if not api_key:
        raise ValueError('Landing.ai: no API key configured')

    from landingai_ade import LandingAIADE

    kwargs: Dict[str, Any] = {'apikey': api_key}
    if environment:
        kwargs['environment'] = environment
    return LandingAIADE(**kwargs)


def validate_credentials(config: Dict[str, Any]) -> Optional[str]:
    """Validate the ADE key with a cheap read-only call.

    Returns a human-readable problem message (for ``warning``), or None if the
    credentials work. ``parse_jobs.list`` is read-only, so it consumes no credits.
    """
    api_key = resolve_api_key(config)
    if not api_key:
        return 'no API key configured (set it on the node or via ROCKETRIDE_LANDING_AI_KEY)'
    try:
        client = build_client(api_key, config.get('region') or 'production')
        client.parse_jobs.list(page=0, page_size=1)
    except Exception as e:  # noqa: BLE001 — reported as a warning, never raised
        return str(e)
    return None


def load_schema_from_data_url(value: str) -> Dict[str, Any]:
    """Decode an uploaded JSON Schema data-url into a dict.

    Normalizes every unusable upload (missing, undecodable, oversized, malformed,
    or not a JSON object) into a single ``ValueError`` so callers guard one type.
    The schema content is treated as opaque — it is only re-serialized and sent to
    ADE, never read for field values or written to disk.
    """
    if not value:
        raise ValueError('Landing.ai Extract: no extraction schema uploaded')

    try:
        raw, _mime = decode_data_url(value)
    except Exception as e:  # noqa: BLE001 — bad base64/data-url -> uniform ValueError
        raise ValueError(f'Landing.ai Extract: could not decode the uploaded schema: {e}')

    if len(raw) > _MAX_SCHEMA_BYTES:
        raise ValueError(f'Landing.ai Extract: uploaded schema is too large ({len(raw)} bytes > {_MAX_SCHEMA_BYTES})')

    try:
        # RecursionError guards against pathologically nested JSON that slips under the size cap.
        schema = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as e:
        raise ValueError(f'Landing.ai Extract: uploaded schema is not valid JSON: {e}')

    if not isinstance(schema, dict):
        raise ValueError('Landing.ai Extract: extraction schema must be a JSON object')
    return schema
