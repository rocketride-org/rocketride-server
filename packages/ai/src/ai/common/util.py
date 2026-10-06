import json
import textwrap
import re
from typing import Any
from engLib import debug

__OBFUSCATE_DISPLAY_BUFFER_SIZE = 4  # Number of characters to display before obfuscation


def normalize(input_string: str, max_length: int = 80) -> str:
    """
    Remove leading and trailing whitespaces, and normalize internal spaces.
    """
    normalized_string = ' '.join(input_string.strip().split())

    # Wrap the text to the specified maximum length
    wrapped_string = textwrap.fill(normalized_string, width=max_length)

    return wrapped_string


def safeString(value: str) -> str:
    """
    Replace all double quotes wih single quotes.

    This is done when we send a document over to the LLM as context or something so
    we don't confuse it... The prompts themselves use double quotes...
    """
    # If it is None, return an empty string
    if value is None:
        return ''

    # Create a string from it and replace all the " with \'
    return str(value).strip().replace('"', "'")


class ThinkTruncatedError(ValueError):
    """Raised by ``parseJson`` when all that arrived is an unterminated ``<think>`` block.

    The model exhausted its output budget while still reasoning and never reached the
    JSON, so re-prompting it for "valid JSON" cannot help -- the fix is
    ``modelOutputTokens``, or turning reasoning off for the call. ``ChatBase.chat``
    catches this specifically and fails fast rather than spending its repair retries
    on a budget problem.

    Subclasses ``ValueError`` so callers that already handle a parse failure that way
    are unaffected.
    """


class EmptyResponseError(ValueError):
    """Raised by ``ChatBase.chat`` when a JSON-expecting call gets no text at all.

    A reasoning model does this when it spends its whole output budget before writing
    a reply. Re-sending the same prompt with a note to "fix the JSON" cannot fit a
    budget that already overflowed, so the call fails at once and the message names
    ``modelOutputTokens``.

    Subclasses ``ValueError`` so callers that already handle a parse failure that way
    are unaffected.
    """


def _holdsCompleteJson(value: str) -> bool:
    """True when ``value`` ENDS in a complete JSON object or array.

    Used to tell a model that never reached its JSON apart from one that emitted it and
    merely dropped a closing tag. Two things this deliberately is not:

    A bare '{' or '[' test is too loose -- reasoning about a JSON answer routinely writes
    one ("the schema is {title, body}"), so the character alone would call almost every
    real truncation a success.

    Decoding *anywhere* is also too loose. A model drafting its answer mid-reasoning
    ('I will return {"title": "X"} and then add the') leaves a fragment that decodes
    perfectly but is still followed by prose, and it is still a truncation. So the
    decoded value must run to the end, give or take whitespace and a closing fence.

    Only objects and arrays count as starts. ``parseJson`` accepts a bare scalar, but no
    model answers an expectJson prompt with one, whereas reasoning that happens to break
    off on a number or on the word "true" is an ordinary truncation -- honouring scalars
    would trade a real case for an imaginary one.
    """
    tail = value.strip()
    if tail.endswith('```'):
        tail = tail[:-3].rstrip()

    decoder = json.JSONDecoder()
    for i, ch in enumerate(tail):
        if ch in '{[':
            try:
                _, end = decoder.raw_decode(tail, i)
            except ValueError:
                continue
            if not tail[end:].strip():
                return True
    return False


# Everything that could be part of JSON between or around values: strings, numbers,
# the literals, separators and whitespace. What is left after removing it is prose.
_JSON_TOKENS = re.compile(
    r'"(?:[^"\\]|\\.)*"|-?\bInfinity\b|\b(?:true|false|null|NaN)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[\s,:]'
)


def _hasWords(text: str) -> bool:
    """True when ``text`` holds prose: a letter is left once anything that could be JSON is removed."""
    return bool(re.search(r'[^\W\d_]', _JSON_TOKENS.sub('', text)))


def _trailingJson(value: str) -> Any:
    """Decode the JSON object or array that ends ``value``, after a sentence.

    The first object or array in the reply must decode and run to the end, and
    words must come before it ("I'll create the files.{...}"). Anything else is
    left to repair: an earlier value (an example, or one of two values the reply
    meant to send, as in 'Rows: [...] and [...]'), or a start that does not decode
    (a value cut off part way, as in 'Rows: [{"name": "Alice"}, {"name": "Bob"}',
    whose inner objects must not be taken for the answer).

    Returns:
        The decoded object or array, or None.
    """
    tail = value.strip()
    closed = tail.endswith('```')
    if closed:
        tail = tail[:-3].rstrip()
    starts = [p for p in (tail.find('{'), tail.find('[')) if p >= 0]
    if not starts:
        return None
    start = min(starts)
    prefix = tail[:start]
    if closed:
        # The closing fence must end a plain block opened right before the value
        # ("Here:\n```\n{...}\n```"). One in another language (```text) holds an
        # example, and one with no opener is not a block at all.
        if prefix.count('```') != 1 or not prefix.rstrip().endswith('```'):
            return None
        prefix = prefix.rstrip()[:-3]
    elif '```' in prefix:
        return None  # a block before the value: an example, or a broken reply
    if not _hasWords(prefix):
        return None  # only JSON before it ('true {...}'): two values, not a sentence and one
    try:
        v, end = json.JSONDecoder().raw_decode(tail, start)
    except ValueError:
        return None
    return v if not tail[end:].strip() else None


