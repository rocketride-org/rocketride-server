"""Mock of slack_sdk.webhook: WebhookClient + WebhookResponse."""


class WebhookResponse:
    """Mirror of slack_sdk.webhook.WebhookResponse."""

    def __init__(self, url='', status_code=200, body='ok', headers=None):
        self.api_url = url
        self.status_code = status_code
        self.body = body
        self.headers = headers or {}


class WebhookClient:
    """Mock Slack incoming-webhook client: every send succeeds."""

    def __init__(self, url, **kwargs):
        """Store the configured webhook URL for parity with the real client."""
        self.url = url

    def send(self, text=None, **kwargs):
        """Mirror WebhookClient.send: always respond 200/'ok'."""
        return WebhookResponse(url=self.url, status_code=200, body='ok')


__all__ = ['WebhookClient', 'WebhookResponse']
