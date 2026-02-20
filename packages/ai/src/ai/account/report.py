import os
import requests
from typing import Dict, Any
from rocketlib import debug


class Reporter:
    """
    Reporter is responsible for sending task metrics to an external reporting service.

    It uses the `LS_REPORT` environment variable to determine the endpoint. If the
    environment variable is not set, the reporting call becomes a no-op. This allows
    flexible integration depending on deployment configuration.

    Example environment variable:
        LS_REPORT=http://license.example.com/report

    Usage:
        reporter = Reporter()
        reporter.report(apikey="abc123", token="task456", metrics={"latency": 120, "status": "complete"})
    """

    def __init__(self) -> None:
        """
        Initialize the reporter with configuration and optional parameters.
        """
        # Create the report endpoint
        self._endpoint_report = os.environ.get('LS_REPORT', None)

    async def report(self, apikey: str, token: str, metrics: Dict[str, Any]) -> None:
        """
        Report task-related metrics to the external license/reporting service.

        If the reporting endpoint is not configured, this method will silently skip reporting.

        Args:
            apikey (str): The API key associated with the task.
            token (str): The unique task token being reported.
            metrics (Dict[str, Any]): A dictionary of metric data (e.g., timing, results).
        """
        # If no reporting endpoint is defined, do nothing
        if not self._endpoint_report:
            return

        try:
            # Construct the JSON payload to be sent
            payload = {'apikey': apikey, 'token': token, 'metrics': metrics}

            # Send the POST request to the report endpoint
            requests.post(self._endpoint_report, json=payload)

        except Exception as e:
            # Log the exception for debugging; fail silently
            debug(e)
