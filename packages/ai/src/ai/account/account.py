import os
import secrets
import httpx
import json
import hashlib
from dataclasses import dataclass, field
from typing import Optional, Union, Dict, Any
from rocketlib import debug


@dataclass
class AccountInfo:
    # Actual account id
    clientid: str = ''

    # The validated API key
    apikey: str = ''

    # Credentials actually use to authenticate
    auth: str = ''

    # Account balance information
    token_balance: int = 0
    ms_balance: int = 0

    # Permissions allowed for this account/apikey
    permissions: list[str] = field(default_factory=list)

    # Plans the account subscribes to
    plans: list[str] = field(default_factory=list)


class Account:
    """
    Account is responsible for retrieving account control information.

    It uses the `LS_APIKEY` environment variable to determine the endpoint. If the
    environment variable is not set, the accounting call becomes a no-op. This allows
    flexible integration depending on deployment configuration.

    Example environment variable:
        LS_APIKEY=http://license.example.com/validate

    Usage:
        account = Account()
        is_valid = await account.validate_apikey("abc123")
    """

    def __init__(self) -> None:
        """
        Initialize the account validator with configuration and optional parameters.
        """
        # Retrieve the API key validation endpoint from the LS_APIKEY environment variable.
        self._endpoint_account: Optional[str] = os.environ.get('LS_APIKEY')

        # The seed is used to create tokens. A unique random seed is generated
        # per process by default to prevent token prediction. Override via the
        # ROCKETRIDE_TOKEN_SEED env var if tokens must be stable across restarts.
        #
        # NOTE: Changing the seed invalidates all previously issued tokens.
        self._seed = os.environ.get('ROCKETRIDE_TOKEN_SEED') or secrets.token_hex(32)

    def generate_token(self, content: Dict[str, Any], prefix: str = ''):
        """
        Extract the token from the request content.

        Args:
            content (Dict[str, Any]): The request content.

        Returns:
            str: The extracted token or an empty string if not found.
        """
        # Convert the dictionary to a string
        hash_string = f'{self._seed}.{json.dumps(content)}'.encode('utf-8')

        # Hash it and return
        token = hashlib.sha256(hash_string).hexdigest()

        # Return it
        return f'{prefix}{token}'

    async def authenticate(self, authorization: str) -> Union[AccountInfo | None]:
        """
        Validate an API key by sending it to a licensing server.

        If the LS_APIKEY environment variable is not configured, this method defaults
        to allowing all API keys. Otherwise, it sends the API key to the external
        server and expects a JSON response with an `isAuthorized` field.

        Args:
            apikey (str): The API key to validate.

        Returns:
            bool: True if the API key is authorized or validation is disabled;
                  False if the key is invalid or validation fails.
        """
        # If no validation endpoint is defined, skip validation
        if not self._endpoint_account:
            # Setup the default account info
            account_info = AccountInfo(
                clientid='MYCLIENT',
                apikey='MYAPIKEY',
                auth=authorization,
                token_balance=1000,
                ms_balance=60 * 1000,
                permissions=['*'],
                # TODO: Make request to rocketlib-users service to get account plan with api_key
                # Should be done in 3.2 when feature is supported.
                plans=['free'],
            )

            # And return it
            return account_info

        try:
            # Construct request payload
            payload = {'authorization': authorization}

            # Perform asynchronous POST request to validation endpoint
            async with httpx.AsyncClient() as client:
                response = await client.post(self._endpoint_account, json=payload)

            # Raise an exception if the request failed with HTTP error
            response.raise_for_status()

            # Parse JSON response from validation server
            data = response.json()

            # Return True if explicitly authorized, False otherwise
            if not data.get('isAuthorized', False):
                debug('Invalid API key validation')

            # Setup the account info
            plan = data.get('plan', 'free')
            account_info = AccountInfo(
                clientid=data.get('clientid', ''),
                apikey=data.get('apikey', ''),
                auth=authorization,
                token_balance=data.get('token_balance', 0),
                ms_balance=data.get('ms_balance', 0),
                permissions=data.get('permissions', ['*']),
                plans=[plan] if plan else ['free'],
            )

            # And return it
            return account_info

        except httpx.RequestError as e:
            # Network-related error (connection error, timeout, etc.)
            debug(f'HTTP request error during API key validation: {e}')
            return False

        except httpx.HTTPStatusError as e:
            # Non-2xx response from server
            debug(f'HTTP status error during API key validation: {e}')
            return False

        except Exception as e:
            # Any other unexpected exception
            debug(f'Unexpected error during API key validation: {e}')
            return False
