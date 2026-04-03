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

"""Tests for the RocketRide observability stack.

Covers:
  - Prometheus metric definitions (counters, histograms, gauges)
  - Histogram observations
  - /metrics endpoint Prometheus text format
  - OpenTelemetry tracer initialisation
  - MetricsMiddleware HTTP instrumentation
"""

import importlib
import importlib.util
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Load modules directly by file path to avoid triggering the heavy
# ai/__init__.py and ai/web/__init__.py import chains which require
# rocketlib, depends, and other runtime-only dependencies.
# ---------------------------------------------------------------------------
_WEB_METRICS_DIR = Path(__file__).resolve().parent.parent.parent / 'packages' / 'ai' / 'src' / 'ai' / 'web' / 'metrics'
_WEB_ENDPOINTS_DIR = Path(__file__).resolve().parent.parent.parent / 'packages' / 'ai' / 'src' / 'ai' / 'web' / 'endpoints'


def _load_module_from_file(name: str, filepath: Path):
    """Import a Python module directly from its file path."""
    spec = importlib.util.spec_from_file_location(name, filepath)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# Load the modules under test by file path
prometheus_metrics = _load_module_from_file('ai.web.metrics.prometheus_metrics', _WEB_METRICS_DIR / 'prometheus_metrics.py')
tracing = _load_module_from_file('ai.web.metrics.tracing', _WEB_METRICS_DIR / 'tracing.py')

# Middleware imports from prometheus_metrics and tracing — those are already
# in sys.modules from the loads above, so the relative imports resolve.
middleware = _load_module_from_file('ai.web.metrics.middleware', _WEB_METRICS_DIR / 'middleware.py')

# The endpoint module imports from ai.web.metrics.prometheus_metrics which
# is already loaded above.
metrics_endpoint = _load_module_from_file('ai.web.endpoints.metrics_endpoint', _WEB_ENDPOINTS_DIR / 'metrics_endpoint.py')


# =========================================================================
# Prometheus metrics tests
# =========================================================================


