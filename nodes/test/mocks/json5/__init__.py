# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""
Mock json5 for node tests.

``ai.common.config`` imports ``json5`` at module load. The engine runtime
bundles json5, but a bare test environment may not have it installed, which
would block importing the real ``ai.common.config.Config``. This mock shadows
json5 with the stdlib ``json`` parser so the real Config class can be imported
during tests. The optimizer suite only triggers the import; it does not parse
JSON5-specific syntax.
"""

import json
from typing import Any


def loads(s: str, **kwargs: Any) -> Any:
    """Parse a JSON document using the stdlib json parser."""
    return json.loads(s)


def dumps(obj: Any, **kwargs: Any) -> str:
    """Serialize an object to JSON using the stdlib json serializer."""
    return json.dumps(obj)


def load(fp: Any, **kwargs: Any) -> Any:
    """Read and parse JSON from a file-like object."""
    return json.load(fp)


def dump(obj: Any, fp: Any, **kwargs: Any) -> None:
    """Serialize an object as JSON to a file-like object."""
    json.dump(obj, fp)
