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

"""Prometheus metrics definitions for RocketRide Server.

Defines all Prometheus counters, histograms, and gauges used across the
engine — pipeline execution, LLM usage, vector-DB operations, and HTTP
request instrumentation.
"""

from prometheus_client import Counter, Gauge, Histogram, CollectorRegistry, generate_latest, CONTENT_TYPE_LATEST, make_asgi_app

__all__ = [
    'PIPELINE_EXECUTIONS',
    'PIPELINE_DURATION',
    'LLM_REQUESTS',
    'LLM_TOKENS',
    'LLM_REQUEST_DURATION',
    'VECTORDB_OPERATIONS',
    'ACTIVE_TASKS',
    'HTTP_REQUESTS',
    'HTTP_REQUEST_DURATION',
    'REGISTRY',
    'get_metrics_app',
    'generate_metrics',
]

# ---------------------------------------------------------------------------
# Registry — use the default global registry so instrumentation libraries
# (e.g. opentelemetry-exporter-prometheus) can merge seamlessly.
# ---------------------------------------------------------------------------
REGISTRY = CollectorRegistry()

# ---------------------------------------------------------------------------
# Pipeline metrics
# ---------------------------------------------------------------------------
PIPELINE_EXECUTIONS = Counter(
    'rocketride_pipeline_executions_total',
    'Total number of pipeline executions',
    ['pipeline_name', 'status'],
    registry=REGISTRY,
)

PIPELINE_DURATION = Histogram(
    'rocketride_pipeline_duration_seconds',
    'Duration of pipeline executions in seconds',
    ['pipeline_name'],
    registry=REGISTRY,
)

# ---------------------------------------------------------------------------
# LLM metrics
# ---------------------------------------------------------------------------
LLM_REQUESTS = Counter(
    'rocketride_llm_requests_total',
    'Total number of LLM requests',
    ['provider', 'model', 'status'],
    registry=REGISTRY,
)

LLM_TOKENS = Counter(
    'rocketride_llm_tokens_total',
    'Total number of LLM tokens consumed',
    ['provider', 'model', 'token_type'],
    registry=REGISTRY,
)

LLM_REQUEST_DURATION = Histogram(
    'rocketride_llm_request_duration_seconds',
    'Duration of LLM requests in seconds',
    ['provider', 'model'],
    registry=REGISTRY,
)

# ---------------------------------------------------------------------------
# Vector DB metrics
# ---------------------------------------------------------------------------
VECTORDB_OPERATIONS = Counter(
    'rocketride_vectordb_operations_total',
    'Total number of vector DB operations',
    ['provider', 'operation'],
    registry=REGISTRY,
)

# ---------------------------------------------------------------------------
# Task metrics
# ---------------------------------------------------------------------------
ACTIVE_TASKS = Gauge(
    'rocketride_active_tasks',
    'Number of currently running tasks',
    registry=REGISTRY,
)

# ---------------------------------------------------------------------------
# HTTP metrics
# ---------------------------------------------------------------------------
HTTP_REQUESTS = Counter(
    'rocketride_http_requests_total',
    'Total number of HTTP requests',
    ['method', 'endpoint', 'status_code'],
    registry=REGISTRY,
)

HTTP_REQUEST_DURATION = Histogram(
    'rocketride_http_request_duration_seconds',
    'Duration of HTTP requests in seconds',
    ['method', 'endpoint'],
    registry=REGISTRY,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def generate_metrics() -> bytes:
    """Return the current metrics in Prometheus text exposition format."""
    return generate_latest(REGISTRY)


def get_metrics_content_type() -> str:
    """Return the MIME type for Prometheus text exposition format."""
    return CONTENT_TYPE_LATEST


def get_metrics_app():
    """Return an ASGI app that serves the /metrics endpoint.

    Suitable for mounting into a FastAPI / Starlette application:

        app.mount('/metrics', get_metrics_app())
    """
    return make_asgi_app(registry=REGISTRY)
