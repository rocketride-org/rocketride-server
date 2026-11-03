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

from typing import Any, Dict
from rocketlib import IGlobalBase, OPEN_MODE, warning

# Keys the result object holds for something other than a lane: the node writes
# result_types, name, path and metadata; the data channel adds objectId, and
# error when the object failed; the webhook adds status. A lane's results are a
# list under its key, so a lane mapped to one of these would crash on append or
# be overwritten (#2438).
RESERVED_RESULT_KEYS = ('result_types', 'name', 'path', 'metadata', 'objectId', 'error', 'status')


def _configuredKeys(config: Dict[str, Any]) -> tuple[str | None, Dict[str, str]]:
    """Read the result keys a response node is configured with.

    Args:
        config: The node's connConfig.

    Returns:
        The top-level ``laneName`` (None when not set), and the ``lanes`` mapping
        of lane type to result key, keeping only the entries that name both.
    """
    lanes = {}
    # The lanes specifier (obsolete)
    for laneInfo in config.get('lanes') or []:
        laneId = laneInfo.get('laneId', None)
        laneName = laneInfo.get('laneName', None)
        if laneId and laneName:
            lanes[laneId] = laneName
    return config.get('laneName'), lanes


def _reservedKeyError(config: Dict[str, Any]) -> str | None:
    """Explain which configured result keys are reserved, if any.

    Args:
        config: The node's connConfig.

    Returns:
        The message naming each reserved key the config uses, or None when it uses none.
    """
    laneName, lanes = _configuredKeys(config)
    reserved = sorted({key for key in (laneName, *lanes.values()) if key in RESERVED_RESULT_KEYS})
    if not reserved:
        return None
    return (
        f'Result key {", ".join(repr(key) for key in reserved)} is reserved: the result already holds '
        f'{", ".join(RESERVED_RESULT_KEYS)}. Choose another key.'
    )


class IGlobal(IGlobalBase):
    """Read the result keys the lanes are returned under."""

    lanes: Dict[str, str] = {}

    def validateConfig(self) -> None:
        """Warn when a lane is mapped to a result key the result object already uses."""
        message = _reservedKeyError(self.glb.connConfig)
        if message:
            warning(message)

    def beginGlobal(self):
        """Read the result keys; refuse to run with a reserved one.

        Raises:
            ValueError: A lane is mapped to a key the result object already uses.
        """
        config = self.glb.connConfig
        message = _reservedKeyError(config)
        # The config dialog opens the node too: there validateConfig reports it
        if message and self.IEndpoint.endpoint.openMode != OPEN_MODE.CONFIG:
            raise ValueError(message)

        # This will create a local copy
        self.laneName, self.lanes = _configuredKeys(config)
