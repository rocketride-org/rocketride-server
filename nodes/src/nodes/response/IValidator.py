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
Response save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check refuses a result key the
result object already uses. IGlobal shares the same check at start.
"""

from typing import Any, Dict, Mapping, Optional, Tuple

from rocketlib import IValidatorBase, warning

# Keys the result object holds for something other than a lane: the node writes
# result_types, name, path and metadata; the data channel adds objectId, and
# error when the object failed; the webhook adds status. A lane's results are a
# list under its key, so a lane mapped to one of these would crash on append or
# be overwritten (#2438).
RESERVED_RESULT_KEYS = ('result_types', 'name', 'path', 'metadata', 'objectId', 'error', 'status')


def configured_keys(config: Mapping[str, Any]) -> Tuple[Optional[str], Dict[str, str]]:
    """Read the result keys a response node is configured with.

    Args:
        config: The node's resolved config.

    Returns:
        The top-level ``laneName`` (None when not set), and the ``lanes`` mapping
        of lane type to result key, keeping only the entries that name both.
    """
    lanes = {}
    # The lanes specifier of the generic service
    for laneInfo in config.get('lanes') or []:
        laneId = laneInfo.get('laneId', None)
        laneName = laneInfo.get('laneName', None)
        if laneId and laneName:
            lanes[laneId] = laneName
    return config.get('laneName'), lanes


def reserved_key_error(config: Mapping[str, Any]) -> Optional[str]:
    """Explain which configured result keys are reserved, if any.

    Args:
        config: The node's resolved config.

    Returns:
        The message naming each reserved key the config uses, or None when it uses none.
    """
    laneName, lanes = configured_keys(config)
    reserved = sorted({key for key in (laneName, *lanes.values()) if key in RESERVED_RESULT_KEYS})
    if not reserved:
        return None
    return (
        f'Result key {", ".join(repr(key) for key in reserved)} is reserved: the result already holds '
        f'{", ".join(RESERVED_RESULT_KEYS)}. Choose another key.'
    )


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the reserved-key check."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """Warn when a lane is mapped to a result key the result object already uses.

        Args:
            syntaxOnly (bool): True checks the shape only.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        config = self.config
        if syntaxOnly:
            return
        if message := reserved_key_error(config):
            warning(message)
