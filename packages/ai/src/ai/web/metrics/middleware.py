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

"""HTTP metrics middleware for RocketRide Server.

Automatically records Prometheus counters/histograms and OpenTelemetry
span attributes for every inbound HTTP request.

Usage — add *after* the auth middleware so the route path is resolved::

    from ai.web.metrics.middleware import MetricsMiddleware

    app.add_middleware(MetricsMiddleware)
"""

import time

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from .prometheus_metrics import HTTP_REQUESTS, HTTP_REQUEST_DURATION
from .tracing import get_tracer

__all__ = ['MetricsMiddleware']


class MetricsMiddleware(BaseHTTPMiddleware):
    """Record HTTP request count, duration, and status via Prometheus and OpenTelemetry."""

    async def dispatch(self, request: Request, call_next):
        method = request.method
        path = request.url.path
        tracer = get_tracer('rocketride.http')

        start = time.perf_counter()
        status_code = 500  # default in case of unhandled exception

        with tracer.start_as_current_span(
            f'{method} {path}',
            attributes={
                'http.method': method,
                'http.url': str(request.url),
                'http.route': path,
            },
        ) as span:
            try:
                response = await call_next(request)
                status_code = response.status_code
                return response
            except Exception:
                status_code = 500
                raise
            finally:
                duration = time.perf_counter() - start
                HTTP_REQUESTS.labels(method=method, endpoint=path, status_code=str(status_code)).inc()
                HTTP_REQUEST_DURATION.labels(method=method, endpoint=path).observe(duration)
                span.set_attribute('http.status_code', status_code)
