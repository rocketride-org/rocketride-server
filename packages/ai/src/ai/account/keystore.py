import asyncio
import time
from typing import Dict, Optional, Tuple, Any, List
from rocketlib import ILoader

# Default TTL for tokens — tokens not explicitly removed will be evicted
# after this many seconds to prevent unbounded memory growth (F-02 fix).
_TOKEN_TTL_SECONDS = 3600  # 1 hour


class KeyStore:
    """
    KeyStore manages task tokens and their mapping to backend services.

    This class is used only by the ALB and is an in-memory implementation
    with asyncio locking and TTL-based eviction to prevent race conditions
    and memory leaks (F-02).

    NOTE: For true multi-instance deployments (multiple ALBs / replicas)
    this must be replaced by a distributed key-value store such as Redis.
    The asyncio.Lock here only prevents races within a single process.

    This class is responsible for:
    - Reserving unique task tokens
    - Mapping tokens to backend services
    - Enforcing access control based on API keys
    - Evicting tokens that exceed the configured TTL
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None, **kwargs) -> None:
        """
        Initialize the keystore with configuration and optional parameters.

        Args:
            config (Dict[str, Any]): Configuration dictionary for the server.
            **kwargs: Additional keyword arguments for customization.
        """
        # token -> (apikey, name, pool, endpoint, created_at)
        self._token_map: Dict[str, Tuple[str, str, str, str, float]] = {}

        # Asyncio lock — serialises all multi-step read-then-write operations
        # so concurrent coroutines cannot observe partially-updated state (F-02).
        self._lock = asyncio.Lock()

        # Store the configuration
        self.config = config if config is not None else {}

        # TTL for tokens (seconds); 0 disables eviction
        self._ttl = int(self.config.get('tokenTtlSeconds', _TOKEN_TTL_SECONDS))

    # =========================================================================
    # Private helpers
    # =========================================================================

    def _is_expired(self, created_at: float) -> bool:
        """Return True if the token has exceeded its TTL."""
        if self._ttl <= 0:
            return False
        return (time.monotonic() - created_at) > self._ttl

    def _evict_expired(self) -> None:
        """Remove all tokens whose TTL has elapsed. Must be called under self._lock."""
        expired = [tok for tok, entry in self._token_map.items() if self._is_expired(entry[4])]
        for tok in expired:
            del self._token_map[tok]

    # =========================================================================
    # Public interface
    # =========================================================================

    async def assign_node(self, apikey: str, pipeline: str) -> Tuple[str, str]:
        """
        Assign a backend node to handle a task for a given pipeline.

        Args:
            apikey (str): API key making the request.
            pipeline (str): The pipeline identifier for the task.

        Returns:
            Tuple[str, str]: A tuple of (pool name, WebSocket endpoint URI).
        """
        config = ILoader.getPipeStack(pipeline)

        if config['usesGPU']:
            pool_type = 'gpu'
        else:
            pool_type = 'cpu'

        return (pool_type, 'ws://localhost:5566/task/service')

    async def map_to_node(self, apikey: str, token: str) -> Tuple[str, str]:
        """
        Map a token to its assigned backend endpoint.

        Validates the token, ensures it belongs to the given API key, and is active.

        Args:
            apikey (str): API key making the request.
            token (str): The task token to resolve.

        Returns:
            Tuple[str, str]: A tuple of (pool name, WebSocket endpoint URI).

        Raises:
            ValueError: If token is missing, expired, not active, or mismatched API key.
        """
        async with self._lock:
            self._evict_expired()

            if token not in self._token_map:
                raise ValueError(f'Token "{token}" is not valid.')

            map_apikey, _, map_pool, map_endpoint, _ = self._token_map[token]

            if not map_pool or not map_endpoint:
                raise ValueError(f'Token "{token}" is reserved but not yet active.')

            if apikey != map_apikey:
                raise ValueError(f'Token "{token}" is not valid.')

            return (map_pool, map_endpoint)

    async def reserve_token(self, apikey: str, token: str, name: str) -> None:
        """
        Reserve a token before a task is started.

        Args:
            token (str): A globally unique identifier for the task.
            apikey (str): API key reserving the token.
            name (str): Human-readable task name.

        Raises:
            ValueError: If the token is already in use (and not expired).
        """
        async with self._lock:
            self._evict_expired()

            if token in self._token_map:
                raise ValueError(f'Token "{token}" is already in use. Please choose a different token.')

            self._token_map[token] = (apikey, name, '', '', time.monotonic())

    async def add_token(self, apikey: str, token: str, task_name: str, pool: str, endpoint: str) -> None:
        """
        Add or update a token with backend routing information.

        Args:
            token (str): The task token.
            apikey (str): API key that owns the token.
            task_name (str): Human-readable task name.
            pool (str): Pool name or backend group.
            endpoint (str): WebSocket URI for the backend service.
        """
        async with self._lock:
            existing = self._token_map.get(token)
            created_at = existing[4] if existing else time.monotonic()
            self._token_map[token] = (apikey, task_name, pool, endpoint, created_at)

    async def remove_token(self, apikey: str, token: str) -> None:
        """
        Remove a token from the internal map.

        Args:
            token (str): The token to remove.

        Raises:
            ValueError: If the token is owned by a different API key.
        """
        async with self._lock:
            if token not in self._token_map:
                return

            map_apikey, *_ = self._token_map[token]

            if apikey != map_apikey:
                raise ValueError(f'Token "{token}" is not valid.')

            del self._token_map[token]

    async def get_tokens(self, apikey: str) -> List[str]:
        """
        Get a list of all active (non-expired) tokens for a given API key.

        Args:
            apikey (str): The API key to lookup.

        Returns:
            List[str]: A list of active task tokens.
        """
        async with self._lock:
            self._evict_expired()
            return [
                token
                for token, (map_apikey, _, _, _, _) in self._token_map.items()
                if map_apikey == apikey
            ]
