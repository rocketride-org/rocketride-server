# Shared in-memory store for opensearchpy mock.
from typing import Any, Dict, List

_store: Dict[str, List[Dict[str, Any]]] = {}
_indices: Dict[str, Dict[str, Any]] = {}
