# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Task addresses — ``developerId.pipelineId[.source]``.

A task is addressed by a FIXED GRAMMAR of exactly 2 or 3 dot-free segments,
each ``[A-Za-z0-9_-]+``: ``acme.docBrain`` (the pipe's default source) or
``acme.docBrain.parsePDF`` (an explicit source). Component ids follow the
same rule, so a source segment is always one component id and the address
splits unambiguously on its dots — no prefix matching anywhere.

The address omits the owner on purpose: the server resolves WHOSE control
from the account on the request (the caller's @dev presence, else their
@me deployment, then team, then public). It is public information — the
registry key, display id, monitor key and run-log path — never a secret.
The account API key (``rr_``) is the only credential; a key may carry an
``endpoints`` scope that pins it to a list of addresses, checked here.

Boundary validation for identities (userId / teamId) also lives here: an
id with ``/``, whitespace or ``~`` can never enter a registry key or a
storage path.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, NamedTuple, Optional

from .types import TaskError

# =============================================================================
# GRAMMAR
# =============================================================================

# One address segment: developer id, pipe id, source (component id). Matched
# with fullmatch: a `$` anchor would accept a trailing newline ("acme\n"),
# which would then reach registry keys, display ids and run-log paths.
SEGMENT_PATTERN = re.compile(r'[A-Za-z0-9_-]+')

# Characters an ingested identity (userId / teamId) may never carry besides
# whitespace: the path separator and the personal-audience marker.
# Whitespace is rejected separately (str.isspace in validate_identity).
IDENTITY_FORBIDDEN = frozenset('/~')

# The one wildcard an endpoints scope accepts: every source of one pipe.
ENDPOINT_ANY_SOURCE = '*'


class Address(NamedTuple):
    """A parsed address; ``source`` is ``None`` for the two-segment form."""

    developer_id: str
    pipe_id: str
    source: Optional[str]


# =============================================================================
# SEGMENTS
# =============================================================================


def validate_segment(value: Any, field: str) -> str:
    """
    Require ``value`` to be one dot-free address segment.

    Args:
        value: The candidate (any type; only a matching ``str`` passes).
        field: What the value is, for the error (``'componentId'``,
            ``'project_id'``, ``'source'``, ``'developerId'``).

    Returns:
        The validated segment.

    Raises:
        TaskError: ``TASK_INVALID_ARGUMENT`` with ``field`` set.
    """
    if not isinstance(value, str) or not SEGMENT_PATTERN.fullmatch(value):
        raise TaskError(
            TaskError.INVALID_ARGUMENT,
            f'{field} {value!r} is not a valid address segment: use only letters, digits, "_" and "-"',
            field=field,
        )
    return value


def validate_identity(value: Any, field: str) -> str:
    """
    Boundary validation for an ingested identity (userId / teamId).

    Rejects the empty string, ``/``, ``~`` and any whitespace — the
    characters that would let an id walk a path or forge an audience key.

    Args:
        value: The candidate identity.
        field: ``'userId'`` or ``'teamId'``, for the error.

    Returns:
        The validated identity.

    Raises:
        TaskError: ``TASK_INVALID_ARGUMENT`` with ``field`` set.
    """
    if not isinstance(value, str) or not value or any(c in IDENTITY_FORBIDDEN or c.isspace() for c in value):
        raise TaskError(
            TaskError.INVALID_ARGUMENT,
            f'{field} {value!r} is not a valid identity: it must be non-empty and carry no "/", "~" or whitespace',
            field=field,
        )
    return value


def validate_component_ids(pipeline: Dict[str, Any]) -> None:
    """
    Require every component id in ``pipeline`` to be an address segment.

    A component id is the third coordinate of a task address (the source),
    so a dot or a space in one would make the address ambiguous. Checked at
    execute AND at publish.

    Args:
        pipeline: The flat pipeline dict (``components`` list).

    Raises:
        TaskError: ``TASK_INVALID_ARGUMENT`` naming the offending id.
    """
    components = pipeline.get('components') if isinstance(pipeline, dict) else None
    if not isinstance(components, list):
        raise TaskError(TaskError.INVALID_ARGUMENT, 'pipeline.components must be a list', field='components')
    for component in components:
        validate_segment(component.get('id') if isinstance(component, dict) else None, 'componentId')


# =============================================================================
# ADDRESSES
# =============================================================================


def build_address(developer_id: str, pipe_id: str, source: Optional[str] = None) -> str:
    """
    Build an address from validated segments.

    Args:
        developer_id: The owner org's developer id (``local``-style on OSS).
        pipe_id: The pipe's SHORT, dot-free project id.
        source: The source component id, or ``None`` for the two-segment form.

    Returns:
        ``developerId.pipeId`` or ``developerId.pipeId.source``.

    Raises:
        TaskError: ``TASK_INVALID_ARGUMENT`` when a segment breaks the grammar.
    """
    parts = [validate_segment(developer_id, 'developerId'), validate_segment(pipe_id, 'project_id')]
    if source is not None:
        parts.append(validate_segment(source, 'source'))
    return '.'.join(parts)


def parse_address(address: Any) -> Address:
    """
    Split an address into its 2 or 3 segments.

    Args:
        address: The candidate address string.

    Returns:
        The parsed ``Address``.

    Raises:
        TaskError: ``TASK_INVALID_ARGUMENT`` unless the value is exactly two
            or three dot-free segments.
    """
    if not isinstance(address, str) or not address:
        raise TaskError(TaskError.INVALID_ARGUMENT, 'A task address is required', field='token')
    parts = address.split('.')
    if len(parts) not in (2, 3):
        raise TaskError(
            TaskError.INVALID_ARGUMENT,
            f'Address {address!r} is not developerId.pipelineId or developerId.pipelineId.source',
            field='token',
        )
    developer_id, pipe_id = parts[0], parts[1]
    source = parts[2] if len(parts) == 3 else None
    for segment, field in ((developer_id, 'developerId'), (pipe_id, 'project_id'), (source, 'source')):
        if segment is not None:
            validate_segment(segment, field)
    return Address(developer_id, pipe_id, source)


# =============================================================================
# ENDPOINT SCOPE
# =============================================================================


def check_endpoint_scope(endpoints: Optional[Iterable[str]], address: str) -> None:
    """
    Enforce an API key's ``endpoints`` scope against a resolved address.

    ``None`` is an unscoped key (every address). A list allows exactly its
    entries: ``developerId.pipelineId.source`` matches that one address and
    ``developerId.pipelineId.*`` any source of that pipe — nothing broader.
    An empty list allows nothing.

    Args:
        endpoints: The key's scope as loaded onto ``AccountInfo.endpoints``.
        address: The FULL three-segment address the request resolved to.

    Raises:
        PermissionError: The scope excludes the address.
    """
    if endpoints is None:
        return
    developer_id, pipe_id, source = parse_address(address)
    for entry in endpoints:
        parts = str(entry).split('.')
        if len(parts) != 3 or parts[0] != developer_id or parts[1] != pipe_id:
            continue
        if parts[2] == ENDPOINT_ANY_SOURCE or parts[2] == source:
            return
    raise PermissionError(f'This API key is scoped to other endpoints; {address!r} is not among them')


def validate_endpoint_patterns(endpoints: Optional[Iterable[str]]) -> Optional[list[str]]:
    """
    Validate the ``endpoints`` list handed to key creation.

    Each entry is a full address (``developerId.pipelineId.source``) or the
    any-source form ``developerId.pipelineId.*``; two-segment entries and
    broader wildcards are refused so a scope can never widen by accident.

    Args:
        endpoints: The candidate list, or ``None`` for an unscoped key.

    Returns:
        The validated list (a fresh ``list[str]``), or ``None``.

    Raises:
        TaskError: ``TASK_INVALID_ARGUMENT`` naming the offending entry.
    """
    if endpoints is None:
        return None
    validated: list[str] = []
    for entry in endpoints:
        parts = str(entry).split('.')
        if len(parts) != 3:
            raise TaskError(
                TaskError.INVALID_ARGUMENT,
                f'endpoint {entry!r} must be developerId.pipelineId.source or developerId.pipelineId.*',
                field='endpoints',
            )
        validate_segment(parts[0], 'developerId')
        validate_segment(parts[1], 'project_id')
        if parts[2] != ENDPOINT_ANY_SOURCE:
            validate_segment(parts[2], 'source')
        validated.append(str(entry))
    return validated
