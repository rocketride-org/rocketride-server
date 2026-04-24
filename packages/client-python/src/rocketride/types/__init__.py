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
Type Definitions for RocketRide Client.

This module provides TypedDict classes, type aliases, and constants for type-safe
interactions with the RocketRide client. These definitions improve code completion,
enable static type checking, and document expected data structures.

Categories:
    Client Types: Configuration and callback types for client initialization
    Pipeline Types: Configuration structures for pipeline execution
    Task Types: Status, state, and flow definitions for task management
    Data Types: Structures for data operations and file uploads
    Event Types: Event type constants and callback signatures

These types are compatible with Python's type hinting system and tools like mypy,
providing compile-time verification and better IDE support.

Usage:
    from rocketride.types import (
        RocketRideClientConfig,
        PipelineConfig,
        TASK_STATUS,
        EventCallback
    )

    # Type-safe client configuration
    config: RocketRideClientConfig = {
        'auth': 'your_api_key',
        'uri': 'wss://server.example.com',
        'on_event': my_event_handler
    }

    # Type hints for better IDE support
    def handle_status(status: TASK_STATUS) -> None:
        print(f"Pipeline state: {status['state']}")
"""

from .client import (
    RocketRideClientConfig,
    ConnectCallback,
    ConnectErrorCallback,
    DisconnectCallback,
    EventCallback,
    ConnectionInfo,
    TraceInfo,
    DAPMessage,
    TransportCallbacks,
)

from .pipeline import (
    PipelineInputConnection,
    PipelineControlConnection,
    PipelineComponent,
    PipelineConfig,
)

from .task import (
    TASK_STATUS,
    TASK_STATE,
    TASK_STATUS_FLOW,
    TASK_TOKENS,
    TASK_METRICS,
)

from .events import (
    EVENT_TYPE,
    TASK_EVENT,
    TASK_EVENT_FLOW,
    TASK_EVENT_RUNNING,
    TASK_EVENT_BEGIN,
    TASK_EVENT_END,
    TASK_EVENT_RESTART,
)

from .dashboard import (
    DASHBOARD_OVERVIEW,
    DASHBOARD_MONITOR,
    DASHBOARD_CONNECTION,
    DASHBOARD_TASK,
    DASHBOARD_RESPONSE,
    DASHBOARD_EVENT,
    DASHBOARD_EVENT_CONNECTION_ADDED,
    DASHBOARD_EVENT_CONNECTION_REMOVED,
    DASHBOARD_EVENT_TASK_STARTED,
    DASHBOARD_EVENT_TASK_STOPPED,
    DASHBOARD_EVENT_TASK_REMOVED,
    DASHBOARD_EVENT_TASK_ERROR,
    DASHBOARD_EVENT_AUTH_FAILED,
    DASHBOARD_EVENT_MONITOR_CHANGED,
)

from .data import (
    PIPELINE_RESULT,
    UPLOAD_RESULT,
)

from .service import (
    SERVICE_SECTION,
    SERVICE_INVOKE_SLOT,
    SERVICE_INPUT_LANE,
    SERVICE_DEFINITION,
    SERVICES_RESPONSE,
    VALIDATION_ERROR,
    VALIDATION_RESULT,
    PROTOCOL_CAPS,
)

__all__ = [
    # Client types
    'RocketRideClientConfig',
    'ConnectCallback',
    'ConnectErrorCallback',
    'DisconnectCallback',
    'EventCallback',
    'ConnectionInfo',
    'TraceInfo',
    'DAPMessage',
    'TransportCallbacks',
    # Pipeline types
    'PipelineInputConnection',
    'PipelineControlConnection',
    'PipelineComponent',
    'PipelineConfig',
    # Task types
    'TASK_STATUS',
    'TASK_STATE',
    'TASK_STATUS_FLOW',
    'TASK_TOKENS',
    'TASK_METRICS',
    # Event types
    'EVENT_TYPE',
    'TASK_EVENT',
    'TASK_EVENT_FLOW',
    'TASK_EVENT_RUNNING',
    'TASK_EVENT_BEGIN',
    'TASK_EVENT_END',
    'TASK_EVENT_RESTART',
    # Dashboard types
    'DASHBOARD_OVERVIEW',
    'DASHBOARD_MONITOR',
    'DASHBOARD_CONNECTION',
    'DASHBOARD_TASK',
    'DASHBOARD_RESPONSE',
    'DASHBOARD_EVENT',
    'DASHBOARD_EVENT_CONNECTION_ADDED',
    'DASHBOARD_EVENT_CONNECTION_REMOVED',
    'DASHBOARD_EVENT_TASK_STARTED',
    'DASHBOARD_EVENT_TASK_STOPPED',
    'DASHBOARD_EVENT_TASK_REMOVED',
    'DASHBOARD_EVENT_TASK_ERROR',
    'DASHBOARD_EVENT_AUTH_FAILED',
    'DASHBOARD_EVENT_MONITOR_CHANGED',
    # Data types
    'PIPELINE_RESULT',
    'UPLOAD_RESULT',
    # Service types
    'SERVICE_SECTION',
    'SERVICE_INVOKE_SLOT',
    'SERVICE_INPUT_LANE',
    'SERVICE_DEFINITION',
    'SERVICES_RESPONSE',
    'VALIDATION_ERROR',
    'VALIDATION_RESULT',
    'PROTOCOL_CAPS',
]