class TestPrometheusMetrics:
    """Validate that Prometheus metric objects are properly defined and usable."""

    def test_pipeline_executions_counter_increments(self):
        REGISTRY = prometheus_metrics.REGISTRY
        before = REGISTRY.get_sample_value('rocketride_pipeline_executions_total', {'pipeline_name': 'test_pipe', 'status': 'success'}) or 0.0
        prometheus_metrics.PIPELINE_EXECUTIONS.labels(pipeline_name='test_pipe', status='success').inc()
        after = REGISTRY.get_sample_value('rocketride_pipeline_executions_total', {'pipeline_name': 'test_pipe', 'status': 'success'})
        assert after == before + 1.0

    def test_pipeline_executions_counter_error_label(self):
        REGISTRY = prometheus_metrics.REGISTRY
        before = REGISTRY.get_sample_value('rocketride_pipeline_executions_total', {'pipeline_name': 'err_pipe', 'status': 'error'}) or 0.0
        prometheus_metrics.PIPELINE_EXECUTIONS.labels(pipeline_name='err_pipe', status='error').inc(3)
        after = REGISTRY.get_sample_value('rocketride_pipeline_executions_total', {'pipeline_name': 'err_pipe', 'status': 'error'})
        assert after == before + 3.0

    def test_llm_requests_counter_increments(self):
        REGISTRY = prometheus_metrics.REGISTRY
        before = REGISTRY.get_sample_value('rocketride_llm_requests_total', {'provider': 'openai', 'model': 'gpt-4', 'status': 'success'}) or 0.0
        prometheus_metrics.LLM_REQUESTS.labels(provider='openai', model='gpt-4', status='success').inc()
        after = REGISTRY.get_sample_value('rocketride_llm_requests_total', {'provider': 'openai', 'model': 'gpt-4', 'status': 'success'})
        assert after == before + 1.0

    def test_llm_tokens_counter_by_type(self):
        REGISTRY = prometheus_metrics.REGISTRY
        before_in = REGISTRY.get_sample_value('rocketride_llm_tokens_total', {'provider': 'openai', 'model': 'gpt-4', 'token_type': 'input'}) or 0.0
        before_out = REGISTRY.get_sample_value('rocketride_llm_tokens_total', {'provider': 'openai', 'model': 'gpt-4', 'token_type': 'output'}) or 0.0

        prometheus_metrics.LLM_TOKENS.labels(provider='openai', model='gpt-4', token_type='input').inc(100)
        prometheus_metrics.LLM_TOKENS.labels(provider='openai', model='gpt-4', token_type='output').inc(50)

        after_in = REGISTRY.get_sample_value('rocketride_llm_tokens_total', {'provider': 'openai', 'model': 'gpt-4', 'token_type': 'input'})
        after_out = REGISTRY.get_sample_value('rocketride_llm_tokens_total', {'provider': 'openai', 'model': 'gpt-4', 'token_type': 'output'})

        assert after_in == before_in + 100.0
        assert after_out == before_out + 50.0

    def test_vectordb_operations_counter(self):
        REGISTRY = prometheus_metrics.REGISTRY
        before = REGISTRY.get_sample_value('rocketride_vectordb_operations_total', {'provider': 'milvus', 'operation': 'insert'}) or 0.0
        prometheus_metrics.VECTORDB_OPERATIONS.labels(provider='milvus', operation='insert').inc()
        after = REGISTRY.get_sample_value('rocketride_vectordb_operations_total', {'provider': 'milvus', 'operation': 'insert'})
        assert after == before + 1.0

    def test_active_tasks_gauge(self):
        REGISTRY = prometheus_metrics.REGISTRY
        prometheus_metrics.ACTIVE_TASKS.set(0)
        prometheus_metrics.ACTIVE_TASKS.inc()
        prometheus_metrics.ACTIVE_TASKS.inc()
        val = REGISTRY.get_sample_value('rocketride_active_tasks')
        assert val == 2.0

        prometheus_metrics.ACTIVE_TASKS.dec()
        val = REGISTRY.get_sample_value('rocketride_active_tasks')
        assert val == 1.0

    def test_http_requests_counter(self):
        REGISTRY = prometheus_metrics.REGISTRY
        before = REGISTRY.get_sample_value('rocketride_http_requests_total', {'method': 'GET', 'endpoint': '/ping', 'status_code': '200'}) or 0.0
        prometheus_metrics.HTTP_REQUESTS.labels(method='GET', endpoint='/ping', status_code='200').inc()
        after = REGISTRY.get_sample_value('rocketride_http_requests_total', {'method': 'GET', 'endpoint': '/ping', 'status_code': '200'})
        assert after == before + 1.0


# =========================================================================
# Histogram observation tests
# =========================================================================


class TestHistogramObservations:
    """Validate histogram .observe() works and populates bucket/sum/count."""

    def test_pipeline_duration_histogram(self):
        REGISTRY = prometheus_metrics.REGISTRY
        count_before = REGISTRY.get_sample_value('rocketride_pipeline_duration_seconds_count', {'pipeline_name': 'hist_test'}) or 0.0
        sum_before = REGISTRY.get_sample_value('rocketride_pipeline_duration_seconds_sum', {'pipeline_name': 'hist_test'}) or 0.0

        prometheus_metrics.PIPELINE_DURATION.labels(pipeline_name='hist_test').observe(1.5)
        prometheus_metrics.PIPELINE_DURATION.labels(pipeline_name='hist_test').observe(0.5)

        count_after = REGISTRY.get_sample_value('rocketride_pipeline_duration_seconds_count', {'pipeline_name': 'hist_test'})
        sum_after = REGISTRY.get_sample_value('rocketride_pipeline_duration_seconds_sum', {'pipeline_name': 'hist_test'})

        assert count_after == count_before + 2.0
        assert sum_after == pytest.approx(sum_before + 2.0, abs=1e-6)

    def test_llm_request_duration_histogram(self):
        REGISTRY = prometheus_metrics.REGISTRY
        count_before = REGISTRY.get_sample_value('rocketride_llm_request_duration_seconds_count', {'provider': 'anthropic', 'model': 'claude-3'}) or 0.0

        prometheus_metrics.LLM_REQUEST_DURATION.labels(provider='anthropic', model='claude-3').observe(0.42)

        count_after = REGISTRY.get_sample_value('rocketride_llm_request_duration_seconds_count', {'provider': 'anthropic', 'model': 'claude-3'})
        assert count_after == count_before + 1.0

    def test_http_request_duration_histogram(self):
        REGISTRY = prometheus_metrics.REGISTRY
        count_before = REGISTRY.get_sample_value('rocketride_http_request_duration_seconds_count', {'method': 'POST', 'endpoint': '/use'}) or 0.0

        prometheus_metrics.HTTP_REQUEST_DURATION.labels(method='POST', endpoint='/use').observe(0.123)

        count_after = REGISTRY.get_sample_value('rocketride_http_request_duration_seconds_count', {'method': 'POST', 'endpoint': '/use'})
        assert count_after == count_before + 1.0


