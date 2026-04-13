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
RocketRide Client SDK.

This package provides a comprehensive Python client for executing RocketRide pipelines,
managing data processing workflows, and interacting with AI services using the
Debug Adapter Protocol (DAP).

The RocketRide Client SDK enables you to:
    - Connect to RocketRide servers and manage connections
    - Execute and control data processing pipelines
    - Upload and stream data to pipelines
    - Chat with AI for document analysis and Q&A
    - Monitor pipeline progress with real-time events
    - Test server connectivity and health

Quick Start:
    from rocketride import RocketRideClient, Question

    # Connect and process data
    async with RocketRideClient(auth='your_api_key') as client:
        # Start a pipeline
        result = await client.use(filepath='pipeline.json')

        # Send data for processing
        response = await client.send(result['token'], 'your data')

        # Chat with AI
        question = Question()
        question.addQuestion('What are the key findings?')
        answer = await client.chat(token=result['token'], question=question)

For more information, see the documentation at https://docs.rocketride.ai
"""

__version__ = ''
__author__ = 'RocketRide, Inc.'
__email__ = 'dev@rocketride.ai'

try:
    from importlib.metadata import version as _get_version

    __version__ = _get_version('rocketride')
except Exception:
    pass

# Import main classes for convenient access
from .schema import (
    Answer,
    Question,
    QuestionExample,
    QuestionHistory,
    QuestionText,
    QuestionType,
    DocFilter,
    DocMetadata,
    Doc,
    DocGroup,
)

from .types import (
    RocketRideClientConfig,
    ConnectCallback,
    ConnectErrorCallback,
    ConnectionInfo,
    DAPMessage,
    DisconnectCallback,
    DASHBOARD_CONNECTION,
    DASHBOARD_OVERVIEW,
    DASHBOARD_RESPONSE,
    DASHBOARD_TASK,
    EVENT_STATUS_UPDATE,
    EVENT_TASK,
    EVENT_TYPE,
    EventCallback,
    PIPELINE_RESULT,
    PipelineComponent,
    PipelineConfig,
    TASK_METRICS,
    TASK_STATE,
    TASK_STATUS_FLOW,
    TASK_STATUS,
    TASK_TOKENS,
    TraceInfo,
    TransportCallbacks,
    UPLOAD_RESULT,
)

from .client import RocketRideClient, RocketRideException
from .core.exceptions import (
    AuthenticationException,
    UnsupportedPlatformError,
    RuntimeManagementError,
    RuntimeNotFoundError,
)

from .core.constants import (
    CONST_DEFAULT_SERVICE,
    CONST_DEFAULT_WEB_CLOUD,
    CONST_DEFAULT_WEB_HOST,
    CONST_DEFAULT_WEB_LOCAL,
    CONST_DEFAULT_WEB_PORT,
    CONST_DEFAULT_WEB_PROTOCOL,
    CONST_SOCKET_TIMEOUT,
    CONST_WS_PING_INTERVAL,
    CONST_WS_PING_TIMEOUT,
)

__all__ = [
    'Answer',
    'RocketRideClient',
    'RocketRideClientConfig',
    'RocketRideException',
    'AuthenticationException',
    'UnsupportedPlatformError',
    'RuntimeManagementError',
    'RuntimeNotFoundError',
    'CONST_DEFAULT_SERVICE',
    'CONST_DEFAULT_WEB_CLOUD',
    'CONST_DEFAULT_WEB_HOST',
    'CONST_DEFAULT_WEB_LOCAL',
    'CONST_DEFAULT_WEB_PORT',
    'CONST_DEFAULT_WEB_PROTOCOL',
    'CONST_SOCKET_TIMEOUT',
    'CONST_WS_PING_INTERVAL',
    'CONST_WS_PING_TIMEOUT',
    'ConnectCallback',
    'ConnectErrorCallback',
    'ConnectionInfo',
    'DASHBOARD_CONNECTION',
    'DASHBOARD_OVERVIEW',
    'DASHBOARD_RESPONSE',
    'DASHBOARD_TASK',
    'DAPMessage',
    'DisconnectCallback',
    'Doc',
    'DocFilter',
    'DocGroup',
    'DocMetadata',
    'EVENT_STATUS_UPDATE',
    'EVENT_TASK',
    'EVENT_TYPE',
    'EventCallback',
    'PIPELINE_RESULT',
    'PipelineComponent',
    'PipelineConfig',
    'Question',
    'QuestionExample',
    'QuestionHistory',
    'QuestionText',
    'QuestionType',
    'TASK_METRICS',
    'TASK_STATE',
    'TASK_STATUS_FLOW',
    'TASK_STATUS',
    'TASK_TOKENS',
    'TraceInfo',
    'TransportCallbacks',
    'UPLOAD_RESULT',
]
