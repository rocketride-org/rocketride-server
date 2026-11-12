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
LlamaParse save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``: the API key is required, the mode selector typed),
and the semantic check reads the advanced JSON block, which the schema can only
see as text.
"""

import json

from rocketlib import IValidatorBase, warning


def advanced_config_problems(text: str) -> list:
    """
    Report what is wrong with an advanced configuration block.

    Args:
        text: The JSON text of the block.

    Returns:
        list: Human-readable problems; empty when the block is usable.
    """
    # A blank block is an empty object at run time, so it is no problem here
    if not text or not text.strip():
        return []
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        return [f'Advanced configuration contains invalid JSON: {e}']
    if not isinstance(parsed, dict):
        return ['Advanced configuration must be a JSON object.']
    # Every other key is passed to the LlamaParse constructor unchanged; only
    # api_key is dropped, since the API key field owns it
    if 'api_key' in parsed:
        return ['Advanced configuration must not set api_key; it is ignored. Use the API key field.']
    return []


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the advanced JSON block."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config and, unless ``syntaxOnly``, the advanced block.

        Args:
            syntaxOnly (bool): True checks the shape only.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        config = self.config
        if syntaxOnly or config.configMode != 'advanced':
            return
        for problem in advanced_config_problems(config.advanced_config):
            warning(f'LlamaParse: {problem}')