def _holdsJson(text: str) -> bool:
    """True when ``text`` holds an object or array that decodes: a JSON value, not a stray bracket."""
    decoder = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch in '{[':
            try:
                decoder.raw_decode(text, i)
                return True
            except ValueError:
                continue
    return False


# The start of an object with a key, or of an array: one opening with an object, an
# array or a string, or with a number (exponents included) or literal followed by a
# comma or the end of the line ("[1, 2," or "[1"). JSON, finished or not. Prose
# brackets ("Step [1/3]", {{memory.ref:...}}) do not match.
_JSON_START = re.compile(
    r'\{\s*"|\[\s*[\[{"]|\[\s*(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\s*(?:,|$)', re.MULTILINE
)


def _startsJson(text: str) -> bool:
    """True when ``text`` holds the start of a JSON object or array, even one that never closes."""
    return _JSON_START.search(text) is not None


def _isRemark(text: str, fenced: bool) -> bool:
    """True when ``text``, found after a complete JSON value, is only a closing fence and a remark.

    *fenced* says whether the value opened a fence; only then may a fence close it.

    Anything that could be more JSON is not a remark: a separator or bracket that
    continues the value ('[{"name": "Alice"}], {"name": "Bob"}]'), a second value of
    any kind (an object, a number, true, a quoted string), even with words after it
    ('"Use B instead" Done.'), or a second fenced block. Nor is reasoning that
    opens after the value: it may be reconsidering it. Either way the reply is
    broken, and a repair is safer than keeping part of it. Text with words is a
    remark ('1. Read the stylesheet first.'); text without them may be a second
    value ('42').
    """
    rest = text.strip()
    if fenced and rest.startswith('```'):
        rest = rest[3:].lstrip()
    if not rest:
        return True
    if '<think>' in rest or '```' in rest or rest[0] in ',:' or any(c in rest for c in '{}[]'):
        return False
    if rest[0] == '"':
        return False  # a quoted value, finished or not ('"Use B instead". Done.')
    try:
        value, end = json.JSONDecoder().raw_decode(rest)
    except ValueError:
        pass
    else:
        numbered = isinstance(value, int) and not isinstance(value, bool) and rest[end : end + 1] in ('.', ')')
        if not numbered:
            return False  # a value of its own ('true', '42 rows'), not the "1" of "1. Read"
    if _labelledValue(rest):
        return False  # 'Correction:' then a value: a second value after a label
    return _hasWords(rest)


def _labelledValue(text: str) -> bool:
    """True when a line of *text*, or what follows a label's colon on it, opens with a value.

    'Correction:\\n"B"', 'Use this instead: 42' and 'Correct price: 20 USD.' all
    carry a second value, words after it or not; 'Note: it is fine' does not. A
    quote counts even if it never closes. A list number is prose: '2) Then compile.'
    """
    decoder = json.JSONDecoder()
    for line in text.splitlines():
        parts = [line] + [after for _, _, after in [line.rpartition(':')] if _]
        for part in (p.strip() for p in parts):
            if not part:
                continue
            if part[0] == '"':
                return True
            try:
                value, end = decoder.raw_decode(part)
            except ValueError:
                continue
            numbered = isinstance(value, int) and not isinstance(value, bool) and part[end : end + 1] in ('.', ')')
            if not numbered:
                return True
    return False


