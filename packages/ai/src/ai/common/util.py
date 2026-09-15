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

        # If the LLM wrapped the response in a ```json fence, strip the opening marker.
        # We only check the beginning of the string so we don't accidentally strip ``` sequences
        # that appear inside JSON string values (e.g. a chartjs fenced code block in an "answer" field).
        if value.startswith('```json'):
            value = value[7:].strip()
        elif value.startswith('```'):
            value = value[3:].strip()

        # Strip the closing ``` fence if present at the end of the string.
        if value.endswith('```'):
            value = value[:-3].strip()

        # Now, parse the json
        v = json.loads(value)
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
