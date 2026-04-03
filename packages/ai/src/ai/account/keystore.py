from typing import Dict, Optional, Tuple, Any, List
from rocketlib import ILoader


class KeyStore:
    """
    KeyStore manages task tokens and their mapping to backend services.

    This class is used only by the ALB and is an in-memory stub for
    tracking the info. In a true implementation, with multple ALBs
    this must be replace by a true key-value store.

    This class is responsible for:
    - Reserving unique task tokens
    - Mapping tokens to backend services
    - Enforcing access control based on API keys
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None, **kwargs) -> None:
        """
        Initialize the keystore with configuration and optional parameters.

        Args:
            config (Dict[str, Any]): Configuration dictionary for the server.
            **kwargs: Additional keyword arguments for customization.
        """
        # Create the token map
        #   str:0 = apikey
        #   str:1 = name
        #   str:2 = pool
        #   str:3 = endpoint
        self.token_map: Dict[str, Tuple[str, str, str, str]] = {}

        # Store the configuration
        self.config = config if config is not None else {}

    async def assign_node(self, apikey: str, pipeline: str) -> Tuple[str, str]:
        """
        Assign a backend node to handle a task for a given pipeline.

        This can be overridden to implement custom routing strategies.

        Args:
            apikey (str): API key making the request.
            pipeline (str): The pipeline identifier for the task.

        Returns:
            Tuple[str, str]: A tuple of (pool name, WebSocket endpoint URI).
        """
        # Compute the pipeline configuration stack (including metadata like usesGPU)
        config = ILoader.getPipeStack(pipeline)

        # Redirect based on resource requirement
        if config['usesGPU']:
            pool_type = 'gpu'
        else:
            pool_type = 'cpu'

        # Default implementation: route all tasks to localhost GPU node
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
            ValueError: If token is missing, not active, or mismatched API key.
        """
        if token not in self.token_map:
            raise ValueError(f'Token "{token}" is not valid.')

        map_apikey, _, map_pool, map_endpoint = self.token_map[token]

        if not map_pool or not map_endpoint:
            raise ValueError(f'Token "{token}" is not reserved, but not active.')

        if apikey != map_apikey:
            raise ValueError(f'Token "{token}" is not valid.')

        return (map_pool, map_endpoint)

    async def reserve_token(self, apikey: str, token: str, name: str) -> None:
        """
        Reserve a token before a task is started.

        Ensures the token is unique before adding it to the map.

        Args:
            token (str): A globally unique identifier for the task.
            apikey (str): API key reserving the token.

        Raises:
            ValueError: If the token is already in use.
        """
        if token in self.token_map:
            raise ValueError(f'Token "{token}" is already in use. Please choose a different token.')

        self.token_map[token] = (apikey, name, '', '')

    async def add_token(self, apikey: str, token: str, task_name: str, pool: str, endpoint: str) -> None:
        """
        Add or update a token with backend routing information.

        Used to finalize a reserved token or add a new one directly.

        Args:
            token (str): The task token.
            apikey (str): API key that owns the token.
            pool (str): Pool name or backend group.
            endpoint (str): WebSocket URI for the backend service.
        """
        self.token_map[token] = (apikey, task_name, pool, endpoint)

    async def remove_token(self, apikey: str, token: str) -> None:
        """
        Remove a token from the internal map.

        Cleans up the token after a task completes or is canceled.

        Args:
            token (str): The token to remove.
        """
        # Make sure it is in the map
        if token not in self.token_map:
            return

        # Get it
        map_apikey, map_name, map_pool, map_endpoint = self.token_map[token]

        # Make sure it is owned correctly
        if apikey != map_apikey:
            raise ValueError(f'Token "{token}" is not valid.')

        # Remove it
        self.token_map.pop(token)

    async def get_tokens(self, apikey: str) -> List[str]:
        """
        Get a list of all active tokens for a given API key.

        Args:
            apikey (str): The API key to lookup.

        Returns:
            List[str]: A list of active task tokens.
        """
        return [token for token, (map_apikey, _, _, _) in self.token_map.items() if map_apikey == apikey]
