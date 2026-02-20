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


def parseJson(value: str) -> Any:
    """
    Parse a string and return a json value.
    """
    # Sometimes the llm messes up and puts hard CR/LF sequences into the json strings. Don't allow that to happen
    # because our parser can't parse it - it's illegal JSON

    try:
        # Strip it
        value = value.strip()

        # Replace hard CR to nothing
        value = value.replace('\r', '')

        # Replace hard LF into nothing
        value = value.replace('\n', '')

        # Replace hard TAB into space
        value = value.replace('\t', ' ')

        # Now, see if the llm delimited with the ```json and ```
        offset = value.find('```json')
        if offset >= 0:
            # It did, so remove them
            value = value[offset + 7 :].strip()

            # Find the ending ```
            offset = value.rfind('```')
            if offset >= 0:
                # Remove it
                value = value[:offset].strip()

        # Now, see if the llm delimited with just ``` and ```
        offset = value.find('```')
        if offset >= 0:
            # It did, so remove them
            value = value[offset + 3 :].strip()

            # Find the ending ```
            offset = value.rfind('```')
            if offset >= 0:
                # Remove it
                value = value[:offset].strip()

        # Deepseek (at least it) started to return thinking steps.
        # Those steps are at the beginning of the string, and are between
        # `<think>` and `</think>`, s, remove them
        value = re.sub(r'<think>.*?</think>', '', value, flags=re.DOTALL).strip()

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
