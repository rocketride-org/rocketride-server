# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Shared text reply protocol for host-LLM agent adapters (#3367, #935).

Both adapters use the same parser, final-answer recovery and bounded retry loop.
The module returns plain Python data; adapters construct their framework messages.
DeepAgent enables parallel calls; LangChain keeps its single-call protocol.
Prompts and execution remain the drivers' responsibility.
"""

from __future__ import annotations

import json
import re
import uuid
from bisect import bisect_left
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from ai.common.utils import safe_str


@dataclass
class ParsedReply:
    """An answer or pending tool calls, ready for conversion to a framework message."""

    content: str = ''
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)


#: Announces a final answer in place of a JSON envelope. Every character after it is the
#: answer, verbatim, so there is nothing to escape.
FINAL_SENTINEL = 'FINAL>>>'

#: Model calls made for one turn before the turn is given up on.
_MAX_ATTEMPTS = 3

#: The sentinel at the start of a line. Text that mentions it mid-line does not announce an answer.
_SENTINEL_LINE = re.compile(rf'(?:\A|(?<=[\r\n]))[ \t]*{re.escape(FINAL_SENTINEL)}')

#: Markdown fence lines; only a matching, closed block can quote a trailing example.
_FENCE_LINE = re.compile(r'(?:\A|(?<=[\r\n]))[ \t]*(`{3,}|~{3,})([^\r\n]*)')

#: A reply that opens with a JSON object, optionally inside a markdown fence: a brace, then a quoted key and
#: its colon, its closing, or the end of a reply that was cut off there. Either kind of quote, because a model
#: may write a Python dict. A brace followed by anything else opens prose.
_ENVELOPE_OPEN = re.compile(r"""^\s*(?:```[^\s`{\[]*\s*)?\{\s*(?:\}|\Z|(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*:)""")

#: An object's opening brace.
_OBJECT_OPENING = re.compile(r'\{')

#: An opening key may have lost either quote, putting the member walk out of step.
_DAMAGED_OBJECT_OPEN = re.compile(r'\{\s*(?:"|[A-Za-z_]\w*"\s*:)')

#: A final envelope written as a JavaScript object is still protocol, not an answer to deliver.
_LOOSE_FINAL_OPEN = re.compile(r"""\{\s*(?:type|'type')\s*:\s*["']final["']""")

#: A word: a letter or a digit. Punctuation, a brace and an underscore are not words.
_WORD = re.compile(r'[^\W_]')

#: A first object in an explicit code expression is data, even with name/args keys.
_CODE_OBJECT_PREFIX = re.compile(r'(?:^[ \t]*(?:return|yield)\b|(?:[=(]|=>)\s*$)')

#: A word after an object on its line. Punctuation and closings are not words, and the line is read no
#: further than a markup tag, a comment or another object that opens there.
_WORD_AFTER = re.compile(r'[^\w\n\r{\[</#]*[^\W_]')

#: Strings an object may open with before its first key: a key that lost its colon and its value, or a
#: comment's quoted words.
_STRINGS_BEFORE_A_KEY = 3

#: What the walk over an object stops at: a string, the quote of a string that never ends, a brace or a bracket.
_TOKEN = re.compile(r'"[^"\\]*(?:\\.[^"\\]*)*"|["{}\[\]]', re.S)

#: What follows a key: its colon, and its value when that is a string. Group 1 is the value, as written.
_MEMBER_VALUE = re.compile(r'\s*:(?:\s*"([^"\\]*(?:\\.[^"\\]*)*)")?', re.S)

#: What follows a string in JSON: a colon, a comma, a closing, or the end of a reply that was cut off there.
#: A comment may follow one too, as JSON with comments has them.
_AFTER_STRING = re.compile(r'\s*(?:[:,}\]]|//|/\*|\Z)')

#: Where a comment starts, as JSON with comments has them. It is not what stands before the string after it.
_COMMENT_START = re.compile(r'//|/\*')

#: An object that opens with its type, as the prompt writes both envelopes. Group 1, 2 or 3 is the type, as written.
#: The key is in either kind of quote, or in none, as a JavaScript object has it, when the type is a tool call's.
#: It is how a tool call that JSON cannot read at all is still told on a line of its own.
_TYPE_FIRST = re.compile(
    r"""\{\s*(?:(?:"type"|'type')\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')|type\s*:\s*["'](tool_calls?)["'])"""
)

#: A tool call's type right after the brace, with the key or its colon miswritten: no colon, ``=`` or a
#: full-width colon in its place, curly quotes, or a key that lost its closing quote. Group 1 is the type.
_MISWRITTEN_TYPE = re.compile(r'\{\s*["“”]type["“”]?\s*[:：=]?\s*["“”]?(tool_calls?)["“”]')

#: An envelope type, or a tool call's arguments, named in text. Group 1 is the type, group 2 the ``args`` key.
#: Looked for when an object's own members do not say what it is.
_NAMED_MEMBER = re.compile(r'"type"\s*:\s*"(tool_calls?|final)"|"(args)"\s*:')

#: The closing of one envelope followed by the opening of an object. The match ends at the object's brace.
_STACKED_OBJECT = re.compile(r'"\s*\}\s*(?:```\s*)?(?=\{)')

#: The opening of a `final` envelope, up to the first character of its content. A markdown fence may open first.
_FINAL_ENVELOPE_OPEN = re.compile(r'^\s*(?:```[^\s`{\[]*\s*)?\{\s*"type"\s*:\s*"final"\s*,\s*"content"\s*:\s*"', re.S)

#: The end of a `final` envelope: the quote that closes the content, then the closing brace, then the fence if there was one.
_FINAL_ENVELOPE_CLOSE = re.compile(r'"\s*\}\s*(?:```\s*)?$')

#: A quote in unescaped content with what may be another member after it: a comma, a key and its colon. Group 1 starts at the key.
_MEMBER_AFTER = re.compile(r'"\s*,\s*("(?:[^"\\]|\\.)*"\s*:)')

#: The start of a string value after a member's colon.
_STRING_VALUE = re.compile(r'\s*"')

#: More object members after an early closing brace in a malformed object.
_MEMBER_CONTINUATION = re.compile(r'\s*,\s*"')

#: A markdown fence that encloses all of a text. Group 1 is what is inside it.
_ENCLOSING_FENCE = re.compile(r'```[^\s`{\[]*\s*(.*)```', re.S)

#: The digits of a ``\uXXXX`` escape. ``int(x, 16)`` alone also takes a sign, a space and an underscore.
_HEX4 = re.compile(r'[0-9A-Fa-f]{4}')

_TOOL_CALL_KINDS = ('tool_call', 'tool_calls')

_ENVELOPE_KINDS = _TOOL_CALL_KINDS + ('final',)

_TOOL_CALL_SHAPE = '{"type":"tool_call","name":"server.tool","args":{...}}'

_TOOL_CALLS_SHAPE = '{"type":"tool_calls","calls":[{"name":"server.tool","args":{...}}, ...]}'


def _message(content: str = '', tool_calls: Optional[List[Dict[str, Any]]] = None) -> ParsedReply:
    """The final answer or tool calls to give to the framework adapter."""
    return ParsedReply(content=content, tool_calls=tool_calls or [])


def _without_fence(raw: str) -> str:
    """The reply with surrounding whitespace and one enclosing markdown fence removed."""
    s = raw.strip()
    if s.startswith('```'):
        s = s.split('\n', 1)[1] if '\n' in s else s[3:]
        if '```' in s:
            s = s.rsplit('```', 1)[0]
        s = s.strip()
    return s


def _extract_first_json_object(raw: Any) -> Any:
    """
    The first JSON object in a model reply, or None when there is none or it is not valid JSON.

    Read from the first ``{`` of the reply, preserving the adapters' envelope extraction.
    Prose before it, a markdown fence, an enclosing array and a second object after it do not get
    in the way.
    """
    if not isinstance(raw, str):
        return None
    start = raw.find('{')
    if start < 0:
        return None
    try:
        obj, _end = json.JSONDecoder().raw_decode(raw, start)
    except Exception:
        return None
    return obj


def _own_members(text: str, at: int) -> Tuple[Dict[str, Optional[str]], Optional[int], bool]:
    """
    The members the object that opens at `at` carries itself, where it ends, and whether a quote in it is out of place.

    Walks the object once and collects each key at its top level, not the ones nested in its
    values, with its value when that is a string and None when it is anything else. Keys and
    values are unescaped as JSON would unescape them, so ``"tool\\u005fcall"`` is ``tool_call``.
    This is how an object that does not parse is still read for what it set out to be.

    A brace that is not followed by a key opens no object: a block of code, a set, a brace in a
    sentence. Nothing more of it is read, and it has no members. A few strings may come before
    the first key, because a key that lost its colon is still the opening of an object. The quote
    there counts as out of place.

    The end is the position after the closing brace. It is None for an object that never closes
    and for a brace that opens no object and is not closed at once. A quote is out of place when
    a string stands where JSON has none: not after a brace, a bracket, a comma or a colon, or
    not before a colon, a comma or a closing, comments aside. The walk may then be out of step
    with the object, so it finds what comes before that quote and may miss what follows.
    """
    members: Dict[str, Optional[str]] = {}
    depth, stray, read, keyless = 0, False, at, 0
    for token in _TOKEN.finditer(text, at):
        written = token.group()
        if written == '"':
            # A string that never ends: nothing after it can be read.
            break
        if len(written) > 1:
            follows = _MEMBER_VALUE.match(text, token.end())
            if depth == 1 and follows:
                members.setdefault(
                    _unescape_json_string_body(written[1:-1]),
                    None if follows.group(1) is None else _unescape_json_string_body(follows.group(1)),
                )
            between = text[read : token.start()]
            comment = _COMMENT_START.search(between)
            before = (between[: comment.start()] if comment else between).rstrip()[-1:] or text[read - 1]
            stray = stray or before not in '{[,:' or not _AFTER_STRING.match(text, token.end())
        elif written in '{[':
            depth += 1
        else:
            depth -= 1
            if depth <= 0:
                return members, token.end(), stray
        if not members and token.start() > at:
            # No key yet. A string may be a key that lost its colon. Anything else opens no object.
            keyless += 1
            if len(written) == 1 or keyless > _STRINGS_BEFORE_A_KEY:
                return {}, None, False
            stray = True
        read = token.end()
    return members, None, stray


def _mentions(text: str) -> Tuple[List[int], List[str], List[int], List[int]]:
    """
    Where the text names what an envelope has: the tool call types with their positions, the `final` types, the ``args`` keys.

    Collected in one pass, so that asking what is named after one object or another costs a lookup.
    """
    calls: List[int] = []
    kinds: List[str] = []
    finals: List[int] = []
    args: List[int] = []
    for named in _NAMED_MEMBER.finditer(text):
        if named.group(2):
            args.append(named.start())
        elif named.group(1) == 'final':
            finals.append(named.start())
        else:
            calls.append(named.start())
            kinds.append(named.group(1))
    return calls, kinds, finals, args


def _named(
    mentions: Tuple[List[int], List[str], List[int], List[int]], at: int, stop: int
) -> Tuple[Optional[str], bool]:
    """
    What the text names from `at` up to `stop`: an envelope type, and whether a tool call's arguments.

    A tool call's type comes before `final`, because a broken call must stay a call.
    """
    calls, kinds, finals, args = mentions
    call, final, arg = bisect_left(calls, at), bisect_left(finals, at), bisect_left(args, at)
    if call < len(calls) and calls[call] < stop:
        named_type: Optional[str] = kinds[call]
    else:
        named_type = 'final' if final < len(finals) and finals[final] < stop else None
    return named_type, arg < len(args) and args[arg] < stop


def _closed_fences(text: str) -> Iterator[Tuple[int, int]]:
    """Closed markdown blocks, in one pass; an unterminated block hides nothing."""
    opening = None
    for fence in _FENCE_LINE.finditer(text):
        marker, rest = fence.groups()
        if opening is None:
            if marker[0] != '`' or '`' not in rest:
                opening = fence
        elif marker[0] == opening.group(1)[0] and len(marker) >= len(opening.group(1)) and not rest.strip():
            yield opening.start(), fence.end()
            opening = None


def _code_object_prefix(prefix: str) -> bool:
    """An explicit code expression before the first object on its line."""
    if _CODE_OBJECT_PREFIX.search(prefix):
        return True
    if not prefix.rstrip().endswith(','):
        return False
    # A later argument needs an open parenthesis, ignoring parentheses inside strings.
    depth, quote, escaped = 0, '', False
    for char in prefix:
        if quote:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == quote:
                quote = ''
        elif char in '"\'`':
            quote = char
        elif char == '(':
            depth += 1
        elif char == ')':
            depth = max(0, depth - 1)
    return depth > 0 and not quote


def _envelopes(text: str, *, allow_code: bool = True) -> Iterator[Tuple[str, Any, int]]:
    """
    Yield (type, parsed object, start) for envelopes; an unfinished envelope has no parsed object.

    An object is quoted when it has a word before it and a word after it on its line. Any other
    object stands as written, whatever punctuation, brace, closing, markup tag or comment is around
    it. Parsed envelopes count by their own ``"type"``, in whatever order their members come.
    A tool call is pending work; a parsed `final` is complete. An unparsed envelope may be cut
    off or have broken escaping. Of quoted objects only a tool call that does not parse counts:
    work that never ran is not prose.

    An object with a tool call's ``name`` and ``args`` and no type will not run. It counts as a
    tool call as the first object (unless allow_code exempts a code expression), or with no word
    before it on its line. Anywhere else it is data or code, as in an answer that shows a
    function being called with such an object. A leading return/yield, assignment, arrow function
    or same-line function argument marks code; prose such as ``Calling: {...}`` still counts as a call.
    The exemption permits prose fallback only: checks for pending work before accepting a final
    and hints for replies containing a final claim use the strict reading, with allow_code=False.

    After a parsed final, a new closed markdown block quotes an example. Its objects are not
    pending work. A call outside that block, or inside an unclosed block, still counts.

    An object that does not parse is read by its own members (``_own_members``): its type, or a
    tool call's name and arguments with no type. When it has neither, what its own text names
    decides (``_named``). When a quote out of place or a missing closing kept its members from
    being read, that is the text up to the end of the reply, and arguments named there make a
    tool call of an object that has a name. An object of another type owns what is inside it
    when it was read to its closing. When it was not, a tool call named after its first line
    still counts.

    A brace that opens no object is prose and hides nothing that follows it. With no word before
    it on its line it is still a tool call when a tool call's type comes right after it with no
    quotes or in single quotes, as JavaScript and Python write one. And a tool call's type right
    after a brace is a tool call anywhere when only the key or its colon is miswritten
    (``_MISWRITTEN_TYPE``).

    A brace that opens no object costs a look at what follows it. An object is read once, with
    what is inside it, and the reply is searched once for what it names. So the time this takes
    grows with the length of the reply and no faster.
    """
    first, read_to, looked_to, word_before = text.find('{'), 0, 0, False
    final_end = 0
    fences, fenced = _closed_fences(text), (0, 0)
    mentions: Optional[Tuple[List[int], List[str], List[int], List[int]]] = None
    for opening in _OBJECT_OPENING.finditer(text):
        at = opening.start()
        # Whether a word stands before the brace on its line. The text between one brace and the next is
        # looked at once, and a brace earlier on the line is no word.
        line = max(text.rfind('\n', looked_to, at), text.rfind('\r', looked_to, at)) + 1
        if line:
            word_before, looked_to = False, line
        word_before = word_before or bool(_WORD.search(text, looked_to, at))
        looked_to, no_word_before = at, not word_before
        if at < read_to:
            continue
        if final_end:
            while fenced[1] <= at:
                fenced = next(fences, (len(text), len(text)))
            if final_end <= fenced[0] <= at < fenced[1]:
                read_to = fenced[1]
                continue
        members, end, stray = _own_members(text, at)
        miswritten = None if 'type' in members else _MISWRITTEN_TYPE.match(text, at)
        if miswritten:
            yield miswritten.group(1), None, at
            return
        if no_word_before and _LOOSE_FINAL_OPEN.match(text, at):
            yield 'final', None, at
            return
        if not members:
            loose = _TYPE_FIRST.match(text, at) if no_word_before else None
            if loose and (loose.group(1) or loose.group(2) or loose.group(3)) in _TOOL_CALL_KINDS:
                yield loose.group(1) or loose.group(2) or loose.group(3), None, at
                return
            # A damaged first key can put every later string out of step. A literal envelope type
            # still counts; braces in code and sets do not acquire a type from unrelated later text.
            if _DAMAGED_OBJECT_OPEN.match(text, at):
                mentions = mentions or _mentions(text)
                closed = end is not None and not stray and not _MEMBER_CONTINUATION.match(text, end)
                kind, _args = _named(mentions, at, end if closed else len(text))
                if kind in _TOOL_CALL_KINDS or (kind == 'final' and no_word_before):
                    yield kind, None, at
                    return
            continue
        stands = no_word_before or end is None or not _WORD_AFTER.match(text, end)
        # Read to its closing, with every quote in its place.
        try:
            parsed = json.loads(text[at:end]) if end else None
        except Exception:
            parsed = None
        read = end is not None and not stray and not (parsed is None and _MEMBER_CONTINUATION.match(text, end))
        own = members.get('type')
        # Where a name and arguments with no type make a tool call. Elsewhere they are data or code.
        may_lack_type = no_word_before or (at == first and not (allow_code and _code_object_prefix(text[line:at])))
        if isinstance(parsed, dict):
            names_a_tool = may_lack_type and isinstance(parsed.get('name'), str) and 'args' in parsed
            kind = parsed.get('type', 'tool_call' if names_a_tool else None) if stands else None
        elif own in _ENVELOPE_KINDS or (own is not None and read):
            # Its own type says what it is. An object of another type that was read owns what is inside it.
            kind = own
        elif may_lack_type and 'type' not in members and isinstance(members.get('name'), str) and 'args' in members:
            kind = 'tool_call'
        else:
            mentions = mentions or _mentions(text)
            if own is not None:
                # Another type, and not read to its closing: a tool call named after its first line still counts.
                line_end = text.find('\n', at)
                named_type, _names_args = _named(mentions, len(text) if line_end < 0 else line_end, len(text))
                kind = named_type if named_type in _TOOL_CALL_KINDS else None
            else:
                named_type, names_args = _named(mentions, at, end if read else len(text))
                has_a_name = may_lack_type and not read and isinstance(members.get('name'), str)
                names_a_call = named_type in _TOOL_CALL_KINDS
                kind = 'tool_call' if names_args and has_a_name and not names_a_call else named_type
        if isinstance(kind, str) and kind in (_ENVELOPE_KINDS if stands else _TOOL_CALL_KINDS):
            if kind == 'final' and parsed is not None and not final_end:
                final_end = end or 0
            yield kind, parsed, at
            if parsed is None:
                return
        if end is None:
            # It never closes, so the rest of the text is inside it.
            break
        read_to = end
    return None


def _unfinished_envelope(text: str) -> Optional[str]:
    """The first pending call or broken final; a parsed final is already complete."""
    for kind, parsed, _at in _envelopes(text, allow_code=False):
        if kind in _TOOL_CALL_KINDS or parsed is None:
            return kind
    return None


def _tool_call_without_type(text: str) -> bool:
    """
    Whether the first JSON object in the text has a tool call's name and arguments and no ``"type"``.

    Also when the object does not parse: bad escaping in the arguments does not make it less of a
    call. Only the first object is looked at, as the parser reads a reply.
    """
    obj = _extract_first_json_object(text)
    start = text.find('{')
    members = obj if isinstance(obj, dict) else _own_members(text, start)[0] if start >= 0 else {}
    return 'type' not in members and isinstance(members.get('name'), str) and 'args' in members


def _attempted_kind(text: str) -> Optional[str]:
    """
    The envelope type a reply is, or was reaching for: ``tool_call``, ``tool_calls``, ``final`` or None.

    The first JSON object's own ``"type"`` when that object parses and is an envelope, wherever
    it sits, as the parser reads it. Otherwise the first standing envelope
    (``_envelopes``), complete or unfinished. A broken `final` quoted inside a sentence is prose, and so is
    text that mentions a type with no object opening on it.
    """
    obj = _extract_first_json_object(text)
    kind = obj.get('type') if isinstance(obj, dict) else None
    if isinstance(kind, str) and kind in _ENVELOPE_KINDS:
        return kind
    return next(_envelopes(text), (None, None, 0))[0]


def _escape_code(body: str, at: int) -> Optional[int]:
    """The code unit of a ``\\uXXXX`` escape whose digits start at `at`, or None when they are not four hex digits."""
    digits = body[at : at + 4]
    return int(digits, 16) if _HEX4.fullmatch(digits) else None


def _unescape_json_string_body(body: str) -> str:
    """
    Undo JSON string escaping, tolerating the escapes that broke the envelope.

    ``json.loads`` is all or nothing: one unescaped quote and the whole answer is lost. This walks
    the body instead, translating the escapes it recognises and passing everything else through
    as itself.
    """
    simple = {'n': '\n', 't': '\t', 'r': '\r', 'b': '\b', 'f': '\f', '"': '"', '\\': '\\', '/': '/'}
    out: List[str] = []
    i, n = 0, len(body)
    while i < n:
        ch = body[i]
        if ch != '\\' or i + 1 >= n:
            out.append(ch)
            i += 1
            continue
        nxt = body[i + 1]
        if nxt in simple:
            out.append(simple[nxt])
            i += 2
        elif nxt == 'u' and (code := _escape_code(body, i + 2)) is not None:
            # A surrogate pair is one character spelled as two escapes. Decoded apart they are two
            # lone surrogates, which `str.encode` refuses, so the answer would raise on its way out.
            low_start = i + 6
            low = _escape_code(body, low_start + 2) if body[low_start : low_start + 2] == '\\u' else None
            if 0xD800 <= code <= 0xDBFF and low is not None and 0xDC00 <= low <= 0xDFFF:
                out.append(chr(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)))
                i = low_start + 6
                continue
            # Preserve an unpaired surrogate as escape text, so recovered answers encode as UTF-8.
            out.append(body[i : i + 6] if 0xD800 <= code <= 0xDFFF else chr(code))
            i += 6
        else:
            # Preserve unknown escapes literally. Recognized JSON escapes above are
            # still decoded; use FINAL>>> when literal backslashes are ambiguous.
            out.append(ch)
            i += 1
    return ''.join(out)


def _is_escaped(text: str, at: int) -> bool:
    """Whether the character at `at` has an odd number of backslashes before it, which makes a quote an escaped one."""
    first = at
    while first > 0 and text[first - 1] == '\\':
        first -= 1
    return (at - first) % 2 == 1


def _inside_fence(text: str) -> Optional[str]:
    """
    The text inside a markdown fence that encloses all of `text`, or None when no fence does.

    The closing is looked at first. On a fence that never closes, the pattern would try every
    split of the whitespace after its opening.
    """
    fenced = _ENCLOSING_FENCE.fullmatch(text) if text.endswith('```') else None
    return fenced.group(1) if fenced else None


def _is_stacked(raw: str, start: int, stop: int) -> bool:
    """
    Whether the content of a broken `final` envelope, from `start` to `stop`, holds its closing and then another envelope.

    The object right after a closing decides, by its own type, wherever that comes among its
    members. An ordinary object there is part of the answer, with whatever it holds, and so is an
    envelope quoted further on.
    """
    read_to = start
    for closing in _STACKED_OBJECT.finditer(raw, start, stop):
        if closing.end() < read_to:
            continue
        members, end, _stray = _own_members(raw, closing.end())
        if members.get('type') in _ENVELOPE_KINDS:
            return True
        read_to = len(raw) if end is None else end
    return False


def _salvage_final_content(raw: Any) -> Optional[str]:
    """
    The answer out of a `final` envelope that does not parse as JSON, or None when it cannot be trusted.

    A reply that opens with ``{"type":"final","content":"`` and ends with ``"}``, in a markdown
    fence or not, holds the answer between the two, and all that is wrong is an escape the model
    missed. A malformed tool call is never recovered into an answer: that would turn work the
    agent meant to do into a sentence claiming it was done.

    Because the content is unescaped, only the end of the reply says which ``"}`` is the
    envelope's own. So these are not recovered, and the reply is retried:

    - an envelope that does not end the reply: it was cut off, or more text follows it;
    - content followed by the envelope's other members (``","note":"z"}``) or by a second
      envelope: after one of its quotes, the rest of the reply reads as members up to the
      closing brace, so the content ended before it. JSON inside the answer does not read that way;
    - content with a ``FINAL>>>`` line in it, which may be the answer's own text or the sentinel;
    - content with the closing of one envelope and the opening of another in it: two envelopes.

    One cut-off still reads as closed: a reply that stops right after an unescaped ``"}`` inside the answer.
    """
    if not isinstance(raw, str):
        return None
    opening = _FINAL_ENVELOPE_OPEN.match(raw)
    closing = _FINAL_ENVELOPE_CLOSE.search(raw, opening.end()) if opening else None
    # An escaped quote is the answer's own and closes nothing: the reply was cut off right there.
    if not closing or _is_escaped(raw, closing.start()):
        return None
    content = raw[opening.end() : closing.start()]
    # A JSON document pasted in as it is, in a markdown fence or not: its backslashes are its own,
    # and undoing them would break it.
    inside = _inside_fence(content.strip())
    try:
        if isinstance(json.loads(content if inside is None else inside), (dict, list)):
            return content
    except Exception:
        pass
    if _SENTINEL_LINE.search(content) or _is_stacked(raw, opening.end(), closing.start()):
        return None
    # The envelope's other members after the content: the reply, from the last such key on, reads as its end.
    members = list(_MEMBER_AFTER.finditer(content))
    if members:
        # A trailing string member may have the same bad escaping as content. It need not be valid
        # JSON to be metadata. Keep members inside JSON examples in the answer, and ordinary prose
        # such as `Either "yes", "no": pick one.` which does not start a string value.
        tokens = iter(_TOKEN.finditer(content))
        token = next(tokens, None)
        depth = 0
        for member in members:
            while token is not None and token.start() < member.start():
                written = token.group()
                if written in ('{', '['):
                    depth += 1
                elif written in ('}', ']'):
                    depth = max(0, depth - 1)
                token = next(tokens, None)
            if depth == 0 and _STRING_VALUE.match(content, member.end()):
                return None
        try:
            json.loads('{' + content[members[-1].start(1) :] + '"}')
            return None
        except Exception:
            pass
    return _unescape_json_string_body(content)


def _looks_like_envelope(raw: Any) -> bool:
    """
    Whether a reply opens with a JSON object, in a markdown fence or not.

    One that never parsed into a tool call or an answer is not prose to deliver. Prose that
    merely starts with a brace is not one.
    """
    return isinstance(raw, str) and bool(_ENVELOPE_OPEN.match(raw) or _LOOSE_FINAL_OPEN.match(_without_fence(raw)))


def _call_array(raw: str) -> Optional[Tuple[Dict[str, Any], int]]:
    """A call array as a batch and its end offset; never extract a partial batch."""
    start, brace = raw.find('['), raw.find('{')
    if start < 0 or 0 <= brace < start:
        return None
    try:
        entries, end = json.JSONDecoder().raw_decode(raw, start)
    except (ValueError, RecursionError):
        if _without_fence(raw).startswith('[') and _attempted_kind(raw) in _TOOL_CALL_KINDS:
            return {'type': 'tool_calls', 'calls': None}, len(raw)
        return None
    if not isinstance(entries, list):
        return None
    if not any(isinstance(entry, dict) and entry.get('type') in _TOOL_CALL_KINDS for entry in entries):
        if _attempted_kind(raw[start:end]) not in _TOOL_CALL_KINDS:
            return None
    # An array contains complete call envelopes, unlike a tool_calls list's name/args entries.
    calls = [entry if isinstance(entry, dict) and entry.get('type') == 'tool_call' else None for entry in entries]
    return {'type': 'tool_calls', 'calls': calls}, end


def _batch_problem(entries: Any) -> Optional[str]:
    """Validate every call before any of a parallel batch can run; report only its index."""
    if not isinstance(entries, list) or not entries:
        return 'needs a non-empty calls list.'
    for index, entry in enumerate(entries):
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get('name'), str)
            or not entry['name'].strip()
            or entry.get('type', 'tool_call') != 'tool_call'
        ):
            return f'has an invalid call at index {index}; each entry must name a tool.'
    return None


def _ambiguous_call_before_sentinel(raw: str) -> bool:
    """Later prose can retract or quote a call: retry this mix instead of dispatching it."""
    marker = _SENTINEL_LINE.search(raw)
    if marker is None:
        return False
    before = raw[: marker.start()]
    array = _call_array(before)
    if array is not None:
        ends = [array[1]]
    else:
        ends = [
            json.JSONDecoder().raw_decode(before, at)[1]
            for kind, parsed, at in _envelopes(before, allow_code=False)
            if kind in _TOOL_CALL_KINDS and parsed is not None
        ]
    # Find the last word's line once, rather than rescan the suffix after every call.
    last_word = -1
    for word in _WORD.finditer(before):
        last_word = word.start()
    if last_word < 0:
        return False
    line = max(before.rfind('\r', 0, last_word), before.rfind('\n', 0, last_word))
    return any(end <= line for end in ends)


def _sentinel(raw: str) -> Optional['re.Match[str]']:
    """
    The ``FINAL>>>`` line that announces the answer, or None when the reply has no line that does.

    A marker line is not the sentinel when an envelope that is not finished stands before it
    (``_unfinished_envelope``): a tool call that is not quoted, the first line included, a tool
    call anywhere that does not parse, or a broken `final` that is not quoted. After a tool call
    the line is a claim about work that has not run. After the opening of a broken `final` it
    may be the answer's own text or the sentinel, and nothing says which. The reply is then read
    as its first JSON object, as every reply without a sentinel is. A tool call that parses with
    a word before it and a word after it on its line is quoted, and a `final` that parses is
    finished: neither takes anything away from the marker.
    """
    marker = _SENTINEL_LINE.search(raw)
    return None if not marker or _unfinished_envelope(raw[: marker.start()]) else marker


def _after_sentinel(rest: str) -> str:
    """
    The text after the ``FINAL>>>`` marker, with only the marker's separator removed.

    One separator comes off: a newline, or a space or tab on the same line. Any further
    whitespace is the answer's own: leading spaces open a code block, and a blank first line is a
    deliberate gap.
    """
    if rest.startswith('\r\n'):
        return rest[2:]
    if rest[:1] in ('\n', '\r', ' ', '\t'):
        return rest[1:]
    return rest


def _sentinel_answer(text: str) -> Optional[str]:
    """
    What is delivered for the text after the sentinel, or None when that text is not an answer.

    Nearly always the text itself, as written. The exception is a model that follows a retry hint
    to ``FINAL>>>`` and still writes the `final` envelope there. Delivered as written, the person
    would be shown the protocol, so text that is a `final` envelope, whole, is read as one: its
    content when it parses or closes, and None when it was cut off. An envelope that parses with
    more text after it is an answer that quotes one, delivered as written. Nothing after the
    marker is None too. A whole tool envelope is retried, never delivered as answer text.
    """
    whole = text.strip()
    if not whole:
        return None
    inside = _inside_fence(whole)
    candidate = whole if inside is None else inside
    array = _call_array(candidate)
    if array is not None and not candidate[array[1] :].strip():
        return None
    try:
        obj = json.loads(candidate)
    except Exception:
        obj = None
    if isinstance(obj, dict):
        if obj.get('type') in _TOOL_CALL_KINDS:
            return None
        if obj.get('type') == 'final':
            return _final_text(obj.get('content', ''))
    broken = _looks_like_envelope(text) and not isinstance(_extract_first_json_object(text), dict)
    return _salvage_final_content(whole) if broken and _attempted_kind(text) == 'final' else text


def _final_text(content: Any) -> str:
    """The text of a `final` envelope's content. Anything but a string is written back as JSON, not as a Python repr."""
    if content is None:
        return ''
    text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
    # json.loads accepts lone surrogates; keep them as escape text, including in nested JSON content.
    return text.encode('utf-8', errors='backslashreplace').decode('utf-8')


def _tool_call(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The tool call a `tool_call` envelope asks for, or None when it names no tool."""
    name = safe_str(entry.get('name', '')).strip()
    if not name:
        return None
    args = entry.get('args')
    if args is None:
        args = {}
    elif not isinstance(args, dict):
        # Whatever the model sent still reaches the tool, a false, 0 or empty value included.
        args = {'input': args}
    # The id is an opaque token LangGraph uses to pair the call with its result.
    return {'id': f'call_{uuid.uuid4().hex[:12]}', 'type': 'tool_call', 'name': name, 'args': args}


def parse_reply(raw: Any, *, allow_parallel: bool = False) -> Optional[ParsedReply]:
    """
    Parse one model reply into the ``ParsedReply`` for the turn.

    A ``FINAL>>>`` line that is the sentinel (``_sentinel``) comes first: what follows it is the
    answer, and there is nothing in it to escape. With nothing after it, a `final` envelope that
    parses before it is the answer. Otherwise the first JSON object is the envelope,
    or a standing envelope on a later line after a non-envelope preamble: a `tool_call` runs and a `final` gives its
    content. A `final` envelope that does not parse but closes is recovered
    (``_salvage_final_content``).

    Everything else is refused: a bare JSON object (it may be a tool call that lost its
    ``"type"``), a tool call that names no tool, and the ``tool_calls`` form with several calls
    in one reply unless the driver enables ``allow_parallel``. A call array is a batch too;
    only a single-call array is accepted without parallel support. Every batch entry must be
    valid before any call runs. Prose on later lines between a call and the sentinel is
    ambiguous and is retried rather than dispatched.

    Returns:
        An ``ParsedReply`` carrying the answer or the tool call, or None when the reply is
        neither. None sends the model through the retry loop.
    """
    if not isinstance(raw, str):
        return None
    if _ambiguous_call_before_sentinel(raw):
        return None

    marker = _sentinel(raw)
    if marker:
        # Delivered as written: only the separator comes off, never the answer's own whitespace.
        answer = _sentinel_answer(_after_sentinel(raw[marker.end() :]))
        if answer is not None:
            return _message(content=answer)
        # Nothing after the marker: a `final` envelope that parses before it is still the answer.
        obj = _extract_first_json_object(raw) if not raw[marker.end() :].strip() else None
        if isinstance(obj, dict) and obj.get('type') == 'final':
            return _message(content=_final_text(obj.get('content', '')))
        return None

    array = _call_array(raw)
    obj = array[0] if array is not None else _extract_first_json_object(raw)
    if array is not None and not allow_parallel:
        entries = obj['calls']
        if _batch_problem(entries) or len(entries) != 1:
            return None
        obj = entries[0]
    if (not isinstance(obj, dict) or obj.get('type') not in _ENVELOPE_KINDS) and not _SENTINEL_LINE.search(raw):
        # A brace in a preamble must not hide the envelope. Read only standing,
        # outer objects; never skip an unfinished envelope to execute a later one.
        candidate = next(_envelopes(raw), None)
        if candidate is not None:
            _kind, parsed, at = candidate
            line = max(raw.rfind('\n', 0, at), raw.rfind('\r', 0, at)) + 1
            # Only a new line can introduce a later envelope. A template's extra
            # brace does not authorize a nested call, nor does a mixed sentinel reply.
            if not raw[line:at].strip() and not raw[:at].rstrip().endswith('{'):
                obj = parsed
    if not isinstance(obj, dict):
        salvaged = _salvage_final_content(raw)
        return _message(content=salvaged) if salvaged else None

    if obj.get('type') == 'final':
        # A claimed result followed by pending work is not a completed turn.
        if _unfinished_envelope(raw) in _TOOL_CALL_KINDS:
            return None
        return _message(content=_final_text(obj.get('content', '')))
    if obj.get('type') == 'tool_call':
        call = _tool_call(obj)
        return _message(tool_calls=[call]) if call else None
    if obj.get('type') == 'tool_calls' and allow_parallel:
        entries = obj.get('calls')
        if _batch_problem(entries):
            return None
        return _message(tool_calls=[_tool_call(entry) for entry in entries])
    return None


def _diagnose(raw: Any, *, allow_parallel: bool = False) -> Tuple[str, str, str]:
    """
    What was wrong with a reply, and what the model should send instead.

    Returns:
        ``(problem, excerpt, remedy)``. The problem completes "Your last output ..." and "The
        last reply ...", so it also goes into the error a failed turn raises. The excerpt quotes
        the reply around the break and the remedy is an instruction to this model: both go to the
        model only, because the error is logged and returned to the caller. Either may be empty.
    """
    text = safe_str(raw).strip()
    if not text:
        return 'was empty.', '', ''
    shapes = f'{_TOOL_CALL_SHAPE} or {_TOOL_CALLS_SHAPE}' if allow_parallel else _TOOL_CALL_SHAPE
    if _ambiguous_call_before_sentinel(text):
        return (
            f'mixed a tool call with later prose before {FINAL_SENTINEL}.',
            '',
            f'If a tool is needed, send {shapes} without surrounding prose. '
            f'Otherwise send only {FINAL_SENTINEL} followed by the answer.',
        )
    marker = _sentinel(text)
    if marker:
        # What was wrong is in the text after the marker: nothing at all, or an envelope that was cut off.
        text = text[marker.end() :].strip()
        if not text:
            return (
                f'ended at {FINAL_SENTINEL} with no answer after it.',
                '',
                f'Write the answer after {FINAL_SENTINEL}.',
            )

    # A broken answer should come back after the sentinel, where nothing can break again. A broken
    # tool call must come back as a tool call: the sentinel would trade the work for a sentence about it.
    array = _call_array(text)
    attempted = 'tool_calls' if array is not None else _attempted_kind(text)
    began_with_final = attempted == 'final'
    if began_with_final or _SENTINEL_LINE.search(text):
        attempted = _unfinished_envelope(text) or attempted
    wanted_a_tool_call = attempted in _TOOL_CALL_KINDS
    if marker and wanted_a_tool_call:
        return (
            f'put a tool-call envelope after {FINAL_SENTINEL}.',
            '',
            f'Generate the required tool call from the task and tool schema as {shapes}, without {FINAL_SENTINEL}.',
        )
    if began_with_final and wanted_a_tool_call:
        return (
            'combined a final answer with a pending tool call.',
            '',
            'Generate the required tool call from the task and tool schema as one valid JSON object; do not answer in prose.',
        )
    if array is not None and not allow_parallel:
        return 'contained an array of tool calls.', '', f'Send one tool call per reply, as {_TOOL_CALL_SHAPE}.'
    batch = array[0] if array is not None else _extract_first_json_object(text)
    if allow_parallel and isinstance(batch, dict) and batch.get('type') == 'tool_calls':
        problem = _batch_problem(batch.get('calls'))
        if problem:
            return (
                problem,
                '',
                'Send tool_calls with a non-empty calls list; correct every invalid entry before retrying.',
            )
    # Diagnose the JSON itself: without its fence, and from its opening brace when prose came first.
    candidate = _without_fence(text)
    if attempted:
        envelope = next((entry for entry in _envelopes(candidate) if entry[0] == attempted), None)
        start = envelope[2] if envelope is not None else candidate.find('{')
        if start >= 0:
            candidate = candidate[start:]
    try:
        json.loads(candidate)
    except json.JSONDecodeError as err:
        pos = max(0, err.pos)
        excerpt = candidate[max(0, pos - 60) : pos + 20].replace('\n', ' ')
        problem = f'was not valid JSON: {err.msg}, at character {pos}.'
        shown = f' It broke here: ...{excerpt}...'
        if wanted_a_tool_call:
            return (
                problem,
                shown,
                'Generate the required tool call from the task and tool schema as one valid JSON object; do not answer in prose.',
            )
        return problem, shown, f'Do not retype it as JSON: send the answer as {FINAL_SENTINEL} followed by plain text.'
    except Exception:  # noqa: BLE001 - any other parse failure gets the same advice
        return 'could not be parsed.', '', ''

    # Valid JSON that is neither shape: a bare JSON answer, an unknown "type", a
    # tool call with no name, or several calls in one reply.
    problem = 'parsed as JSON, but was not one of the allowed shapes.'
    if attempted == 'tool_calls' and allow_parallel:
        return problem, '', 'Send tool_calls with a non-empty calls list; each call needs a name and args.'
    if attempted == 'tool_calls':
        return problem, '', f'Send one tool call per reply, as {_TOOL_CALL_SHAPE}.'
    if wanted_a_tool_call:
        return problem, '', f'Generate the required tool call from the task and tool schema as {_TOOL_CALL_SHAPE}.'
    return (
        problem,
        '',
        f'To call a tool, send {_TOOL_CALL_SHAPE}. '
        f'To give this JSON as your answer, write {FINAL_SENTINEL} followed by the JSON.',
    )


def _parse_failure_hint(raw: Any, *, allow_parallel: bool = False) -> str:
    """
    What to tell the model about the reply that just failed to parse, as one line for the next prompt.

    "Your last output was invalid" is true and useless: the model cannot see which character
    broke it, so it writes the same reply again. Naming the position and quoting the text around
    it gives the retry a chance.
    """
    problem, excerpt, remedy = _diagnose(raw, allow_parallel=allow_parallel)
    return f'Your last output {problem}{excerpt} {remedy}'.strip()


def run_model_turn(ask: Callable[[str], Any], *, allow_parallel: bool = False) -> ParsedReply:
    """
    Ask the model for one turn, retrying a reply that is neither a tool call nor an answer.

    A turn ends in one of three ways, and a failed turn is never reported as an answer:

    - a reply parsed as a tool call or an answer: it is returned;
    - no reply parsed and the last one is prose: that prose is the answer, because the model
      said something readable. Prose that starts with a brace which opens no object, or that
      mentions a type, is still prose;
    - no reply parsed and the last one is empty, opens with a JSON object, holds an envelope that
      was refused or never parsed (also after prose), has a tool call that lost its ``"type"`` and
      is not quoted, or has a ``FINAL>>>`` line with no answer: the turn raises, so the run ends
      as an error. The error says what was wrong with the last reply and quotes nothing of it.

    Args:
        ask: Sends the turn's prompt with the given text appended, and returns the model's reply.
            The text is empty on the first attempt and grows by one ``_parse_failure_hint`` line
            for each reply that did not parse.
        allow_parallel: Accept plural tool_calls envelopes and arrays of call envelopes.

    Raises:
        ValueError: No attempt produced a tool call or a deliverable answer.
    """
    feedback = ''
    raw = ''
    for _ in range(_MAX_ATTEMPTS):
        raw = safe_str(ask(feedback)).strip()
        message = parse_reply(raw, allow_parallel=allow_parallel)
        if message is not None:
            return message
        feedback += '\n\nsystem: ' + _parse_failure_hint(raw, allow_parallel=allow_parallel)

    # An envelope that never parsed is a tool call that never ran or an answer that was cut off,
    # and a marker line still unparsed here has no answer after it. Neither is prose to deliver.
    undeliverable = (
        not raw or _looks_like_envelope(raw) or _attempted_kind(raw) is not None or _SENTINEL_LINE.search(raw)
    )
    if undeliverable:
        # A line of prose before a tool call that lost its type would otherwise be reported as invalid JSON.
        lost_its_type = _tool_call_without_type(raw)
        problem = (
            'named a tool and its arguments with no "type".'
            if lost_its_type
            else _diagnose(raw, allow_parallel=allow_parallel)[0]
        )
        raise ValueError(f'No valid tool call or final answer after {_MAX_ATTEMPTS} attempts. The last reply {problem}')
    return _message(content=raw)
