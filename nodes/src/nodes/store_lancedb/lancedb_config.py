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

# ------------------------------------------------------------------------------
# Configuration helpers for the LanceDB store
# ------------------------------------------------------------------------------
# Kept free of any lancedb import so the save time probe in IGlobal can check
# a configuration without installing the driver's requirements.
import json
import os
import re
from typing import Any, Dict, Optional

# Where a relative local uri is placed, under the engine's data directory
DEFAULT_URI = './lancedb'

# Table used when the node configuration does not name one
DEFAULT_TABLE = 'ROCKETRIDE'

# URI schemes that put the tables on object storage instead of a local directory
OBJECT_STORE_SCHEMES = ('s3://', 'gs://', 'az://')

# Distance metrics LanceDB supports for vector search
DISTANCES = ('cosine', 'l2', 'dot')

# How semantic questions are answered: vectors only, or vectors fused with
# full text search on the question text
SEARCH_MODES = ('vector', 'hybrid')

# LanceDB table names: letters, digits, underscore, hyphen and period
TABLE_RE = re.compile(r'^[A-Za-z0-9_.-]{1,255}$')


def is_object_uri(uri: str) -> bool:
    """Return True when the uri points at object storage."""
    return (uri or '').strip().lower().startswith(OBJECT_STORE_SCHEMES)


def resolve_uri(uri: Optional[str], data_dir: str, object_only: bool = False) -> str:
    """
    Turn the configured uri into the location LanceDB connects to.

    Object storage uris are used as given. An absolute local path is used as
    given too, since the node owner chose it. A relative path is placed under
    the engine's data directory and may not climb out of it, so a pipeline
    cannot point the store at an arbitrary path with something like ../../etc.

    With object_only (the object storage profile) only an object storage uri
    is accepted, so an empty field cannot fall back to a local directory.
    """
    if object_only and not is_object_uri(uri or ''):
        raise ValueError('The object storage profile needs an s3://, gs:// or az:// uri')

    uri = (uri or '').strip() or DEFAULT_URI

    if is_object_uri(uri):
        return uri

    if '://' in uri:
        raise ValueError(f'Unsupported uri {uri!r}: use a local directory or an s3://, gs:// or az:// uri')

    if os.path.isabs(uri):
        return os.path.normpath(uri)

    base = os.path.abspath(data_dir)
    path = os.path.normpath(os.path.join(base, uri))
    if os.path.commonpath([base, path]) != base:
        raise ValueError(f'The uri {uri!r} leaves the engine data directory; use a path inside it or an absolute path')
    return path


def parse_storage_options(raw: Any) -> Optional[Dict[str, str]]:
    """
    Read the storageOptions field into the dict LanceDB expects.

    The field is a JSON object of string settings such as an endpoint, a region
    or keys. Empty means rely on the standard environment variables.
    """
    if raw is None:
        return None

    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return None
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as e:
            raise ValueError(f'storageOptions is not valid JSON: {e.msg}') from None

    if not isinstance(raw, dict):
        raise ValueError('storageOptions must be a JSON object, for example {"region": "us-east-1"}')

    options: Dict[str, str] = {}
    for key, value in raw.items():
        if value is None:
            continue
        if isinstance(value, bool):
            value = 'true' if value else 'false'
        options[str(key)] = str(value)
    return options or None


def validate_table(table: Optional[str]) -> str:
    """Return the table name to use, or raise when LanceDB would reject it."""
    table = (table or '').strip() or DEFAULT_TABLE
    if not TABLE_RE.fullmatch(table):
        raise ValueError(f"Table name {table!r} is invalid. Use 1-255 letters, digits, '_', '-' or '.'")
    return table


def read_choice(config: Dict[str, Any], key: str, choices: tuple, default: str) -> str:
    """Read an enum style setting, case insensitive, and refuse unknown values."""
    value = str(config.get(key) or default).strip().lower()
    if value not in choices:
        raise ValueError(f'{key} must be one of {", ".join(choices)}, got {value!r}')
    return value


def read_count(config: Dict[str, Any], key: str, default: int) -> int:
    """Read a non negative integer setting where 0 turns the feature off."""
    value = config.get(key, default)
    if value is None or value == '':
        return default
    # int() would quietly turn 0.5 into 0, which switches the feature off
    if isinstance(value, bool) or (isinstance(value, float) and not value.is_integer()):
        raise ValueError(f'{key} must be a whole number, got {value!r}')
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f'{key} must be a whole number, got {value!r}') from None
    if number < 0:
        raise ValueError(f'{key} cannot be negative, got {number}')
    return number
