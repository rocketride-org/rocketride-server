# MIT License
#
# Copyright (c) 2026 RocketRide, Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""Structured logging built on structlog wrapping stdlib logging.

Provides JSON-formatted log output with OpenTelemetry trace context
injection and PII scrubbing.
"""

import logging
import sys

import structlog

from .pii import scrub_pii_processor

_configured = False


def _add_otel_context(logger: logging.Logger, method_name: str, event_dict: dict) -> dict:
    """Inject OpenTelemetry trace and span IDs into the log event."""
    try:
        from opentelemetry import trace

        span = trace.get_current_span()
        ctx = span.get_span_context()
        if ctx and ctx.trace_id:
            event_dict['trace_id'] = format(ctx.trace_id, '032x')
            event_dict['span_id'] = format(ctx.span_id, '016x')
            event_dict['trace_flags'] = format(ctx.trace_flags, '02x')
        else:
            event_dict.setdefault('trace_id', '')
            event_dict.setdefault('span_id', '')
    except Exception:
        event_dict.setdefault('trace_id', '')
        event_dict.setdefault('span_id', '')
    return event_dict


def configure_logging(level: int = logging.INFO) -> None:
    """Configure structlog and stdlib logging for JSON output.

    Call once at application startup. Subsequent calls are no-ops.
    """
    global _configured
    if _configured:
        return

    shared_processors = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt='iso'),
        _add_otel_context,
        scrub_pii_processor,
    ]

    structlog.configure(
        processors=[
            *shared_processors,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.JSONRenderer(),
        ],
    )

    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    _configured = True


def get_logger(name: str, **initial_context: object) -> structlog.stdlib.BoundLogger:
    """Return a structured logger bound with the given name and optional context.

    Automatically calls configure_logging() if it hasn't been called yet,
    so callers can simply use get_logger() without explicit setup.
    """
    if not _configured:
        configure_logging()
    return structlog.get_logger(name, **initial_context)
