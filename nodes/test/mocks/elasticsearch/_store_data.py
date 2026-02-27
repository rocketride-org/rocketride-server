# Shared in-memory store for elasticsearch mock (used by __init__.py and helpers).
from typing import Any, Dict, List

_store: Dict[str, List[Dict[str, Any]]] = {}
_indices: Dict[str, Dict[str, Any]] = {}
