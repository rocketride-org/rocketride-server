"""Slack SDK exception classes used by tool_slack node tests."""


class SlackClientError(Exception):
    """Mirror of slack_sdk.errors.SlackClientError."""


class SlackApiError(SlackClientError):
    """Mirror of slack_sdk.errors.SlackApiError: carries the API response."""

    def __init__(self, message, response):
        super().__init__(f'{message}\nThe server responded with: {response}')
        self.response = response
