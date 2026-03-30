# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Prometheus /metrics endpoint for RocketRide Server.

Exposes collected metrics in the Prometheus text exposition format.
Whether the endpoint requires authentication is controlled by the
``ROCKETRIDE_METRICS_PUBLIC`` environment variable (default: ``true``
so Prometheus can scrape without credentials).

Integration point — register this with ``WebServer.add_route``::

    from ai.web.endpoints.metrics_endpoint import metrics_endpoint

    server.add_route('/metrics', metrics_endpoint, ['GET'], public=is_public)
"""

import os

from fastapi.responses import Response

from ai.web.metrics.prometheus_metrics import generate_metrics, get_metrics_content_type

__all__ = ['metrics_endpoint', 'is_metrics_public']


def is_metrics_public() -> bool:
    """Return ``True`` when the /metrics endpoint should be publicly accessible.

    Controlled by ``ROCKETRIDE_METRICS_PUBLIC`` (default ``true``).
    Set to ``false`` to require authentication for scraping.

    Security note: when set to ``true``, the /metrics endpoint is
    unauthenticated.  In production deployments this endpoint should sit
    behind a reverse proxy (e.g. nginx, Envoy) that enforces rate
    limiting and IP allowlisting so that only the Prometheus scraper can
    reach it.  Setting the variable to ``false`` requires the standard
    RocketRide auth token on every scrape request.
    """
    # ROCKETRIDE_METRICS_PUBLIC controls whether the /metrics endpoint is
    # exposed without authentication.  The default (true) is convenient for
    # development but in production you should either set this to false or
    # put the endpoint behind a rate-limiting reverse proxy.
    return os.environ.get('ROCKETRIDE_METRICS_PUBLIC', 'true').lower() in ('true', '1', 'yes')


async def metrics_endpoint() -> Response:
    """Return current Prometheus metrics in text exposition format.

    .. warning::

        In production, this endpoint should be protected by rate limiting
        at the reverse-proxy layer (or by setting ``ROCKETRIDE_METRICS_PUBLIC=false``
        and requiring authentication) to prevent abuse.

    Returns:
        Response: Prometheus-formatted metrics payload.

    Responses:
        200: Metrics returned successfully.
    """
    return Response(
        content=generate_metrics(),
        media_type=get_metrics_content_type(),
    )
