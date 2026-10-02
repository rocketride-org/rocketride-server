# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Parallel wave executor for the RocketRide Wave.

Each wave is a list of tool calls that are dispatched concurrently
through ``agent_base.call_tool(context, name, args)``.

Template references (e.g. ``"{{memory.ref:key}}"`` ) are resolved before
tool invocation and in the final answer.  An optional format and JMESPath
path can be appended using colon delimiters:

  - ``{{memory.ref:key}}``                       — raw value substitution
  - ``{{memory.ref:key:format}}``                — format the full value
  - ``{{memory.ref:key:format:path}}``           — extract path, then format

Supported formats: markdown_table, html_table, csv, json, text, or any
custom description (falls back to LLM formatting).

The path component is a JMESPath expression and may itself contain colons
(e.g. ``rows[0:5].city``), since it is always the last segment.
"""

from __future__ import annotations

import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextvars import copy_context
from typing import Any, Dict, List, Optional, Tuple

import jmespath

from rocketlib import debug, error

from ai.common.agent import AgentBase, AgentContext
from ai.common.schema import Question

from .formatters import format_data

# Maximum number of concurrent tool executions per wave.  Keeping this at 8
# prevents runaway thread counts when the LLM issues many parallel calls.
_MAX_WORKERS = 8

# Hard timeout per individual tool call (seconds).  Prevents a slow external
# API from blocking the entire wave indefinitely.
_TOOL_TIMEOUT_S = 120

# Indentation used when rendering nested structures.
_INDENT = '  '

# Maximum array items returned by a memory.peek tool call with a JMESPath path.
# Raised to 50 to give the LLM enough data to work with for typical result sets
# (e.g. forecast periods, DB rows) without issuing individual indexed peeks.
_PEEK_MAX_ARRAY_ITEMS = 50

# Default chunk size for offset/length-based raw text reads via memory.peek.
# 8000 characters is comfortably below typical LLM context constraints while
# covering most single-record API responses in one read.
_PEEK_DEFAULT_LENGTH = 8000

# Nesting depth past which a summary stops descending: past a few levels it stops
# informing the model, and the cap is also what keeps a cyclic result from recursing
# until RecursionError and costing the tool its result.
_SUMMARY_MAX_DEPTH = 6

# Longest list of dicts shown whole: its rows split its room like a dict's fields, so
# an MCP tool's one or two content blocks show their text. A longer list is a sample:
# it shows as many whole rows as fit its room. A list inside a sampled row shows this
# many rows at most, so rows stay narrow and many of them fit.
_SUMMARY_SHORT_LIST = 2

# Character budget for a whole summary. A dict splits its room between the fields
# that can spend it (long texts, lists, dicts), so a result with many lists cannot
# cost more than a result with one. Narrow rows such as {id, name, mimeType} still
# fit in full, which is what a find-by-name task needs to converge.
_SUMMARY_BUDGET = 4000

# Longest string shown in full inside a sampled list row. Rows are there to show the
# shape of the data and to identify items, so they stay narrow and many of them fit.
# Text anywhere else (a file's content, a command's output) gets its share of the
# budget instead: that text is usually the result itself. A string this long or
# shorter is a short field: paid for before the budget is split, and listed on the
# summary's last line if a cut leaves it out.
_ROW_TEXT_CHARS = 80

# Fewest characters of a cut text worth showing. Below this its start and end say
# nothing, so the text shows its length instead (see _render_text).
_TEXT_MIN_CHARS = 20

# Ceiling on the finished summary. The budget is what long texts and lists share;
# keys, short fields, length notes and list headers are paid for first and may take
# a summary past the budget, up to here. Past this a container keeps the fields that
# fit, whole, and says how many it left out (see _describe).
_SUMMARY_HARD_CAP = 6000

# Appended when the cap cuts a summary that the rooms could not bound (see _describe),
# so the planner peeks instead of assuming it saw everything.
_SUMMARY_TRUNCATED = '\n... (truncated, peek the key for the rest)'

# Room kept under the hard cap for one line that lists the short fields of nested
# dicts and short lists (an exit code, an ok flag, a short error) that no container
# had room for, so no cut can hide a status, however the result is nested.
_SUMMARY_MISSING_CHARS = 400

# Field names that say whether a call worked: kept before other short fields when a
# dict cannot show them all, and listed first on that line.
_STATUS_NAME = re.compile(
    r'(?i)^(exit_?code|return_?code|returncode|status(_?code)?|code|ok|success|succeeded|failed|failure|'
    r'error|errors|is_?error|timed_?out|stderr)$'
)

# Most left-out short fields remembered for that line, so a huge result costs a
# bounded walk.
_SUMMARY_MISSING_FIELDS = 5000

# A key that stands bare in a path on that line; any other is quoted, as JMESPath
# wants it, so a key with a dot or a colon reads as one key.
_PLAIN_KEY = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')

# Compiled regex for {{memory.ref:key:format:path}} template tags.
#
# Capture groups:
#   group(1) — key:    [^}:]+  no colons, no closing brace
#   group(2) — format: [^}:]+  no colons, no closing brace (optional)
#   group(3) — path:   [^}]+   may contain colons (JMESPath slices like rows[0:5])
#
# The path group uses [^}]+ rather than [^}:]+ precisely so that JMESPath
# slice notation (which uses colons) is captured correctly.  Since path is
# always the last segment before }}, no ambiguity arises.
_REF_PATTERN = re.compile(r'\{\{memory\.ref:([^}:]+)(?::([^}:]+))?(?::([^}]+))?\}\}')


# ---------------------------------------------------------------------------
# Structural summary (_describe)
# ---------------------------------------------------------------------------
#
# A summary is built in two passes over each container. _cost sizes its fields
# exactly (keys, separators, notes, headers, row labels) without rendering them;
# _render then gives each field a room and renders it within that room. Every
# container keeps to its room by leaving out whole fields or whole rows, never by
# cutting a rendered string, so no parent cuts a child again and a list's header
# counts the rows under it. Whatever a container leaves out is recorded by path, and
# the short fields among them are listed on the summary's last line. The one cut of a
# rendered string is _describe's backstop at the hard cap.


class _Omitted:
    """The short fields a summary left out, by path, for the line that lists them.

    Holds the first _SUMMARY_MISSING_FIELDS and remembers that there were more.
    """

    __slots__ = ('fields', 'more')

    def __init__(self) -> None:
        self.fields: List[Tuple[Tuple[Any, ...], str]] = []
        self.more = False

    def add(self, path: Tuple[Any, ...], shown: str) -> None:
        if len(self.fields) < _SUMMARY_MISSING_FIELDS:
            self.fields.append((path, shown))
        else:
            self.more = True


def _describe(value: Any) -> str:
    """Return a compact structural summary of *value* for LLM context.

    The summary is shown in the "Previous tool results" section of the prompt
    so the LLM can understand the shape of stored data without loading it.
    It shows field names, array lengths, and sample values — enough for the
    LLM to formulate a correct JMESPath path for memory.peek.

    Every planning wave resends every prior summary, so size here is paid
    repeatedly. The result is bounded by _SUMMARY_HARD_CAP: the root gets the
    budget, or its fixed costs (short fields, keys, length notes, headers) when
    those are more, up to the cap. A root that cannot show all its short fields
    keeps room under the cap for the line that lists the rest. Two things no room
    bounds, a list's field names (written in full) and a value that is not JSON
    (written with str(), such as bytes or a tuple), are cut at the cap as a backstop.
    """
    omitted = _Omitted()
    _, floor, _ = _cost(value, 0, False, _SUMMARY_HARD_CAP)
    # A root given its floor leaves nothing out, so the line is needed only past the cap.
    room = _SUMMARY_HARD_CAP - _SUMMARY_MISSING_CHARS if floor > _SUMMARY_HARD_CAP else max(_SUMMARY_BUDGET, floor)
    summary = _render(value, 0, room, omitted=omitted)
    if not omitted.fields:
        return _cap(summary, '')
    line = _missing_line(omitted)
    if len(summary) + len(line) > _SUMMARY_HARD_CAP:
        # Not expected: a root within its floor leaves nothing out. Render again with
        # the line's room kept free rather than cut the summary after the fact.
        omitted = _Omitted()
        summary = _render(value, 0, _SUMMARY_HARD_CAP - _SUMMARY_MISSING_CHARS, omitted=omitted)
        line = _missing_line(omitted)
    return _cap(summary, line)


def _cap(summary: str, line: str) -> str:
    """*summary* and then *line*, the summary cut so that both fit _SUMMARY_HARD_CAP, the notice included.

    *line* lists the short fields the summary left out and is never longer than
    _SUMMARY_MISSING_CHARS, so it is kept whole: a cut cannot take an exit code it
    recovered.
    """
    if len(summary) + len(line) <= _SUMMARY_HARD_CAP:
        return summary + line
    keep = _SUMMARY_HARD_CAP - len(_SUMMARY_TRUNCATED) - len(line)
    return f'{summary[:keep]}{_SUMMARY_TRUNCATED}{line}'


def _missing_line(omitted: _Omitted) -> str:
    """One line listing the short fields a summary left out, within _SUMMARY_MISSING_CHARS.

    Fields named like a status come first, then the shortest entries, so an exit
    code or an ok flag comes before counters and the most fields fit. An entry too
    long for the room is skipped, not the ones after it, and the line ends with how
    many it could not list.
    """
    ranked = []
    for path, shown in omitted.fields:
        status = isinstance(path[-1], str) and _STATUS_NAME.search(path[-1]) is not None
        # A bound under the entry's length: a path only grows when a key is quoted.
        ranked.append((not status, sum(len(str(seg)) for seg in path) + len(shown), path, shown))
    head = '\n(short fields a cut may have hidden: '
    tail = f'; and {len(omitted.fields)}+ more'
    room = _SUMMARY_MISSING_CHARS - len(head) - len(tail) - 1
    parts: List[str] = []
    skipped = 0
    for _, bound, path, shown in sorted(ranked, key=lambda entry: entry[:2]):
        if bound + 2 > room:
            skipped += 1
            continue
        item = f'{_path_text(path)}: {shown}'
        cost = len(item) + (2 if parts else 0)
        if cost > room:
            skipped += 1
            continue
        parts.append(item)
        room -= cost
    if skipped or omitted.more:
        more = f'{skipped}{"+" if omitted.more else ""} more'
        parts.append(f'and {more}' if parts else f'{more}, with paths too long to list')
    return f'{head}{"; ".join(parts)})'


def _path_text(path: Tuple[Any, ...]) -> str:
    """A path as JMESPath writes it: keys joined by dots, quoted unless plain, list rows by index."""
    out = ''
    for seg in path:
        if isinstance(seg, int):
            out += f'[{seg}]'
        else:
            key = seg if _PLAIN_KEY.fullmatch(seg) else json.dumps(seg, ensure_ascii=False)
            out = f'{out}.{key}' if out else key
    return out


def _is_short(value: Any) -> bool:
    """True for a value that is paid for before the budget is split: a scalar, a string a row would show whole, an empty container."""
    if isinstance(value, (list, dict)):
        return not value
    return not (isinstance(value, str) and len(value) > _ROW_TEXT_CHARS)


def _collect_short(value: Any, path: Tuple[Any, ...], depth: int, omitted: _Omitted) -> None:
    """Record the short fields of a *value* no container had room for: its own, its nested dicts' and its short lists' rows'.

    The rows of a longer list are a sample by design, so their fields are not
    recorded. Depth counts every container edge, like the summary itself.
    """
    if depth > _SUMMARY_MAX_DEPTH or omitted.more:
        return
    if _is_short(value):
        # Strings as JSON, so a multi-line error stays on the one line.
        omitted.add(path, json.dumps(value, ensure_ascii=False) if isinstance(value, str) else _render(value, 0, 0))
    elif isinstance(value, dict):
        for k, v in value.items():
            if omitted.more:
                break
            _collect_short(v, path + (str(k),), depth + 1, omitted)
    elif isinstance(value, list) and len(value) <= _SUMMARY_SHORT_LIST:
        for i, v in enumerate(value):
            _collect_short(v, path + (i,), depth + 1, omitted)


def _row_text(value: str) -> str:
    """A string inside a sampled row: whole up to _ROW_TEXT_CHARS, else its start and its length."""
    if len(value) <= _ROW_TEXT_CHARS:
        return f'"{value}"'
    # Show prefix and total length so the LLM knows it can page through with offset/length
    return f'"{value[:_ROW_TEXT_CHARS]}..." ({len(value)} chars)'


def _text_note(length: int) -> str:
    """What a long text shows when its room is too small for any of it to be worth reading."""
    return f'({length} chars, peek the key to read it)'


def _cut_text(value: str, chars: int) -> str:
    """Quote *value*, keeping its start and end when it is longer than *chars*.

    A file's closing lines and a traceback's final error are often what the planner
    needs, so the middle is what gets dropped. The full length is reported so the
    planner can read the rest with memory.peek offset/length.
    """
    limit = max(_TEXT_MIN_CHARS, chars)
    if len(value) <= limit:
        return f'"{value}"'
    head = (limit * 2) // 3
    tail = limit - head
    return f'"{value[:head]} ... {value[-tail:]}" ({len(value)} chars, middle omitted)'


def _render_text(value: str, room: int) -> str:
    """A text outside a list row, in at most *room* characters.

    Whole when it fits; else its start and end, with the room less the quotes and
    the note (see _cut_text); else, when that leaves fewer than _TEXT_MIN_CHARS, its
    length alone. The parent pays for the length note before splitting its room, so
    the text is never shown in less.
    """
    length = len(value)
    if length + 2 <= room:
        return f'"{value}"'
    chars = room - len(f'" ... " ({length} chars, middle omitted)')
    if chars >= _TEXT_MIN_CHARS:
        return _cut_text(value, chars)
    return _text_note(length)


def _fields_notice(depth: int, shown: int, total: int) -> int:
    """How long a dict's notice of fields left out is at *depth*; a dict's least room is the notice for all of them."""
    return len(_INDENT) * depth + len(f'... (showing {shown} of {total} fields, peek the key for the rest)')


def _is_plain_list(value: Any) -> bool:
    """True for a list that _render_sample shows: one that is not empty and does not start with a dict."""
    return isinstance(value, list) and bool(value) and not isinstance(value[0], dict)


def _row_keys(value: list) -> list:
    """The field names a list of dicts shows: those of up to 5 rows, so sparse early rows do not hide fields that appear later."""
    return list(dict.fromkeys(k for row in value[:5] if isinstance(row, dict) for k in row))


def _cost(value: Any, depth: int, in_row: bool, limit: int) -> Tuple[int, int, int]:
    """How long *value* renders at *depth*, exactly, as ``(least, floor, want)``.

    least is the fewest characters it can be shown in: a scalar as it is, a list its
    header, a dict its notice of fields left out. floor is what it shows with no
    budget to spend: its short fields, a length note for each long text, and the
    floors of what it nests. want is all of it. A container that wants no more than
    _ROW_TEXT_CHARS is a short field: its three are equal, and it is shown whole or
    not at all. Counting stops past *limit*, so a huge value costs a bounded walk.
    Inside a sampled row everything is whole, so the three are equal there too.
    """
    if depth > _SUMMARY_MAX_DEPTH:
        return 3, 3, 3
    if value is None or isinstance(value, (bool, int, float)):
        length = len(_render(value, depth, 0))
        return length, length, length
    if isinstance(value, str):
        length = len(value)
        if in_row:
            length = len(_row_text(value))
        elif length > _ROW_TEXT_CHARS:
            note = len(_text_note(length))
            return note, note, length + 2
        else:
            length += 2
        return length, length, length
    if isinstance(value, dict):
        if not value:
            return 2, 2, 2
        pad = len(_INDENT) * depth
        floor = want = -1  # the fields' newlines, one fewer than fields
        for k, v in value.items():
            _, f, w = _cost(v, depth + 1, in_row, limit)
            label = pad + len(str(k)) + 3
            floor += label + f
            want += label + w
            if floor > limit:
                break
        if in_row or want <= _ROW_TEXT_CHARS:
            return want, want, want
        return min(_fields_notice(depth, len(value), len(value)), want), floor, want
    if isinstance(value, list):
        if not value:
            return 12, 12, 12  # "[] (0 items)"
        n = len(value)
        pad = len(_INDENT) * depth
        if isinstance(value[0], dict):
            header = len(f'{n} items, fields: {_row_keys(value)}')
            if in_row:
                rows = value[:_SUMMARY_SHORT_LIST]
                want = header + (len(f' (showing {len(rows)} of {n})') if n > len(rows) else 0)
                for i, row in enumerate(rows):
                    want += pad + len(str(i)) + 10 + _cost(row, depth + 1, True, limit)[2]
                return want, want, want
            least = header + len(f' (showing 0 of {n})')
            floor = want = header
            whole = n <= _SUMMARY_SHORT_LIST
            for i, row in enumerate(value):
                _, f, w = _cost(row, depth + 1, not whole, limit)
                label = pad + len(str(i)) + 10  # "\n{pad}  row[i]:\n"
                want += label + w
                if whole:
                    floor += label + f
                elif want > limit:
                    break
            if not whole:
                floor = least
        else:
            shown = value[:3]
            prefix = len(f'{n} items, sample: [')
            least = prefix + 4  # "...]"
            floor = want = prefix + 1 + 2 * (len(shown) - 1)  # "]" and ", " between items
            for item in shown:
                if in_row or not _is_plain_list(item):
                    _, f, w = _cost(item, depth + 1, in_row, limit)
                else:
                    _, f, w = _filled_cost(item, depth + 1, limit)
                floor += f
                want += w
        if in_row or want <= _ROW_TEXT_CHARS:
            return want, want, want
        return min(least, want), floor, want
    length = len(_render(value, depth, 0))
    return length, length, length


def _filled_cost(value: list, depth: int, limit: int) -> Tuple[int, int, int]:
    """The costs (see _cost) of a plain list inside a plain list's sample, which shows as many items as fit (see _render_filled).

    Its items are a sample, so its floor is its least: the header and "...]".
    """
    if depth > _SUMMARY_MAX_DEPTH:
        return 3, 3, 3
    prefix = len(f'{len(value)} items, sample: [')
    want = prefix - 1  # "]", less the ", " the first item does not have
    for item in value:
        want += 2 + _cost(item, depth + 1, True, limit)[2]
        if want > limit:
            break
    if want <= _ROW_TEXT_CHARS:
        return want, want, want
    least = min(prefix + 4, want)  # "...]"
    return least, least, want


def _split(room: int, needs: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
    """Share *room* between items that each need so much: the ones that fit an equal share take only what they need, and the rest is split again."""
    out: List[Tuple[int, int]] = []
    left = len(needs)
    for i, need in sorted(needs, key=lambda item: item[1]):
        give = min(need, room // left)
        out.append((i, give))
        room -= give
        left -= 1
    return out


def _allocate(
    room: int, items: List[Tuple[int, int, int, int]], order: List[int], notice: int
) -> Tuple[Dict[int, int], bool]:
    """Which of a container's *items* fit in *room*, and the room each one's value gets.

    Each item is ``(fixed, least, floor, want)``: what its label and separator cost,
    and its value's costs (see _cost). Items are kept in *order* while their label
    and least fit; *notice* is reserved as soon as one does not, so the container
    can say so inside its room. The rest of the room then goes to the kept items'
    floors (short fields first, so a cut dict keeps its status), then to what they
    want beyond that, each split so that an item needing less than an equal share
    takes only that (see _split).

    Returns:
        The room per kept item, by index, and whether any item was left out.
    """
    kept: List[int] = []
    used = 0
    for i in order:
        cost = items[i][0] + items[i][1]
        if used + cost <= room:
            kept.append(i)
            used += cost
    cut = len(kept) < len(items)
    if cut:
        # Make room for the notice by giving up the last kept, least wanted, items.
        room -= notice
        while used > room and kept:
            used -= sum(items[kept.pop()][:2])
    rooms = {i: items[i][1] for i in kept}
    left = room - used
    for low, high in ((1, 2), (2, 3)):
        needs = [(i, items[i][high] - items[i][low]) for i in kept if items[i][high] > items[i][low]]
        for i, give in _split(left, needs):
            rooms[i] += give
            left -= give
    return rooms, cut


def _render(
    value: Any,
    depth: int,
    room: int,
    in_row: bool = False,
    text_cap: Optional[int] = None,
    omitted: Optional[_Omitted] = None,
    path: Tuple[Any, ...] = (),
) -> str:
    """Render *value* within *room* characters.

    A container keeps to its room by leaving out whole fields or whole rows (see
    _describe_dict, _render_rows); what it leaves out is recorded in *omitted* by
    *path*. A scalar is what it is: its parent paid for it. Inside a sampled list
    row (*in_row*) everything is shown whole, except that a string is cut to
    _ROW_TEXT_CHARS and a nested list shows _SUMMARY_SHORT_LIST rows, so rows stay
    narrow. *text_cap*, when given, sets the most any text may show, wherever it
    sits, and no field is left out: argument previews use it, sized by _args_text_cap.

    Design decisions:
    - Text outside a sampled row is shown in full when it fits its room; past that
      its start and end are kept and the middle is dropped (see _render_text).
    - Lists of dicts show field names, then as many whole rows as fit, so narrow
      rows are listed in full and a lookup can be answered from the summary. The
      header reports how many rows were shown when some are omitted, so the LLM
      knows the sample is partial.
    - Lists of primitives show a short sample (first 3 items). A list inside that
      sample, such as one row of a spreadsheet's values, shows as many items as fit
      its room.
    - Depth is tracked so nested structures are indented readably.
    """
    if depth > _SUMMARY_MAX_DEPTH:
        return '...'

    if value is None:
        return 'null'
    if isinstance(value, bool):
        # bool must be checked before int because bool is a subclass of int
        return str(value).lower()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        if text_cap is not None:
            return _cut_text(value, text_cap)
        if in_row:
            return _row_text(value)
        return _render_text(value, room)
    if isinstance(value, list):
        if not value:
            return '[] (0 items)'
        if isinstance(value[0], dict):
            return _render_rows(value, depth, room, in_row, text_cap, omitted, path)
        return _render_sample(value, depth, room, in_row, text_cap, omitted, path)
    if isinstance(value, dict):
        if not value:
            return '{}'
        return _describe_dict(value, depth, room, in_row, text_cap, omitted, path)
    return str(value)


def _render_rows(
    value: list,
    depth: int,
    room: int,
    in_row: bool,
    text_cap: Optional[int],
    omitted: Optional[_Omitted],
    path: Tuple[Any, ...],
) -> str:
    """A list of dicts: its field names, then its rows.

    A list of up to _SUMMARY_SHORT_LIST rows (an MCP tool's content blocks) is shown
    whole: its rows split its room like a dict's fields and show their text. A longer
    list is a sample: its rows are shown whole, in order, while they fit, and the
    header counts the ones shown. Inside a sampled row a list shows
    _SUMMARY_SHORT_LIST rows at most. _render picks this branch from the first item
    alone, so a later row can be a scalar; it is rendered like any value.
    """
    n = len(value)
    header = f'{n} items, fields: {_row_keys(value)}'
    pad = _INDENT * depth

    def labelled(i: int, body: str) -> str:
        return f'\n{pad}{_INDENT}row[{i}]:\n{body}'

    whole = n <= _SUMMARY_SHORT_LIST and not in_row
    rows: List[str] = []
    if text_cap is None and in_row:
        rows = [labelled(i, _render(row, depth + 1, room, True)) for i, row in enumerate(value[:_SUMMARY_SHORT_LIST])]
    elif text_cap is None and whole:
        items = [(len(labelled(i, '')), *_cost(row, depth + 1, False, room)) for i, row in enumerate(value)]
        rooms, _ = _allocate(room - len(header), items, list(range(n)), len(f' (showing 0 of {n})'))
        for i, row in enumerate(value):
            if i in rooms:
                rows.append(labelled(i, _render(row, depth + 1, rooms[i], False, None, omitted, path + (i,))))
            elif omitted is not None:
                _collect_short(row, path + (i,), depth + 1, omitted)
    elif whole:
        rows = [labelled(i, _render(row, depth + 1, room, False, text_cap)) for i, row in enumerate(value)]
    else:
        used = len(header)
        for i, row in enumerate(value):
            text = labelled(i, _render(row, depth + 1, room, True, text_cap))
            if used + len(text) > room and (text_cap is None or i >= _SUMMARY_SHORT_LIST):
                break
            rows.append(text)
            used += len(text)
        # Some rows are left out: give up shown ones until the header's notice fits as
        # well. Reserving it for each row instead hid rows that fit whenever the last
        # row was shorter than the notice.
        least = 0 if text_cap is None else _SUMMARY_SHORT_LIST
        while least < len(rows) < n and used + len(f' (showing {len(rows)} of {n})') > room:
            used -= len(rows.pop())
    if len(rows) < n:
        # Say the sample is partial, so a lookup peeks the key instead of
        # re-running the search that produced it.
        header += f' (showing {len(rows)} of {n})'
    return header + ''.join(rows)


def _render_sample(
    value: list,
    depth: int,
    room: int,
    in_row: bool,
    text_cap: Optional[int],
    omitted: Optional[_Omitted],
    path: Tuple[Any, ...],
) -> str:
    """A list that does not start with a dict: its first 3 items, each rendered like a field of its parent.

    Outside a sampled row the items split the list's room, so one huge item is cut
    like any text and cannot push the fields after it past the cap; an item that
    does not fit at all is left out and the sample ends in "...". An item that is
    itself a plain list, such as a row of a spreadsheet's values, shows as many of
    its items as fit its room (see _render_filled), so a header row is shown whole.
    """
    n = len(value)
    shown = value[:3]
    prefix = f'{n} items, sample: ['
    if in_row or text_cap is not None:
        parts = [_render(item, depth + 1, room, in_row, text_cap) for item in shown]
        return f'{prefix}{", ".join(parts)}]'
    items = [
        (2, *(_filled_cost(item, depth + 1, room) if _is_plain_list(item) else _cost(item, depth + 1, False, room)))
        for item in shown
    ]
    # The first item has no ", " before it, and the room counts the closing bracket.
    rooms, cut = _allocate(room - len(prefix) + 1, items, list(range(len(shown))), len(', ...'))
    parts = []
    for i, item in enumerate(shown):
        if i in rooms and _is_plain_list(item):
            parts.append(_render_filled(item, depth + 1, rooms[i], omitted, path + (i,)))
        elif i in rooms:
            parts.append(_render(item, depth + 1, rooms[i], False, None, omitted, path + (i,)))
        elif omitted is not None:
            _collect_short(item, path + (i,), depth + 1, omitted)
    if cut:
        parts.append('...')
    return f'{prefix}{", ".join(parts)}]'


def _render_filled(value: list, depth: int, room: int, omitted: Optional[_Omitted], path: Tuple[Any, ...]) -> str:
    """A plain list inside a plain list's sample: as many of its items as fit *room*, in order.

    Each item is shown as in a sampled row, so a table's cells stay narrow and a
    whole header row fits. When some are left out the list ends in "...". A list of
    up to _SUMMARY_SHORT_LIST items records the short fields of those it leaves out,
    as _collect_short does.
    """
    if depth > _SUMMARY_MAX_DEPTH:
        return '...'
    prefix = f'{len(value)} items, sample: ['
    parts: List[str] = []
    used = len(prefix) + 1  # and "]"
    for item in value:
        text = _render(item, depth + 1, room, True)
        used += len(text) + (2 if parts else 0)
        if used > room:
            break
        parts.append(text)
    else:
        return f'{prefix}{", ".join(parts)}]'
    # Some items are left out: give up shown ones until ", ..." fits as well.
    used = len(prefix) + len('...]') + sum(len(part) + 2 for part in parts)
    while parts and used > room:
        used -= len(parts.pop()) + 2
    if omitted is not None and len(value) <= _SUMMARY_SHORT_LIST:
        for i in range(len(parts), len(value)):
            _collect_short(value[i], path + (i,), depth + 1, omitted)
    return f'{prefix}{", ".join(parts + ["..."])}]'


def _describe_dict(
    d: dict,
    depth: int,
    room: int,
    in_row: bool,
    text_cap: Optional[int],
    omitted: Optional[_Omitted],
    path: Tuple[Any, ...],
) -> str:
    """Render a dict as indented key: value lines using _render for values.

    When all of it fits its room, every field is shown whole. Otherwise the room
    is allocated once (see _allocate): every key, short field and length note is
    paid for first, nested containers' short fields with them, and what is left is
    split between the fields that can spend it, so what a lookup can answer does
    not depend on key order, a command's stdout cannot crowd out its stderr or exit
    code, and a text that needs less than an equal share leaves the rest to the
    others. Fields that do not fit even so are left out whole, short fields named
    like a status last, and a final line says how many.
    """
    pad = _INDENT * depth

    def line(k: Any, desc: str) -> str:
        # A multi-line value goes on its own lines below the key.
        return f'{pad}{k}:\n{desc}' if '\n' in desc else f'{pad}{k}: {desc}'

    if in_row or text_cap is not None:
        return '\n'.join(line(k, _render(v, depth + 1, room, in_row, text_cap)) for k, v in d.items())
    keys = list(d)
    items = [(len(pad) + len(str(k)) + 3, *_cost(v, depth + 1, False, room)) for k, v in d.items()]
    if sum(item[0] + item[3] for item in items) - 1 <= room:
        rooms = {i: items[i][3] for i in range(len(items))}
        cut = False
    else:

        def priority(i: int) -> Tuple[int, int]:
            short = items[i][1] == items[i][3]  # shown whole or not at all
            return (0 if short and _STATUS_NAME.search(str(keys[i])) else 1 if short else 2), i

        notice = _fields_notice(depth, len(d), len(d)) + 1  # and its newline
        rooms, cut = _allocate(room + 1, items, sorted(range(len(items)), key=priority), notice)
    lines = []
    for i, (k, v) in enumerate(d.items()):
        if i in rooms:
            lines.append(line(k, _render(v, depth + 1, rooms[i], False, None, omitted, path + (str(k),))))
        elif omitted is not None and not omitted.more:
            _collect_short(v, path + (str(k),), depth + 1, omitted)
    if cut:
        lines.append(f'{pad}... (showing {len(rooms)} of {len(d)} fields, peek the key for the rest)')
    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Template resolution
# ---------------------------------------------------------------------------


def _memory_get(key: str, context: AgentContext) -> Any:
    """Fetch a raw value from the memory store.

    Returns ``None`` on missing key, failed lookup, or any error — callers
    treat None as "key not found" and substitute an empty string or None
    in the template output.
    """
    try:
        result = context.memory.get(key)
        # Memory store returns {ok: bool, value: Any} — only unwrap on success
        if isinstance(result, dict) and result.get('ok'):
            return result.get('value')
    except Exception:
        pass
    return None


def _format_value(
    value: Any,
    fmt: str,
    *,
    agent_base: AgentBase,
    context: AgentContext,
) -> str:
    """Apply a named formatter to *value*, falling back to LLM for unknown formats.

    Built-in formatters (markdown_table, html_table, csv, json, text) are
    handled by format_data() without an LLM call.  For any other format string
    (e.g. "bullet list", "prose summary"), we fire a secondary LLM call that
    takes the raw data as context and asks the model to render it.

    The LLM fallback enables open-ended formatting without maintaining an
    ever-growing list of built-in formatters.
    """
    formatted = format_data(value, fmt)
    if formatted is not None:
        return formatted

    # Unknown format — ask the LLM to render it
    debug(f'rocketride wave format fallback fmt={fmt!r}')
    raw = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    q = Question(role='You are a data formatting assistant.')
    q.addContext(raw)
    q.addQuestion(f'Format the data above as: {fmt}. Output ONLY the formatted result, nothing else.')
    try:
        return agent_base.call_llm(context, q)
    except Exception as exc:
        debug(f'rocketride wave format LLM fallback failed: {exc}')
        # Last resort: return the raw value rather than crashing
        return raw


def _resolve_refs(
    value: Any,
    *,
    agent_base: AgentBase,
    context: AgentContext,
) -> Any:
    """
    Recursively walk *value* and replace ``{{memory.ref:key}}``,
    ``{{memory.ref:key:format}}``, or ``{{memory.ref:key:format:path}}``
    tokens by fetching from memory, optionally extracting a JMESPath, and
    optionally applying a formatter.

    Two resolution modes:
    1. Exact match — the entire string is a single template tag.  The result
       is returned as its native type (dict, list, etc.) rather than coerced
       to a string.  This lets structured data flow through intact when a
       tool argument is entirely a memory reference.
    2. Substring substitution — the string contains one or more template tags
       mixed with literal text.  Each tag is replaced with its string
       representation and the surrounding text is preserved.
    """
    if isinstance(value, str):
        # Check for an exact full-string match first — avoids unnecessary
        # regex search on strings that don't contain any template tags.
        exact = _REF_PATTERN.fullmatch(value)
        if exact:
            key = exact.group(1)
            fmt = exact.group(2)
            path = exact.group(3)
            v = _memory_get(key, context)
            if v is None:
                return None
            # Apply JMESPath extraction before formatting so format receives
            # the narrowed slice, not the full stored object.
            if path:
                try:
                    v = jmespath.search(path, v)
                except Exception:
                    pass  # Bad path — fall through with the full value
            if fmt:
                return _format_value(v, fmt, agent_base=agent_base, context=context)
            # No format requested — return native type intact
            return v

        # Fast exit — no template tags anywhere in the string
        if not _REF_PATTERN.search(value):
            return value

        # Substring substitution — replace each tag in-place within the string
        def _sub(m: re.Match) -> str:
            key = m.group(1)
            fmt = m.group(2)
            path = m.group(3)
            v = _memory_get(key, context)
            if v is None:
                return ''  # Missing key → empty string, don't break the surrounding text
            if path:
                try:
                    v = jmespath.search(path, v)
                except Exception:
                    # Bad path — fall through with the original value so surrounding text still renders
                    pass
            if fmt:
                return _format_value(v, fmt, agent_base=agent_base, context=context)
            # No format — serialize to string for embedding in text
            if isinstance(v, str):
                return v
            try:
                return json.dumps(v, ensure_ascii=False)
            except Exception:
                return str(v)

        return _REF_PATTERN.sub(_sub, value)

    # Recurse into dicts and lists so template tags nested inside tool
    # argument objects are resolved before the tool is invoked.
    if isinstance(value, dict):
        return {k: _resolve_refs(v, agent_base=agent_base, context=context) for k, v in value.items()}

    if isinstance(value, list):
        return [_resolve_refs(v, agent_base=agent_base, context=context) for v in value]

    # Non-string scalar — nothing to resolve
    return value


def resolve_answer_refs(
    answer: str,
    *,
    agent_base: AgentBase,
    context: AgentContext,
) -> str:
    """Resolve ``{{memory.ref:key[:format][:path]}}`` references in a final answer.

    Called by the agent driver after the LLM emits done=true so that any
    bulk data the LLM referenced (but never loaded into context) is fetched,
    optionally JMESPath-extracted, formatted, and substituted before the
    answer is delivered to the user.
    """
    if not isinstance(answer, str) or not _REF_PATTERN.search(answer):
        # Fast exit — no template references to resolve
        return answer
    return _resolve_refs(answer, agent_base=agent_base, context=context)


# ---------------------------------------------------------------------------
# Wave result storage
# ---------------------------------------------------------------------------


def _auto_key(wave_name: str, idx: int) -> str:
    """Generate a memory key scoped to a wave and call index.

    Keys follow the pattern ``<wave_name>.r<idx>`` (e.g. ``wave-0.r2``).
    This makes keys human-readable in traces and unique across waves,
    so the LLM can reference specific results from previous iterations.
    """
    return f'{wave_name}.r{idx}'


def _result_fingerprint(result: Any) -> Optional[str]:
    """Fingerprint a tool result so an identical one can be recognised later.

    Args:
        result: The value a tool returned.

    Returns:
        A hex digest, or None if *result* cannot be encoded. default=str mirrors
        planner._json_default, since results can carry Decimal and datetime from
        database tools.
    """
    try:
        encoded = json.dumps(result, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError, RecursionError):
        # sort_keys raises TypeError on keys that cannot be ordered or encoded, and
        # default= is consulted for values only, never keys. The result is stored and
        # summarised by the time this runs. Dedup only advises the planner, so dropping
        # the signal costs less than the result.
        return None
    return hashlib.sha256(encoded.encode('utf-8')).hexdigest()


# The output fields of a code runner's result: tool_python (stdout, stderr) and
# tool_daytona (output). They mark a result whose exit_code and timed_out are a run's.
_RUNNER_OUTPUT = ('stdout', 'stderr', 'output')

# The fields of tool_http_request's result. It answers an error status (403, 500)
# with a normal result, so its status_code is the call's own.
_HTTP_RESPONSE = ('status_code', 'status_text', 'headers')

# The stack entries an agent called as a tool (AgentBase.run_agent) returns when its
# run raised or its tool-call guard tripped: a normal answer that reports a failure.
_AGENT_FAILURE_KINDS = ('RocketRide.agent.error.v1', 'RocketRide.agent.guard.v1')


def _error_message(value: Any) -> bool:
    """True when an ``error`` field holds an error: text, a structure, or true.

    A number there is a measurement (a fit's error of 0.25), not a failure.
    """
    if isinstance(value, bool):
        return value
    return isinstance(value, (str, dict, list)) and bool(value)


def _flags_failure(item: Any) -> bool:
    """True when a dict says outright that it failed: ok or success false, or isError."""
    return isinstance(item, dict) and (
        item.get('ok') is False or item.get('success') is False or item.get('isError') is True
    )


def _reports_failure(result: Any, _seen: Optional[set] = None) -> bool:
    """True when a tool returned a failure instead of raising one.

    Many tools answer a failed request with a normal result, such as
    ``{"ok": false, "error": "conflict"}``. MCP tools mark a failed call with
    ``"isError": true``; tool_http_request returns an error status (400 and up) as
    a normal response; an agent called as a tool returns its crash or its tripped
    guard as an answer whose stack says so; and code runners (tool_python,
    tool_daytona) report a run that failed or was cut off with a non-zero
    ``exit_code`` or ``"timed_out": true``. tool_python also returns the script's
    own ``result`` (a dict or a list), which is checked the same way (a check
    written in Python reports its verdict there), and tool_vertex_search reports a
    failure as a list holding only error entries. A list in which any item says
    outright that it failed (``ok`` or ``success`` false, ``isError``) counts too.
    The call did not raise, but the work did not happen, so the loop must not
    treat it as a success. An ``error`` field counts when it holds text, a
    structure or true; a number there is a measurement.

    Each tool's fields count only on that tool's result: elsewhere an
    ``exit_code`` (a CI job's status, say), a ``status_code`` or a ``result``
    field is data, and so is a list of rows that merely have an ``error`` column
    (a log search). An HTTP status of 400 or more counts even when the caller
    expected it (a 404 that answers "does it exist?"): that costs one more round,
    while missing a real failure would report work that never happened.
    """
    if isinstance(result, list):
        if any(_flags_failure(item) for item in result):
            return True  # a batch where an item says it failed did not fully happen
        return bool(result) and all(
            isinstance(item, dict) and set(item) == {'error'} and _error_message(item['error']) for item in result
        )
    if not isinstance(result, dict):
        return False
    if _flags_failure(result) or _error_message(result.get('error')):
        return True
    if all(k in result for k in _HTTP_RESPONSE):
        status = result.get('status_code')
        return isinstance(status, int) and not isinstance(status, bool) and status >= 400
    if isinstance(result.get('stack'), list) and isinstance(result.get('meta'), dict) and 'content' in result:
        return any(isinstance(entry, dict) and entry.get('kind') in _AGENT_FAILURE_KINDS for entry in result['stack'])
    if any(k in result for k in _RUNNER_OUTPUT) and ('exit_code' in result or 'timed_out' in result):
        exit_code = result.get('exit_code')
        if result.get('timed_out') is True or (
            # A bool is a code too: tool_python keeps SystemExit(True) as exit_code=True.
            isinstance(exit_code, int) and exit_code != 0
        ):
            return True
        # A script's result can hold itself (result['result'] = result); never follow
        # one twice, or the check would raise RecursionError on a successful run.
        seen = set() if _seen is None else _seen
        if id(result) in seen:
            return False
        seen.add(id(result))
        nested = result.get('result')
        return isinstance(nested, (dict, list)) and _reports_failure(nested, seen)
    return False


def _store_and_preview(
    tool: str,
    key: str,
    result: Any,
    context: AgentContext,
    agent_base: AgentBase,
) -> Dict[str, Any]:
    """Store *result* in memory under *key* and return a compact summary dict.

    The summary dict is what gets recorded in the wave history and injected
    into the next planning prompt as "Previous tool results".  It contains:
    - tool: which tool produced the result (for display/debugging)
    - key: the memory key the LLM should use when referencing this result
    - summary: a compact structural description produced by _describe()

    The full result is stored as a native Python object in memory so that
    memory.peek can later extract specific fields via JMESPath without
    re-parsing a JSON string.

    A result identical to one already stored this run also carries `deduplicated`
    and a `note` naming the earlier key. It signals, it never blocks: repeating a
    call is often legitimate, so the call still ran and the result is still stored.
    """
    try:
        context.memory.put(key, result)
    except Exception as exc:
        error(f'rocketride wave memory.put key={key!r} failed: {exc}')
        raise

    entry = {'tool': tool, 'key': key, 'summary': _describe(result)}
    if _reports_failure(result):
        entry['failed'] = True

    seen = getattr(agent_base, 'seen_results', None)
    if seen is None:
        return entry

    fingerprint = _result_fingerprint(result)
    if fingerprint is None:
        return entry

    # A wave runs its calls on a thread pool, so two identical results can both read
    # an empty slot and neither would be flagged. setdefault is atomic and gives the
    # first writer the slot, so exactly one entry stays unflagged.
    prior_key = seen.setdefault(fingerprint, key)
    if prior_key == key:
        return entry

    entry['deduplicated'] = True
    entry['note'] = (
        f'This result is identical to {prior_key}, which is already in memory, so this call '
        f'produced no new information. Read {prior_key} with memory.peek, or change approach: '
        f'repeating a call that returns the same data will not advance the task.'
    )
    return entry


# ---------------------------------------------------------------------------
# Wave executor
# ---------------------------------------------------------------------------


def _execute_wave_calls(
    wave: List[Dict[str, Any]],
    *,
    agent_base: AgentBase,
    context: AgentContext,
    wave_name: str = 'wave-0',
) -> List[Dict[str, Any]]:
    """Execute all tool calls in a wave in parallel and return result dicts.

    Each call in *wave* is a ``{"tool": str, "args": dict}`` entry emitted
    by the LLM.  Before execution, template references in args are resolved
    so the LLM can compose tool inputs from previously stored results.

    Results are returned in the same order as *wave* regardless of completion
    order — the pre-allocated results list and index mapping guarantee ordering
    even when futures complete out of sequence.
    """
    if not wave:
        return []

    # Tag each call with its auto-generated memory key before parallelism so
    # the key assignment is deterministic and order-preserving.
    tagged: List[Dict[str, Any]] = [{**call, '_key': _auto_key(wave_name, i)} for i, call in enumerate(wave)]

    def _run_one(call: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a single tool call and return a result dict."""
        tool = call.get('tool', '')
        key = call['_key']
        args = call.get('args') or {}
        if not isinstance(args, dict):
            args = {}

        # Resolve any {{memory.ref:...}} template references in the args
        # before passing them to the tool.  This lets the LLM compose tool
        # inputs from previously stored results without extra peek calls.
        args = _resolve_refs(args, agent_base=agent_base, context=context)

        debug(f'rocketride wave execute tool={tool!r} key={key!r}')
        try:
            # memory.peek is handled entirely within the executor rather than
            # being routed through the tool pipeline.  Reasons:
            # 1. It reads from the host's memory store directly — there is no
            #    external service to invoke.
            # 2. It needs custom logic (JMESPath, chunking, array capping) that
            #    is specific to the Wave agent and not part of the generic tool
            #    protocol.
            # 3. peek results are NOT stored back into memory — they are
            #    ephemeral "read" results shown in context and then evicted via
            #    the remove field once the LLM has captured their data in scratch.
            if tool == 'memory.peek':
                mem_key = args.get('key', '')
                path = args.get('path', '')
                mem_result = context.memory.get(mem_key)
                if not (isinstance(mem_result, dict) and mem_result.get('ok')):
                    return {'tool': tool, 'key': key, 'error': f'key {mem_key!r} not found'}

                value = mem_result.get('value')

                if path:
                    # JMESPath mode — extract a specific field or slice from
                    # the stored object and return it as a preview string.
                    try:
                        value = jmespath.search(path, value)
                    except Exception as exc:
                        return {'tool': tool, 'key': key, 'error': f'JMESPath error: {exc}'}

                    # Cap large arrays to avoid flooding the prompt context.
                    # The LLM is told about truncation via returned_items/total_items
                    # so it can decide to use indexed paths or {{memory.ref}} template
                    # in the answer instead.
                    if isinstance(value, list) and len(value) > _PEEK_MAX_ARRAY_ITEMS:
                        total_items = len(value)
                        preview = json.dumps(value[:_PEEK_MAX_ARRAY_ITEMS], ensure_ascii=False)
                        return {
                            'tool': tool,
                            'key': key,
                            'path': path,
                            'preview': preview,
                            'truncated': True,
                            'returned_items': _PEEK_MAX_ARRAY_ITEMS,
                            'total_items': total_items,
                        }
                    preview = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
                    return {'tool': tool, 'key': key, 'path': path, 'preview': preview}

                # No path — chunked raw text read.
                # Serialise non-string values to JSON first so offset/length
                # arithmetic works on a stable string representation.
                if not isinstance(value, str):
                    value = json.dumps(value, ensure_ascii=False, indent=2)
                offset = int(args.get('offset', 0))
                length = int(args.get('length', _PEEK_DEFAULT_LENGTH))
                chunk = value[offset : offset + length]
                return {
                    'tool': tool,
                    'key': key,
                    'preview': chunk,
                    'offset': offset,
                    'length': len(chunk),
                    'total_chars': len(value),
                }

            # Regular tool — route through AgentBase.call_tool, which forwards
            # to context.tools.invoke (and ultimately the engine's control-plane
            # invoke seam at the appropriate node).
            result = agent_base.call_tool(context, tool, args)

            # Store the result in memory and return a structural summary.
            # The summary is what gets injected into the next planning prompt;
            # the full result stays in memory for later memory.peek access.
            return _store_and_preview(tool, key, result, context, agent_base)

        except Exception as exc:
            err_msg = f'{type(exc).__name__}: {exc}'
            error(f'rocketride wave execute tool={tool!r} error={err_msg}')
            # Return an error dict rather than propagating — the LLM sees the
            # error in the next prompt and can decide how to recover.
            return {'tool': tool, 'key': key, 'error': err_msg}

    # Cap workers to the actual number of calls — no point spinning up idle threads.
    n = min(_MAX_WORKERS, len(tagged))

    # Pre-allocate the results list so we can place results by index regardless
    # of which future completes first (as_completed() returns in arbitrary order).
    results: List[Any] = [None] * len(tagged)

    with ThreadPoolExecutor(max_workers=n) as pool:
        # Build a future→index mapping so we can place each result correctly.
        # Run each task under a copy of the current context: a raw submit does not
        # propagate context vars, so per-turn LLM usage (llm_adapter._TURN_CALLS) would
        # not reach the open turn's collector and the agent's answer would under-count.
        future_to_idx = {pool.submit(copy_context().run, _run_one, call): i for i, call in enumerate(tagged)}
        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                results[idx] = future.result()
            except Exception as exc:
                # future.result() should not raise since _run_one catches all
                # exceptions internally, but handle defensively just in case.
                call = tagged[idx]
                results[idx] = {
                    'tool': call.get('tool', ''),
                    'key': call['_key'],
                    'error': f'{type(exc).__name__}: {exc}',
                }

    # Filter out any None slots (shouldn't happen, but guards against bugs)
    return [r for r in results if r is not None]


def execute_wave(
    wave: List[Dict[str, Any]],
    *,
    agent_base: AgentBase,
    context: AgentContext,
    wave_name: str = 'wave-0',
) -> List[Dict[str, Any]]:
    """Execute all tool calls in a wave concurrently.

    Every result is stored in memory under ``<wave_name>.r<idx>`` and a
    compact entry dict is returned containing:
      tool, key, summary — or tool, key, error on failure.

    Args:
        wave: List of ``{"tool": str, "args": dict}`` dicts.
        agent_base: The driver instance — used to call ``call_tool`` for
            tool invocation through the AgentBase host adapter.
        context: The current agent run context (carries the host channels).
        wave_name: Name prefix for generated memory keys (e.g. ``"wave-0"``).

    Returns:
        List of result dicts (same order as wave).
    """
    return _execute_wave_calls(wave, agent_base=agent_base, context=context, wave_name=wave_name)
