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
# This class controls the data shared between all threads for the task.
#
# Sits on the shared store base like store_postgres, differing only in how it
# connects: there are no host/user/password fields; the task engine delivers
# the authorized DSN for this node's scope / target. The base supplies the
# lifecycle (open the store from the resolved config, resolve the two tool
# switches) and, through StoreInstanceBase, the agent tools.
#
# The table is the team's managed database, so the whole tool surface is
# opt-in through the expose_tools setting (off by default), and the write tools
# (upsert, delete, soft_delete, restore) also need the allow_write setting (off
# by default). The data lanes are always available.
# ------------------------------------------------------------------------------
from typing import Any, Dict, Mapping

from ai.common.store import StoreGlobalBase


class IGlobal(StoreGlobalBase):
    serverName: str = 'rrvector'

    # Read by VectorStoreToolMixin when the engine lists or dispatches tools.
    # The base resolves the expose_tools setting at start; this class default
    # keeps the tool surface off when nothing is configured, because objdir
    # and get together return the whole table of the team's managed database
    # to any caller of the pipeline's tool path.
    expose_tools: bool = False

    # Read by VectorStoreToolMixin before a write tool runs. The base resolves
    # the allow_write setting at start; this class default keeps writes off
    # when nothing is configured.
    allow_write: bool = False

    def _open_store(self, logical_type: str, config: Mapping, bag: Dict[str, Any]):
        """Return the driver's Store, imported lazily so the validator path never loads the driver."""
        from .rocketride_vector import Store

        return Store(logical_type, config, bag)
