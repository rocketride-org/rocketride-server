# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
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

"""
RocketRide OpenTelemetry bridge ('rocketride otel').

Consumes the engine's documented WebSocket monitor protocol and exports
pipeline traces and metrics over OTLP -- with zero engine/server changes.

All re-exports are lazy so that importing :mod:`rocketride.otelbridge` never
requires the optional 'otel' extra; the OpenTelemetry packages are only
imported when providers or mappers are actually constructed.
"""

import importlib

# Public name -> defining submodule (relative). Resolved lazily via __getattr__.
_EXPORTS = {
    'FlowSpanMapper': '.mapper',
    'MetricsMapper': '.mapper',
    'build_providers': '.setup',
    'OtelNotInstalledError': '.setup',
    'OtelConfig': '.config',
    'InsecureTransportError': '.config',
    'validate_transport_security': '.config',
    'run_bridge': '.bridge',
}

__all__ = list(_EXPORTS)


def __getattr__(name: str):
    """Lazily resolve public re-exports (PEP 562)."""
    module_name = _EXPORTS.get(name)
    if module_name is None:
        raise AttributeError(f'module {__name__!r} has no attribute {name!r}')
    module = importlib.import_module(module_name, __name__)
    return getattr(module, name)


def __dir__():
    return sorted(set(globals()) | set(_EXPORTS))