# =========================================================================
# /metrics endpoint tests
# =========================================================================


class TestMetricsEndpoint:
    """Validate the /metrics endpoint returns valid Prometheus text format."""

    def test_generate_metrics_returns_bytes(self):
        data = prometheus_metrics.generate_metrics()
        assert isinstance(data, bytes)

    def test_generate_metrics_contains_metric_names(self):
        # Ensure at least one data point exists
        prometheus_metrics.PIPELINE_EXECUTIONS.labels(pipeline_name='fmt_test', status='success').inc()

        data = prometheus_metrics.generate_metrics().decode('utf-8')
        assert 'rocketride_pipeline_executions_total' in data
        assert 'rocketride_http_requests_total' in data
        assert 'rocketride_active_tasks' in data

    def test_generate_metrics_valid_prometheus_format(self):
        """Each non-empty, non-comment line should match 'metric_name{labels} value' or 'metric_name value'."""
        data = prometheus_metrics.generate_metrics().decode('utf-8')
        for line in data.strip().split('\n'):
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            # Basic shape: name{labels} value OR name value
            parts = line.split(' ')
            assert len(parts) >= 2, f'Malformed Prometheus line: {line}'

    @pytest.mark.asyncio
    async def test_metrics_endpoint_response(self):
        response = await metrics_endpoint.metrics_endpoint()
        assert response.status_code == 200
        assert response.media_type == prometheus_metrics.get_metrics_content_type()
        assert len(response.body) > 0

    def test_is_metrics_public_default(self):
        os.environ.pop('ROCKETRIDE_METRICS_PUBLIC', None)
        assert metrics_endpoint.is_metrics_public() is False

    def test_is_metrics_public_false(self):
        with patch.dict(os.environ, {'ROCKETRIDE_METRICS_PUBLIC': 'false'}):
            assert metrics_endpoint.is_metrics_public() is False

    def test_get_metrics_content_type(self):
        ct = prometheus_metrics.get_metrics_content_type()
        assert 'text/plain' in ct or 'text/openmetrics' in ct

    def test_get_metrics_app_returns_asgi(self):
        app = prometheus_metrics.get_metrics_app()
        assert callable(app)


# =========================================================================
# OpenTelemetry tracer tests
# =========================================================================


