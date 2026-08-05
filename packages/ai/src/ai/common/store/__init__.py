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

"""Base classes and driver interface for vector store nodes.

``store_qdrant`` is the reference the IGlobal/IInstance abstraction was
extracted from; the other ``store_*`` drivers still carry their own copies and
migrate onto these bases one at a time. The store interface itself
(``DocumentStoreBase``, ``getStore``) and the agent-tool mixin
(``VectorStoreToolMixin``) live in ``document_store`` and are re-exported here so
``from ai.common.store import ...`` keeps working after the module became a
package.
"""

from .document_store import (
    DocumentStoreBase,
    VectorStoreToolMixin,
    getStore,
)
from .store_global_base import StoreGlobalBase
from .store_instance_base import StoreInstanceBase

__all__ = [
    'DocumentStoreBase',
    'StoreGlobalBase',
    'StoreInstanceBase',
    'VectorStoreToolMixin',
    'getStore',
]
