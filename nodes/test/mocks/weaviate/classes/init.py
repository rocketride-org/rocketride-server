"""
Mock Weaviate initialization classes.
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class Timeout:
    """Timeout configuration."""
    init: int = 30
    query: int = 60
    insert: int = 120


@dataclass
class AdditionalConfig:
    """Additional client configuration."""
    timeout: Optional[Timeout] = None


class Auth:
    """Authentication helpers."""
    
    @staticmethod
    def api_key(key: str) -> dict:
        """Create API key authentication."""
        return {"api_key": key}

