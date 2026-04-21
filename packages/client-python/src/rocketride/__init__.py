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
    client = RocketRideClient()
    result = await client.connect('your_api_key')  # returns ConnectResult
    try:
        token = await client.use(filepath='pipeline.json')
        response = await client.send(token, 'your data')

        question = Question()
        question.addQuestion('What are the key findings?')
        answer = await client.chat(token=token, question=question)
    finally:
        await client.disconnect()

For more information, see the documentation at https://docs.rocketride.ai
"""

# Package metadata — __version__ is populated at runtime from the installed
# package metadata so it always matches the installed wheel/egg-info version.
__version__ = ''
__author__ = 'RocketRide, Inc.'
__email__ = 'dev@rocketride.ai'

try:
    # importlib.metadata is available from Python 3.8+ and reads the version
    # string from the installed distribution without requiring a hard-coded value.
    from importlib.metadata import version as _get_version

    # Look up the version of the 'rocketride' distribution package.
    __version__ = _get_version('rocketride')
except Exception:
    # Package metadata is unavailable (e.g. editable install without build step);
    # leave __version__ as the empty string set above — callers can check for ''.
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

# Import type definitions, constants, and callback signatures used throughout the SDK
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

# Import the primary client class and its exception, plus the specialised
# authentication exception for callers that need to distinguish auth failures.
from .client import RocketRideClient, RocketRideException
from .core.exceptions import AuthenticationException

# Import identity types returned by connect()
from .types.client import TeamInfo, OrgInfo, ConnectResult

# Import server/connection constants so callers can reference defaults without
# diving into the internal core package.
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
    PROJECT_DIR,
)

# Declare all public symbols so ``from rocketride import *`` and static analysis
# tools see a complete, explicit surface area for this package.
__all__ = [
    'Answer',
    'TeamInfo',
    'OrgInfo',
    'ConnectResult',
    'RocketRideClient',
    'RocketRideClientConfig',
    'RocketRideException',
    'AuthenticationException',
    'CONST_DEFAULT_SERVICE',
    'CONST_DEFAULT_WEB_CLOUD',
    'CONST_DEFAULT_WEB_HOST',
    'CONST_DEFAULT_WEB_LOCAL',
    'CONST_DEFAULT_WEB_PORT',
    'CONST_DEFAULT_WEB_PROTOCOL',
    'CONST_SOCKET_TIMEOUT',
    'CONST_WS_PING_INTERVAL',
    'CONST_WS_PING_TIMEOUT',
    'PROJECT_DIR',
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
