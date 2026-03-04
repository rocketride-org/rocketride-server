# =============================================================================
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

# -----------------------------------------------------------------------------
# Declare out interfaces
# -----------------------------------------------------------------------------
from .engine import args
from .engine import configureLogger
from .engine import debug
from .engine import error
from .engine import expand
from .engine import getServiceDefinition
from .engine import getServiceDefinitions
from .engine import getVersion
from .engine import isAppMonitor
from .engine import isLevelEnabled
from .engine import Lvl
from .engine import monitorCompleted
from .engine import monitorFailed
from .engine import monitorMetrics
from .engine import monitorOther
from .engine import monitorStatus
from .engine import monitorDependencyDownload
from .engine import outputEndpointParameters
from .engine import outputEntry
from .engine import outputException
from .engine import outputField
from .engine import processArguments
from .engine import readLine
from .engine import validatePipeline
from .engine import warning
from .error import APERR
from .error import Ec
from .filters import IEndpointBase
from .filters import IGlobalBase
from .filters import IInstanceBase
from .filters import IServiceEndpoint
from .filters import IServiceFilterPipe
from .filters import ILoader
from .types import AVI_ACTION
from .types import ENDPOINT_MODE
from .types import Entry
from .types import FLAGS
from .types import getObject
from .types import IControl
from .types import IDict
from .types import IInvoke
from .types import IInvokeLLM
from .types import IInvokeTool
from .types import IJson
from .types import OPEN_MODE
from .types import PROTOCOL_CAPS
from .types import SERVICE_MODE
from .types import TAG, TAG_ID

from engLib import Filters

# Define the public API for the rocketlib package
__all__ = [
    'APERR',
    'args',
    'AVI_ACTION',
    'configureLogger',
    'debug',
    'Ec',
    'error',
    'Entry',
    'ENDPOINT_MODE',
    'error',
    'expand',
    'Filters',
    'FLAGS',
    'getObject',
    'getServiceDefinition',
    'getServiceDefinitions',
    'getVersion',
    'IControl',
    'IDict',
    'IEndpointBase',
    'IGlobalBase',
    'IInstanceBase',
    'IServiceEndpoint',
    'IServiceFilterPipe',
    'IInvoke',
    'IInvokeLLM',
    'IInvokeTool',
    'IJson',
    'ILoader',
    'isAppMonitor',
    'isLevelEnabled',
    'Lvl',
    'monitorCompleted',
    'monitorFailed',
    'monitorMetrics',
    'monitorOther',
    'monitorStatus',
    'monitorDependencyDownload',
    'OPEN_MODE',
    'outputEndpointParameters',
    'outputEntry',
    'outputException',
    'outputField',
    'processArguments',
    'readLine',
    'PROTOCOL_CAPS',
    'SERVICE_MODE',
    'TAG',
    'TAG_ID',
    'validatePipeline',
    'warning',
]
