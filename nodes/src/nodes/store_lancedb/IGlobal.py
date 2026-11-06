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

# ------------------------------------------------------------------------------
# This class controls the data shared between all threads for the task
# ------------------------------------------------------------------------------
from typing import Any, Dict, List, Tuple

from ai.common.store import StoreGlobalBase
from ai.constants import CONST_TASK_DATA_PATH
from rocketlib import warning

from .lancedb_config import (
    DISTANCES,
    SEARCH_MODES,
    is_object_uri,
    parse_storage_options,
    read_choice,
    read_count,
    resolve_uri,
    validate_table,
)


class IGlobal(StoreGlobalBase):
    serverName: str = 'lancedb'

    def _credentials(self, config: Dict[str, Any]) -> List[Tuple[str, Any]]:
        """Storage options carry the object storage keys; a local directory needs none."""
        if not is_object_uri(config.get('uri') or ''):
            return []
        return [('storageOptions', config.get('storageOptions'))]

    def _open_store(self, logical_type: str, conn_config: Dict[str, Any], bag: Dict[str, Any]):
        """Return the driver's Store, imported lazily so config mode never loads the driver."""
        from .lancedb_store import Store

        return Store(logical_type, conn_config, bag)

    def _sub_key(self) -> str:
        """Return the transform sub-key: uri/table."""
        return f'{self.store.uri}/{self.store.table}'

    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """
        Check the LanceDB settings at save time.

        LanceDB is embedded, so there is no server to reach. This checks what can
        be checked without installing the driver: the uri, the table name, the
        storage options JSON and the numeric settings.
        """
        try:
            resolve_uri(config.get('uri'), CONST_TASK_DATA_PATH, object_only=config.get('mode') == 'object')
            validate_table(config.get('table'))
            read_choice(config, 'distance', DISTANCES, 'cosine')
            read_choice(config, 'searchMode', SEARCH_MODES, 'vector')
            read_count(config, 'indexAfterRows', 50000)
            read_count(config, 'optimizeAfterWrites', 1000)
            if is_object_uri(config.get('uri') or ''):
                parse_storage_options(config.get('storageOptions'))
        except ValueError as e:
            warning(str(e))
