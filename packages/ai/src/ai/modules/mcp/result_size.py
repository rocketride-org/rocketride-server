# Copyright 2026 Aparavi Software AG. MIT License.
"""One size limit for every MCP tool result.

Hosts cut or refuse a long tool result, and the dispatcher sends every result
twice, as text and as structured content (``handlers.py``). So the server keeps
the JSON text of each result under one limit, ``MCP_RESULT_MAX_CHARS``:

- A handler whose result can shrink calls ``fit`` as its last step. ``fit``
  shrinks the keys its steps name, in order, until the whole payload fits, and
  says what it left out in a ``truncated`` key.
- The dispatcher checks every result last. A result still over the limit is
  replaced by the ``ResultTooLarge`` envelope from ``too_large``.

``initModule`` reads the setting once and calls ``configure``. No other code
reads the variable.
"""

import json
import logging
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple, Union

logger = logging.getLogger(__name__)

ENV_MAX_CHARS = 'MCP_RESULT_MAX_CHARS'
DEFAULT_MAX_CHARS = 40_000
# The smallest limit accepted. The ResultTooLarge envelope, a run's identity
# with its nulled keys, and a log_read stub page all fit under it.
MIN_MAX_CHARS = 1_000

# One next step per tool that has an input to ask for less, and a default for the rest.
_DEFAULT_HINT = (
    'Calling this tool again with the same input returns this same error. Tell the user the result is too large '
    'to show here.'
)
_HINTS = {
    'store_read': 'Calling store_read again returns this same error. To give the user the whole file, call '
    'store_get_url for a download link.',
    'store_list': 'Call store_list again on a folder inside this path.',
    'deploy_list': 'Call deploy_list again with a smaller page_size, or narrow it with search.',
    'deploy_versions': 'Call deploy_versions again with a smaller page_size.',
}

_max_chars = DEFAULT_MAX_CHARS

Key = Union[str, Tuple[str, ...]]
Step = Callable[[dict, Dict[str, Any], Callable[[], bool]], None]


def parse(raw: Optional[str]) -> int:
    """Return the limit a raw setting asks for: unset is the default and 0 is no limit.

    A value that is not a whole number, or is from 1 to 999, falls back to the
    default with one warning that names the variable, never the value.
    """
    value = (raw or '').strip()
    if not value:
        return DEFAULT_MAX_CHARS
    if value.isascii() and value.isdigit():
        number = int(value)
        if number == 0 or number >= MIN_MAX_CHARS:
            return number
    logger.warning(
        'Ignoring %s: it must be 0 (no limit) or a whole number of at least %d. Tool results are limited to %d '
        'characters.',
        ENV_MAX_CHARS,
        MIN_MAX_CHARS,
        DEFAULT_MAX_CHARS,
    )
    return DEFAULT_MAX_CHARS


def configure(max_chars: int) -> None:
    """Set the limit for this process. 0 turns it off."""
    global _max_chars
    _max_chars = max_chars
    if max_chars:
        logger.info('MCP tool results are limited to %d characters of JSON', max_chars)
    else:
        logger.info('MCP tool results have no size limit (%s=0)', ENV_MAX_CHARS)


def limit() -> int:
    """The limit in characters of JSON text, or 0 when there is none."""
    return _max_chars


def size_of(value: Any) -> int:
    """The length of the JSON text the dispatcher sends for ``value``."""
    return len(json.dumps(value, default=str))


def too_large(tool: Optional[str], size: int) -> dict:
    """The envelope sent in place of a result over the limit.

    ``tool`` must be a registered tool name or None: the envelope carries no
    caller text, so it always fits under the smallest accepted limit.
    """
    sent = f'This server sends at most {_max_chars:,} characters in one reply, so none of the result was sent.'
    message = f'The result of this call is {size:,} characters. {sent}'
    if tool:
        message = f'{tool} ran, but its result is {size:,} characters. {sent}'
    return {
        'ok': False,
        'error_type': 'ResultTooLarge',
        'message': message,
        'hint': _HINTS.get(tool or '', _DEFAULT_HINT),
    }


def _note(notes: Dict[str, Any], name: str, value: Any) -> None:
    notes[name] = value
    if 'hint' in notes:
        notes['hint'] = notes.pop('hint')


def _split(key: Key) -> Tuple[Tuple[str, ...], str]:
    if isinstance(key, str):
        return (key,), key
    return tuple(key), '.'.join(key)


