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
MongoDB Atlas save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check is a format check of the
connection string and the database and collection names. No network call is
made, so this module stays import-light.
"""

import re
from typing import Mapping

from rocketlib import IValidatorBase, warning

MONGODB_SRV_RE = re.compile(r'^mongodb\+srv://[^:]+:[^@]+@[a-zA-Z0-9\-]+\.[a-zA-Z0-9]+\.mongodb\.net/\?.*')
INVALID_DATABASE_CHARS = ('/', '\\', ' ', '"', '$', '*', '<', '>', ':', '|', '?')


def probe_connection(config: Mapping) -> None:
    """
    Validate MongoDB config at save-time with lightweight format checks.

    Checks the host matches the Atlas ``mongodb+srv`` URI shape and that the
    database and collection names respect MongoDB naming restrictions. Reports
    problems with ``warning()`` and never raises: the user is still editing
    the node.

    Args:
        config: The resolved node config (host, database, collection).
    """
    host = (config['host'] or '').strip()
    database = (config['database'] or '').strip()
    collection = (config['collection'] or '').strip()

    if not MONGODB_SRV_RE.match(host):
        warning(
            'Host must be a valid MongoDB SRV URI '
            "(e.g., 'mongodb+srv://user:pass@cluster.abc12.mongodb.net/?retryWrites=true')"
        )
        return

    if not database:
        warning('Database name is required and cannot be empty')
        return
    if any(char in database for char in INVALID_DATABASE_CHARS):
        warning(f'Database name contains invalid characters. Avoid: {", ".join(INVALID_DATABASE_CHARS)}')
        return
    if len(database) > 64:
        warning('Database name must be 64 characters or less')
        return

    if not collection:
        warning('Collection name is required and cannot be empty')
        return
    if collection.startswith('system.'):
        warning("Collection name cannot start with 'system.' (reserved prefix)")
        return
    if '$' in collection:
        warning("Collection name cannot contain '$' character")
        return
    if len(collection) > 120:
        warning('Collection name must be 120 characters or less')
        return


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the format checks."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config and, unless ``syntaxOnly``, check the connection string format.

        Args:
            syntaxOnly (bool): True checks the shape only.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        config = self.config
        if syntaxOnly:
            return
        probe_connection(config)
