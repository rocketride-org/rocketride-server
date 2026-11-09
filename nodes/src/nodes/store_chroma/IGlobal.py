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
from typing import Any, Dict, List, Mapping, Tuple

from ai.common.store import StoreGlobalBase

from .mode import is_local


class IGlobal(StoreGlobalBase):
    serverName: str = 'chroma'

    def _credentials(self, config: Mapping) -> List[Tuple[str, Any]]:
        """The token goes to a cloud server only, never to a local one."""
        if is_local(config):
            return []
        return [('apikey', config['apikey'])]

    def _open_store(self, logical_type: str, config: Mapping, bag: Dict[str, Any]):
        """Return the driver's Store, imported lazily so the validator path never loads the driver."""
        from .chroma import Store

        return Store(logical_type, config, bag)
