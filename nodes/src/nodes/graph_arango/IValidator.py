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
ArangoDB save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check is a trivial read query
against the configured server so a wrong password, unreachable host or bad
database name is reported while the user is still editing the node. The
python-arango client is imported inside the probe so this module stays
import-light.
"""

import os
from typing import Any, Mapping

from rocketlib import IValidatorBase, warning


def open_database(client: Any, config: Mapping, *, verify: bool = False) -> Any:
    """Open a database handle, honouring the ``auth_method`` selector.

    ``'token'`` selects JWT user-token auth, anything else (the default
    ``'userpass'``) username/password. ``verify=True`` pings the server and
    authenticates, raising ``ServerConnectionError`` on failure.

    Args:
        client: An ``arango.ArangoClient``.
        config: The resolved node config: the active authentication branch is flat.
        verify: Ping and authenticate now.

    Returns:
        The python-arango database handle.
    """
    database = config['database'].strip()
    if config['auth_method'] == 'token':
        return client.db(database, user_token=config['token'], verify=verify)
    return client.db(database, username=config['user'].strip(), password=config['password'] or '', verify=verify)


def probe_connection(config: Mapping) -> None:
    """Connect and run ``RETURN 1``; report problems with ``warning()`` and never raise.

    Args:
        config: The resolved node config (endpoint, database, the active auth branch).
    """
    endpoint = config['endpoint'].strip()
    client = None
    try:
        from depends import depends  # type: ignore

        depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

        from arango import ArangoClient  # type: ignore
        from arango.exceptions import ArangoError, ServerConnectionError  # type: ignore

        try:
            client = ArangoClient(hosts=endpoint)
            db = open_database(client, config, verify=True)
            db.aql.execute('RETURN 1')
        except ServerConnectionError as e:
            warning(f'Could not connect to ArangoDB at {endpoint}: {e}')
        except ArangoError as e:
            warning(str(e))
    except Exception as e:
        warning(str(e))
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the connectivity probe."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config and, unless ``syntaxOnly``, probe the server.

        Args:
            syntaxOnly (bool): True checks the shape only; no network.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        config = self.config
        if syntaxOnly:
            return
        probe_connection(config)
