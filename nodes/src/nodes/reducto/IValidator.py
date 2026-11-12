# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Reducto save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic checks are the Python dictionary
syntax of the advanced-mode options and, unless syntax only, a minimal upload
that proves the key. The Reducto client is imported inside the probe so this
module stays import-light.
"""

import ast
import os
from typing import Mapping

from rocketlib import IValidatorBase, warning

from ai.common.config import warn_if_credential_unresolved

ADVANCED_OPTION_FIELDS = ('options', 'advanced_options', 'experimental_options')


def check_option_dicts(config: Mapping) -> None:
    """
    Check that every filled advanced-mode option field is a Python dictionary literal.

    Args:
        config: The resolved node config.

    Raises:
        ValueError: A field is not a dictionary literal; the message names it.
    """
    if not config['parse_mode']:
        return
    for field_name in ADVANCED_OPTION_FIELDS:
        value = (config[field_name] or '').strip()
        if not value:
            continue
        try:
            parsed = ast.literal_eval(value)
        except (ValueError, SyntaxError) as e:
            raise ValueError(f'Reducto {field_name} contains invalid Python dictionary syntax: {e}') from e
        if not isinstance(parsed, dict):
            raise ValueError(f'Reducto {field_name} must be a Python dictionary, got {type(parsed).__name__}')


def probe_connection(config: Mapping) -> None:
    """
    Prove the API key with a minimal in-memory upload (no parsing).

    Reports problems with ``warning()`` and never raises: the user is still
    editing the node.

    Args:
        config: The resolved node config (api_key).
    """
    try:
        from depends import depends  # type: ignore

        depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

        from reducto import Reducto

        reducto = Reducto(api_key=config['api_key'])
        reducto.upload(file=('ping.txt', b'ping'))
    except Exception as e:
        warning(f'Reducto API key validation failed: {e}')


class IValidator(IValidatorBase):
    """Schema check through the resolver, the option syntax, then the key probe."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config: shape, option dictionaries and, unless ``syntaxOnly``, the key.

        Args:
            syntaxOnly (bool): True checks the shape and the option syntax only; no network.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
            ValueError: An advanced-mode option field is not a Python dictionary.
        """
        config = self.config
        check_option_dicts(config)
        if syntaxOnly:
            return
        # An unfilled reference is reported as such; the probe must not send the placeholder as the key
        if warn_if_credential_unresolved(self.glb.logicalType, 'api_key', config['api_key']):
            return
        probe_connection(config)
