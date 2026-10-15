"""Stand-ins for the shared store base classes, for tests that load rocketride_vector without the engine.

``rocketride_vector``'s IGlobal and IInstance sit on ``ai.common.store``'s
``StoreGlobalBase`` / ``StoreInstanceBase`` (#2587). Tests that drive the driver
``Store`` directly, or the node's three hooks, stand the base in with the
attributes the node reads and the hook contract the base defines. One copy
here keeps the next field added to the base from needing three edits.
"""

from __future__ import annotations

import types


def store_base_stubs(document_store_base=None) -> types.ModuleType:
    """Return a stand-in ``ai.common.store`` module.

    ``document_store_base`` is set as ``DocumentStoreBase`` when given; the
    driver tests each bring their own, the node tests need none.
    """

    class StoreGlobalBase:
        serverName: str = ''
        store = None
        # The two tool switches, with the base's defaults: an ordinary store
        # exposes its tools and allows writes; a managed one overrides both.
        expose_tools: bool = True
        allow_write: bool = True

        def _open_store(self, logical_type, conn_config, bag):
            raise NotImplementedError

        def _sub_key(self):
            raise NotImplementedError

        def _probe_connection(self, config):
            raise NotImplementedError

    class StoreInstanceBase:
        pass

    module = types.ModuleType('ai.common.store')
    module.StoreGlobalBase = StoreGlobalBase
    module.StoreInstanceBase = StoreInstanceBase
    if document_store_base is not None:
        module.DocumentStoreBase = document_store_base
    return module