def _parent(payload: dict, path: Tuple[str, ...]) -> Optional[dict]:
    """The object that holds the last key of ``path``, or None."""
    node: Any = payload
    for part in path[:-1]:
        if not isinstance(node, dict):
            return None
        node = node.get(part)
    if isinstance(node, dict):
        return node
    return None


def _largest(apply: Callable[[int], None], most: int, fits: Callable[[], bool]) -> None:
    """Apply the largest count from 0 to ``most`` that fits, or 0 when none does."""
    apply(0)
    if not fits():
        return
    best, low, high = 0, 1, most
    while low <= high:
        middle = (low + high) // 2
        apply(middle)
        if fits():
            best, low = middle, middle + 1
        else:
            high = middle - 1
    apply(best)


def rows(key: Key, note: Optional[Callable[[dict, Dict[str, Any], int, List[Any]], None]] = None) -> Step:
    """A list loses rows from the end, down to none.

    The default note is ``{'returned': n, 'total': m}`` under the key's name. A
    ``note(payload, notes, n, full)`` replaces it. ``fit`` calls it before each
    measurement, so what it writes is measured.
    """
    path, name = _split(key)

    def step(payload: dict, notes: Dict[str, Any], fits: Callable[[], bool]) -> None:
        parent = _parent(payload, path)
        if parent is None:
            return
        full = parent.get(path[-1])
        if not isinstance(full, list) or not full:
            return

        def keep(n: int) -> None:
            parent[path[-1]] = full[:n]
            if note is None:
                _note(notes, name, {'returned': n, 'total': len(full)})
            else:
                note(payload, notes, n, full)

        _largest(keep, len(full) - 1, fits)

    return step


def text(key: Key, cap: Optional[int] = None) -> Step:
    """The value becomes the leading characters of its text.

    The text is the string itself, or the JSON text of any other value. Without
    ``cap`` the longest lead that fits is kept, down to an empty string. With
    ``cap`` the text is cut once to at most that many characters.
    """
    path, name = _split(key)

    def step(payload: dict, notes: Dict[str, Any], fits: Callable[[], bool]) -> None:
        parent = _parent(payload, path)
        if parent is None or parent.get(path[-1]) is None:
            return
        whole = parent[path[-1]]
        if not isinstance(whole, str):
            whole = json.dumps(whole, default=str)
        if not whole or (cap is not None and len(whole) <= cap):
            return

        def keep(n: int) -> None:
            parent[path[-1]] = whole[:n]
            _note(notes, name, {'returned_chars': n, 'total_chars': len(whole)})

        if cap is not None:
            keep(cap)
            return
        _largest(keep, len(whole) - 1, fits)

    return step


def drop(key: Key, empty: Any) -> Step:
    """The value is replaced by ``empty``."""
    path, name = _split(key)

    def step(payload: dict, notes: Dict[str, Any], fits: Callable[[], bool]) -> None:
        parent = _parent(payload, path)
        if parent is None or path[-1] not in parent:
            return
        parent[path[-1]] = empty
        _note(notes, name, {'dropped': True})

    return step


def fit(payload: dict, steps: Iterable[Step], hint: Optional[str] = None, keep: Optional[Iterable[str]] = None) -> None:
    """Shrink ``payload`` in place until its JSON text is within the limit.

    Does nothing when the limit is off or the payload fits. Otherwise the steps
    run in order and stop after the first one that makes the whole payload fit,
    ``truncated`` and ``hint`` included. A step that reaches its floor leaves
    the rest to the next one. If the payload is still too large and ``keep``
    is given, every other key becomes None and ``truncated`` names them, so a
    schema that requires those keys still passes. Without ``keep`` the
    dispatcher's check sends ``ResultTooLarge``.
    """
    max_chars = _max_chars
    if not max_chars or size_of(payload) <= max_chars:
        return

    notes: Dict[str, Any] = {}
    if hint:
        notes['hint'] = hint

    def fits() -> bool:
        # Measure what will be sent: an empty note is never sent.
        payload.pop('truncated', None)
        if notes:
            payload['truncated'] = notes
        return size_of(payload) <= max_chars

    for step in steps:
        step(payload, notes, fits)
        if fits():
            break
    if keep is not None and not fits():
        kept = set(keep)
        dropped = [key for key in payload if key not in kept and key != 'truncated']
        for key in dropped:
            payload[key] = None
        notes.clear()
        notes['dropped'] = dropped
        if hint:
            notes['hint'] = hint
        fits()
