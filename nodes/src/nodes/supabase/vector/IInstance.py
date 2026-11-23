# =============================================================================
# RocketRide Engine
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

"""Supabase Vector: instance (pipeline lanes and agent tools).

store_postgres's IInstance, so the lanes (``documents`` in, ``questions`` in
with ``documents`` / ``answers`` / ``questions`` out) and the vector store
tools (``search``, ``get``, ``objdir``, ``stats``, ``list_documents``,
``upsert``, ``delete``, ``soft_delete``, ``restore``) are
``StoreInstanceBase``'s / ``VectorStoreToolMixin``'s, unchanged.

The access level: reading at ``read``, adding and replacing documents
(``upsert``) at ``write``, and ``delete``, ``soft_delete``, ``restore`` at
``admin``. ``upsert`` of a batch holding chunk 0 deletes the document's stored
chunks first (store_postgres), so ``write`` can overwrite any stored
document; ``admin`` is needed only for the three tools above. A tool above the
node's level is not offered to the agent (``_collect_tool_methods``), and a
direct call is refused with a message naming the level to set. The mixin's
``allow_write`` switch follows ``write`` (IGlobal); the admin tools are this
class's addition, without changing store_postgres or the mixin. Documents
arriving on the ``documents`` lane are always stored: that is pipeline
wiring, not an agent call, and no lane goes through these tools.
"""

from __future__ import annotations

import functools
from typing import Any, Callable, Dict, Optional

from nodes.store_postgres.IInstance import IInstance as PostgresStoreInstance

from .. import supabase_client as sc
from .IGlobal import IGlobal

# The mixin's tools that delete, trash or restore documents by ID: admin, as delete is in Auth and Storage.
ADMIN_TOOLS = frozenset({'delete', 'soft_delete', 'restore'})


def _admin_tool(name: str) -> Callable:
    """The mixin's tool ``name``, refused below admin before the mixin runs.

    ``functools.wraps`` copies the mixin's ``__tool_meta__`` (schema and
    description), so the engine sees the same tool; only the gate is added.
    """
    inner = getattr(PostgresStoreInstance, name)

    @functools.wraps(inner)
    def tool(self: 'IInstance', args: Any = None) -> Any:
        refused = self._vectordb_admin_refused(name)
        if refused is not None:
            return refused
        return inner(self, args)

    return tool


class IInstance(PostgresStoreInstance):
    """store_postgres's IInstance with the Supabase access levels on its tools."""

    IGlobal: IGlobal

    delete = _admin_tool('delete')
    soft_delete = _admin_tool('soft_delete')
    restore = _admin_tool('restore')

    def _collect_tool_methods(self) -> Dict[str, Callable]:
        """The mixin's map (no write tools below write), without the admin tools below admin."""
        methods = super()._collect_tool_methods()
        if sc.access_allows(self.IGlobal.access, sc.ADMIN):
            return methods
        return {name: method for name, method in methods.items() if name not in ADMIN_TOOLS}

    def _vectordb_admin_refused(self, tool: str) -> Optional[Dict[str, Any]]:
        """The mixin's failure object naming the admin level, or None when the node is at admin."""
        try:
            sc.require_access(self.IGlobal.access, sc.ADMIN, f'{self._vectordb_server_name()}.{tool}')
        except sc.SupabaseAccessError as e:
            return {'success': False, 'error': str(e)}
        return None

    def _vectordb_write_refused(self, tool: str) -> Dict[str, Any]:
        """Name the access level to set, not store_postgres's allow_write switch (this node has none)."""
        try:
            sc.require_access(self.IGlobal.access, sc.WRITE, f'{self._vectordb_server_name()}.{tool}')
        except sc.SupabaseAccessError as e:
            return {'success': False, 'error': str(e)}
        # allow_write follows the access level (IGlobal.beginGlobal), so this is
        # reached only if something else turned writes off: keep the base message.
        return super()._vectordb_write_refused(tool)
