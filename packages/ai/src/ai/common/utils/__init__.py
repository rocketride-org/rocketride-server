"""
Small shared utility modules.

Public surface:
- ``safe_str`` — convert any value to a string without raising.
- ``normalize_tool_input``, ``validate_tool_input_schema``, and the
  ``require_*`` / ``optional_*`` / ``require_dict`` validators — strict
  parsing of LLM-supplied tool arguments.
- ``parse_bool``, ``config_int`` — loose parsing of human-edited node
  configuration values.
- ``normalize_bound_tools``, ``langchain_messages_to_transcript`` —
  helpers for LangChain-based agent drivers.

Implementations live in submodules (``string_utils``, ``tool_args``,
``config_utils``, ``agent_tools``); this package re-exports them so the
canonical import path is ``from ai.common.utils import <name>``.
"""

from .agent_tools import langchain_messages_to_transcript, normalize_bound_tools
from .config_utils import config_int, parse_bool
from .string_utils import safe_str
from .tool_args import (
    normalize_tool_input,
    optional_bool,
    optional_int,
    optional_str,
    require_bool,
    require_dict,
    require_int,
    require_str,
    validate_tool_input_schema,
)

__all__ = [
    'config_int',
    'langchain_messages_to_transcript',
    'normalize_bound_tools',
    'normalize_tool_input',
    'optional_bool',
    'optional_int',
    'optional_str',
    'parse_bool',
    'require_bool',
    'require_dict',
    'require_int',
    'require_str',
    'safe_str',
    'validate_tool_input_schema',
]