class TestOpenTelemetryTracing:
    """Validate tracer initialisation and helper functions."""

    @pytest.fixture(autouse=True)
    def reset_tracing_state(self):
        """Reset tracing module state before each test to ensure isolation."""
        tracing._tracer_provider = None
        yield
        # Clean up after test
        tracing.shutdown_tracing()

    def test_setup_tracing_none_exporter(self):
        """With OTEL_EXPORTER_TYPE=none, setup should succeed without network calls."""
        with patch.dict(os.environ, {'OTEL_EXPORTER_TYPE': 'none', 'OTEL_SERVICE_NAME': 'rocketride-test'}):
            provider = tracing.setup_tracing()
            assert provider is not None
            tracing.shutdown_tracing()

    def test_setup_tracing_console_exporter(self):
        """Console exporter should initialise without errors."""
        with patch.dict(os.environ, {'OTEL_EXPORTER_TYPE': 'console', 'OTEL_SERVICE_NAME': 'rocketride-test'}):
            provider = tracing.setup_tracing()
            assert provider is not None
            tracing.shutdown_tracing()

    def test_get_tracer_returns_tracer(self):
        """get_tracer() should return a valid Tracer object."""
        with patch.dict(os.environ, {'OTEL_EXPORTER_TYPE': 'none'}):
            tracing.setup_tracing()
            tracer = tracing.get_tracer('test-module')
            assert tracer is not None
            # Should be able to start a span
            with tracer.start_as_current_span('test-span') as span:
                assert span is not None
            tracing.shutdown_tracing()

    def test_shutdown_tracing_idempotent(self):
        """Calling shutdown_tracing multiple times should not raise."""
        tracing.shutdown_tracing()
        tracing.shutdown_tracing()  # second call should be safe

    def test_setup_tracing_with_fastapi_app(self):
        """When passed a FastAPI app, auto-instrumentation should be applied."""
        with patch.dict(os.environ, {'OTEL_EXPORTER_TYPE': 'none'}):
            mock_app = MagicMock()
            mock_app.state = MagicMock()
            mock_app.state._otel_instrumented = False
            with patch('opentelemetry.instrumentation.fastapi.FastAPIInstrumentor.instrument_app') as mock_instrument_app:
                provider = tracing.setup_tracing(app=mock_app)
                assert provider is not None
                mock_instrument_app.assert_called_once_with(mock_app)
                tracing.shutdown_tracing()

    def test_setup_tracing_otlp_exporter(self):
        """OTLP exporter path should import and configure the OTLPSpanExporter."""
        with patch.dict(os.environ, {'OTEL_EXPORTER_TYPE': 'otlp', 'OTEL_EXPORTER_OTLP_ENDPOINT': 'http://localhost:4317'}):
            mock_exporter_cls = MagicMock()
            mock_exporter = MagicMock()
            mock_exporter_cls.return_value = mock_exporter

            mock_otlp_module = MagicMock()
            mock_otlp_module.OTLPSpanExporter = mock_exporter_cls

            with patch.dict(sys.modules, {'opentelemetry.exporter.otlp.proto.grpc.trace_exporter': mock_otlp_module}):
                provider = tracing.setup_tracing()
                assert provider is not None

    def test_shutdown_tracing_is_lock_protected(self):
        """shutdown_tracing() should acquire _setup_lock to prevent races with setup_tracing()."""
        import threading

        with patch.dict(os.environ, {'OTEL_EXPORTER_TYPE': 'none'}):
            tracing.setup_tracing()

        errors = []

        def concurrent_shutdown():
            try:
                tracing.shutdown_tracing()
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=concurrent_shutdown) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f'Concurrent shutdown raised: {errors}'
        assert tracing._tracer_provider is None


# =========================================================================
# Metrics middleware tests
# =========================================================================


