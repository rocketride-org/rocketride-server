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


def _extract_wave_json(value: str) -> Any | None:
    """Extract the valid wave-planning JSON object from a string with extra data.

    Some models emit a stray JSON blob (e.g. just the tool args) before the
    real response.  This scans for top-level JSON objects using the decoder
    and returns the first one containing a wave-planning key.
    """
    decoder = json.JSONDecoder()
    pos = 0
    candidates = []
    while pos < len(value):
        # Skip whitespace / newlines between objects
        while pos < len(value) and value[pos] in ' \t\r\n':
            pos += 1
        if pos >= len(value):
            break
        try:
            obj, end = decoder.raw_decode(value, pos)
            if isinstance(obj, dict):
                # Prefer the object with wave-planning keys
                if 'thought' in obj or 'done' in obj or 'tool_calls' in obj:
                    return obj
                candidates.append(obj)
            pos = end
        except json.JSONDecodeError:
            pos += 1

    # Fallback: return last candidate if no wave keys found
    return candidates[-1] if candidates else None


def _repair_json(value: str) -> str:
    """Attempt to fix unbalanced braces/brackets in LLM-generated JSON.

    Walks the string respecting JSON string literals (so braces inside
    strings are not counted) and appends missing closing characters.
    """
    open_stack: list[str] = []
    in_string = False
    escape = False
    match = {'{': '}', '[': ']'}

    for ch in value:
        if escape:
            escape = False
            continue
        if ch == '\\' and in_string:
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch in match:
            open_stack.append(match[ch])
        elif ch in ('}', ']') and open_stack and open_stack[-1] == ch:
            open_stack.pop()

    if open_stack:
        value += ''.join(reversed(open_stack))

    return value


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

        # Attempt to repair unbalanced braces/brackets — common with smaller
        # local models that drop trailing closing characters.
        value = _repair_json(value)

        # Now, parse the json
        try:
            return json.loads(value)
        except json.JSONDecodeError as e:
            # "Extra data" — multiple JSON objects concatenated. Some models emit
            # a stray partial object before the real response. Try to find the
            # object that contains wave-planning keys (thought/done/tool_calls).
            if 'Extra data' in str(e):
                v = _extract_wave_json(value)
                if v is not None:
                    return v
            raise

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