def parseJson(value: str) -> Any:
    """
    Parse a string and return a json value.
    """
    try:
        # Trim leading/trailing whitespace
        value = value.strip()

        # Deepseek (and others) emit <think>...</think> blocks before the JSON — remove them first
        # so fence detection below is not confused by content inside the think block.
        value = re.sub(r'<think>.*?</think>', '', value, flags=re.DOTALL).strip()

        # An UNCLOSED block means the model ran out of output budget while still
        # reasoning, so it never reached the JSON at all. The regex above cannot match
        # it, and the generic "Expecting value: line 1 column 1" that follows sends you
        # looking at the schema instead of at modelOutputTokens. Checked after the
        # substitution so a complete block followed by a truncated one is caught too.
        #
        # All three clauses carry weight.
        #
        # re.sub is a single left-to-right pass, so deleting an inner pair can splice a
        # fresh one into the remainder that the pass has already moved past:
        # '<thi<think>x</think>nk>a</think>{...}' leaves '<think>a</think>{...}', which
        # opens with <think> but is not a truncation. The closing-tag test excludes that.
        #
        # A missing </think> is not by itself proof of a budget overflow -- a model can
        # emit its JSON and simply drop the closing tag, e.g. when the tag is consumed as
        # a stop sequence. '<think>reasoning\n{"a": 1}' is that shape, and blaming
        # modelOutputTokens there sends the operator to a setting that will not help.
        # So ask whether a JSON value can actually be DECODED, not merely whether a brace
        # appears -- reasoning that mentions '{title, body}' or 'compare [A, B]' is a
        # truncation like any other, and a character test would wave it through.
        if value.startswith('<think>') and '</think>' not in value and not _holdsCompleteJson(value):
            raise ThinkTruncatedError(
                'model was cut off inside a <think> block and never emitted JSON; '
                'raise modelOutputTokens, or disable reasoning for this call'
            )

        # A model may put a sentence before its fenced block ("Here is my plan:
        # ```json ... ```"). When the reply opens with neither JSON nor a fence, decode
        # the JSON value that follows the first ```json marker. Decoding (rather than
        # searching for the closing fence) keeps backticks inside JSON strings intact.
        # Only the closing fence and a remark may follow it.
        # A reply with a <think> block still open anywhere is left alone: a draft JSON
        # inside unfinished reasoning must never be taken for the answer.
        if not value.startswith(('{', '[', '```')) and '<think>' not in value:
            start = value.find('```json')
            prefix = value[:start]
            if start >= 0 and ('```' in prefix or _holdsJson(prefix) or _startsJson(prefix) or not _hasWords(prefix)):
                pass  # JSON (even unfinished) or another block before this one: a broken reply, left to repair
            elif start >= 0:
                body = value[start + 7 :].lstrip()
                try:
                    v, end = json.JSONDecoder().raw_decode(body)
                except ValueError:
                    pass  # not decodable: fall through to the usual error below
                else:
                    if _isRemark(body[end:], fenced=True):
                        return v
            else:
                # No fence at all: a sentence, then the object itself ("I'll create the
                # files.{"thought": ...}"). Only an object that runs to the end of the
                # reply counts; one in the middle of prose may be an example.
                v = _trailingJson(value)
                if v is not None:
                    return v

        # If the LLM wrapped the response in a ```json fence, strip the opening marker.
        # We only check the beginning of the string so we don't accidentally strip ``` sequences
        # that appear inside JSON string values (e.g. a chartjs fenced code block in an "answer" field).
        fenced = value.startswith('```')
        if value.startswith('```json'):
            value = value[7:].strip()
        elif value.startswith('```'):
            value = value[3:].strip()

        # Strip the closing ``` fence if present at the end of the string.
        if fenced and value.endswith('```'):
            # Only a fence that was opened may close: a bare value followed by a
            # remark and a stray fence is a broken reply, left to repair.
            value = value[:-3].strip()

        # Now, parse the json. A complete value followed by a remark ("{...} Hope
        # that helps!") is the reply plus a remark: keep the value, drop the remark.
        try:
            return json.loads(value)
        except json.JSONDecodeError as e:
            if e.msg != 'Extra data':
                raise
            v, end = json.JSONDecoder().raw_decode(value)
            if not _isRemark(value[end:], fenced):
                raise
            return v

    except Exception as e:
        debug(f'Unable to parse json ${str(e)} ${str(value)}')
        raise


def parsePython(value: str) -> Any:
    """
    Parse a string and return a python code snippet.
    """
    try:
        # Fix it in case the llm gave us a narative
        offset = value.find('```python')
        if offset >= 0:
            value = value[offset + 9 :]
            offset = value.rfind('```')
            if offset >= 0:
                value = value[:offset]

        # Return it
        return value

    except Exception as e:
        debug(f'Unable to parse json {str(e)} {str(value)}')
        raise


def obfuscate_string(s: str) -> str:
    """
    Obfuscate a string by replacing characters with asterisks.

    If the string is shorter than __OBFUSCATE_DISPLAY_BUFFER_SIZE characters, it pads with asterisks to make it __OBFUSCATE_DISPLAY_BUFFER_SIZE characters long.
    If the string is longer than __OBFUSCATE_DISPLAY_BUFFER_SIZE characters, it keeps the first __OBFUSCATE_DISPLAY_BUFFER_SIZE characters and replaces the rest with asterisks.
    """
    if len(s) < __OBFUSCATE_DISPLAY_BUFFER_SIZE:
        return s + '*' * (__OBFUSCATE_DISPLAY_BUFFER_SIZE - len(s))
    return s[:4] + '*' * (len(s) - __OBFUSCATE_DISPLAY_BUFFER_SIZE)