class TestMetricsMiddleware:
    """Validate that MetricsMiddleware records HTTP metrics for each request."""

    @pytest.mark.asyncio
    async def test_middleware_records_success(self):
        """Middleware should increment HTTP_REQUESTS and observe duration on 200."""
        REGISTRY = prometheus_metrics.REGISTRY

        counter_before = REGISTRY.get_sample_value('rocketride_http_requests_total', {'method': 'GET', 'endpoint': '/test-mw', 'status_code': '200'}) or 0.0
        hist_count_before = REGISTRY.get_sample_value('rocketride_http_request_duration_seconds_count', {'method': 'GET', 'endpoint': '/test-mw'}) or 0.0

        request = MagicMock(spec=['method', 'url', 'headers', 'scope', 'app'])
        request.method = 'GET'
        request.url = MagicMock()
        request.url.path = '/test-mw'
        request.url.__str__ = lambda self: 'http://localhost:5565/test-mw'
        request.scope = {'type': 'http'}
        request.app = MagicMock(routes=[])

        mock_response = MagicMock()
        mock_response.status_code = 200

        async def call_next(req):
            return mock_response

        with patch.object(middleware, 'get_tracer') as mock_get_tracer:
            mock_tracer = MagicMock()
            mock_span = MagicMock()
            mock_span.__enter__ = MagicMock(return_value=mock_span)
            mock_span.__exit__ = MagicMock(return_value=False)
            mock_tracer.start_as_current_span.return_value = mock_span
            mock_get_tracer.return_value = mock_tracer

            mw = middleware.MetricsMiddleware(app=MagicMock())
            result = await mw.dispatch(request, call_next)

        assert result.status_code == 200

        counter_after = REGISTRY.get_sample_value('rocketride_http_requests_total', {'method': 'GET', 'endpoint': '/test-mw', 'status_code': '200'})
        hist_count_after = REGISTRY.get_sample_value('rocketride_http_request_duration_seconds_count', {'method': 'GET', 'endpoint': '/test-mw'})

        assert counter_after == counter_before + 1.0
        assert hist_count_after == hist_count_before + 1.0

    @pytest.mark.asyncio
    async def test_middleware_records_error_status(self):
        """Middleware should record 500 status when call_next raises."""
        REGISTRY = prometheus_metrics.REGISTRY

        counter_before = REGISTRY.get_sample_value('rocketride_http_requests_total', {'method': 'POST', 'endpoint': '/fail-mw', 'status_code': '500'}) or 0.0

        request = MagicMock(spec=['method', 'url', 'headers', 'scope', 'app'])
        request.method = 'POST'
        request.url = MagicMock()
        request.url.path = '/fail-mw'
        request.url.__str__ = lambda self: 'http://localhost:5565/fail-mw'
        request.scope = {'type': 'http'}
        request.app = MagicMock(routes=[])

        async def call_next(req):
            raise RuntimeError('boom')

        with patch.object(middleware, 'get_tracer') as mock_get_tracer:
            mock_tracer = MagicMock()
            mock_span = MagicMock()
            mock_span.__enter__ = MagicMock(return_value=mock_span)
            mock_span.__exit__ = MagicMock(return_value=False)
            mock_tracer.start_as_current_span.return_value = mock_span
            mock_get_tracer.return_value = mock_tracer

            mw = middleware.MetricsMiddleware(app=MagicMock())
            with pytest.raises(RuntimeError, match='boom'):
                await mw.dispatch(request, call_next)

        counter_after = REGISTRY.get_sample_value('rocketride_http_requests_total', {'method': 'POST', 'endpoint': '/fail-mw', 'status_code': '500'})
        assert counter_after == counter_before + 1.0

    @pytest.mark.asyncio
    async def test_middleware_records_404(self):
        """Middleware should record 404 status correctly."""
        REGISTRY = prometheus_metrics.REGISTRY

        counter_before = REGISTRY.get_sample_value('rocketride_http_requests_total', {'method': 'GET', 'endpoint': '/not-found-mw', 'status_code': '404'}) or 0.0

        request = MagicMock(spec=['method', 'url', 'headers', 'scope', 'app'])
        request.method = 'GET'
        request.url = MagicMock()
        request.url.path = '/not-found-mw'
        request.url.__str__ = lambda self: 'http://localhost:5565/not-found-mw'
        request.scope = {'type': 'http'}
        request.app = MagicMock(routes=[])

        mock_response = MagicMock()
        mock_response.status_code = 404

        async def call_next(req):
            return mock_response

        with patch.object(middleware, 'get_tracer') as mock_get_tracer:
            mock_tracer = MagicMock()
            mock_span = MagicMock()
            mock_span.__enter__ = MagicMock(return_value=mock_span)
            mock_span.__exit__ = MagicMock(return_value=False)
            mock_tracer.start_as_current_span.return_value = mock_span
            mock_get_tracer.return_value = mock_tracer

            mw = middleware.MetricsMiddleware(app=MagicMock())
            await mw.dispatch(request, call_next)

        counter_after = REGISTRY.get_sample_value('rocketride_http_requests_total', {'method': 'GET', 'endpoint': '/not-found-mw', 'status_code': '404'})
        assert counter_after == counter_before + 1.0
