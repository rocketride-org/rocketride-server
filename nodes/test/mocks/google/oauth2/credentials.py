# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Mock google.oauth2.credentials.Credentials (user OAuth) for tool_gmail."""


class Credentials:
    def __init__(
        self, token=None, refresh_token=None, token_uri=None, client_id=None, client_secret=None, scopes=None, **kwargs
    ):
        self.token = token
        self.refresh_token = refresh_token
        self.scopes = scopes
