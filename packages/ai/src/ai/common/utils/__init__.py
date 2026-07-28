"""
Small shared utility modules.

Public surface:
- ``safe_str`` — convert any value to a string without raising.
- ``normalize_tool_input``, ``validate_tool_input_schema``, and the
  ``require_*`` / ``optional_*`` / ``require_dict`` / ``int_arg`` validators
  — strict parsing of LLM-supplied tool arguments.
- ``parse_bool``, ``config_int`` — loose parsing of human-edited node
  configuration values.
- ``normalize_bound_tools``, ``langchain_messages_to_transcript`` —
  helpers for LangChain-based agent drivers.
- ``decode_data_url`` — decode an uploaded ``data-url`` value to (bytes, mime).
- ``guess_filename`` — derive a typed ``upload.<ext>`` filename from a buffer
  via the optional ``filetype`` package (lazy; node-provided dependency).
- ``pick_torch_device``, ``pick_torch_dtype``, ``resolve_pipeline_device`` —
  select a Torch device/dtype for local-inference nodes.
- ``post_with_retry`` / ``get_with_retry`` / ``request_with_retry`` — HTTP with
  retry/backoff; the last covers PATCH / DELETE / PUT.
- ``colorize_depth``, ``decode_ndarray``, ``encode_ndarray``, ``image_to_bytes``
  — image/ndarray (de)serialization helpers.
- ``validate_public_url`` — reject non-public/SSRF-prone URLs.

Implementations live in submodules (``string_utils``, ``tool_args``,
``config_utils``, ``agent_tools``, ``file_utils``, ``cuda_utils``,
``http_retry``, ``image_utils``, ``url_utils``); this package re-exports them so
the canonical import path is ``from ai.common.utils import <name>``.
"""

from .agent_tools import langchain_messages_to_transcript, normalize_bound_tools
from .config_utils import config_int, parse_bool
from .file_utils import decode_data_url, guess_filename
from .cuda_utils import pick_torch_device, pick_torch_dtype, resolve_pipeline_device
from .http_retry import get_with_retry, post_with_retry, request_with_retry
from .image_utils import colorize_depth, decode_ndarray, encode_ndarray, image_to_bytes
from .string_utils import safe_str
from .tool_args import (
    int_arg,
    normalize_tool_input,
    optional_bool,
    optional_int,
    optional_str,
    optional_str_list,
    require_bool,
    require_dict,
    require_int,
    require_str,
    require_str_list,
    validate_tool_input_schema,
)
from .url_utils import validate_public_url

__all__ = [
    'colorize_depth',
    'config_int',
    'decode_data_url',
    'guess_filename',
    'get_with_retry',
    'int_arg',
    'decode_ndarray',
    'encode_ndarray',
    'image_to_bytes',
    'langchain_messages_to_transcript',
    'normalize_bound_tools',
    'normalize_tool_input',
    'post_with_retry',
    'optional_bool',
    'optional_int',
    'optional_str',
    'optional_str_list',
    'parse_bool',
    'pick_torch_device',
    'pick_torch_dtype',
    'require_bool',
    'require_dict',
    'require_int',
    'request_with_retry',
    'require_str',
    'require_str_list',
    'resolve_pipeline_device',
    'safe_str',
    'validate_public_url',
    'validate_tool_input_schema',
]
