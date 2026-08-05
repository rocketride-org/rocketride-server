# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Mock google.oauth2.service_account.Credentials for tool_gmail."""


class Credentials:
    def __init__(self, info=None, scopes=None, subject=None):
        self.info = info
        self.scopes = scopes
        self.subject = subject

    @classmethod
    def from_service_account_info(cls, info, scopes=None, **kwargs):
        return cls(info=info, scopes=scopes)

    def with_subject(self, subject):
        return Credentials(info=self.info, scopes=self.scopes, subject=subject)
