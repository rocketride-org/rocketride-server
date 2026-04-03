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
# Declare the standard error misc types and functions
# -----------------------------------------------------------------------------
from enum import Enum
import logging
from pathlib import PurePosixPath
import re
import sys
import traceback
from typing import Dict, List
from urllib.parse import urlparse, unquote

from .filters import IEndpointBase
from .types import Entry

import engLib


# -----------------------------------------------------------------------------
# Declare the original command line arguments
# -----------------------------------------------------------------------------
def args() -> List[str]:
    """
    Return the original command line arguments.
    """
    return engLib.args()  # noqa


# -----------------------------------------------------------------------------
# Declare the misc types and functions that are forwarded to engLib
# -----------------------------------------------------------------------------
def monitorStatus(*args) -> None:
    """
    Output the monitor status for long operations.
    """


globals()['monitorStatus'] = engLib.monitorStatus  # noqa


def monitorCompleted(size: int) -> None:
    """
    Add to the completed count/size.
    """


globals()['monitorCompleted'] = engLib.monitorCompleted  # noqa


def monitorFailed(size: int) -> None:
    """
    Add to the failed count/size.
    """


globals()['monitorFailed'] = engLib.monitorFailed  # noqa


def monitorDependencyDownload(*args) -> None:
    """
    Output the metrics.
    """


globals()['monitorDependencyDownload'] = engLib.monitorDependencyDownload  # noqa


def monitorMetrics(*args) -> None:
    """
    Output the metrics.
    """


globals()['monitorMetrics'] = engLib.monitorMetrics  # noqa


def monitorOther(*args) -> None:
    """
    Output any monitor info.
    """


globals()['monitorOther'] = engLib.monitorOther  # noqa


def monitorSSE(pipe_id: int, type: str, data: dict = None) -> None:
    """
    Send a real-time SSE event to the UI for the current pipe.

    Args:
        pipe_id: The current pipe's ID (self.instance.pipeId)
        type:    Event type string (e.g. 'thinking', 'acting', 'confirm')
        data:    Optional dict payload to include in the event (passed as-is from kwargs)
    """
    import json

    payload = {'pipe_id': pipe_id, 'type': type}
    if data:
        payload['data'] = data
    engLib.monitorOther('SSE', json.dumps(payload, separators=(',', ':')))


class Lvl(Enum):
    """
    Engine logging levels.
    """

    Python = engLib.Lvl.Python
    Remoting = engLib.Lvl.Remoting
    DebugOut = engLib.Lvl.DebugOut
    DebugProtocol = engLib.Lvl.DebugProtocol


def isLevelEnabled(level: Lvl) -> bool:
    """
    Check if the specified Engine logging level is enabled.

    Args:
        level (Lvl): The Engine logging level to check.

    Returns:
        bool: True if the level is enabled, False otherwise.
    """
    pass


def isAppMonitor() -> bool:
    """
    Check if we are running with --monitor=app.
    """
    pass


globals()['Lvl'] = engLib.Lvl
globals()['isAppMonitor'] = engLib.isAppMonitor
globals()['isLevelEnabled'] = engLib.isLevelEnabled


def debug(*args) -> None:
    """
    Output debug messages. Shown when the appropriate trace level is enabled.
    """
    ...


def error(*args) -> None:
    """
    When an object fails, outputs the message to the job log.
    """
    ...


def warning(*args) -> None:
    """
    When an object has any type of warning, outputs the message to the job log.
    """
    ...


globals()['debug'] = engLib.debug
globals()['error'] = engLib.error
globals()['warning'] = engLib.warning


def readLine() -> str:
    """
    Read a line from the console.
    """
    ...


globals()['readLine'] = engLib.readLine  # noqa


class _LvlHandler(logging.Handler):
    """
    A custom logging handler that integrates with the Engine's logging system.

    This handler formats log records and routes them to the appropriate Engine logging
    functions (e.g., debug, warning, error) based on their severity levels.
    """

    def __init__(self, level: Lvl):
        super().__init__()

        self.engineLevel = level

        # Set logging level
        self.setLevel(logging.DEBUG)

        # Create and attach formatter
        levelName = str(level).upper()
        levelName = levelName[levelName.index('.') + 1 :]  # Skip leading 'LVL.'
        formatter = logging.Formatter(f'{levelName} %(message)s')
        self.setFormatter(formatter)

    def emit(self, record: logging.LogRecord):
        log_entry = self.format(record)
        if record.levelno >= logging.ERROR:
            error(log_entry)
        elif record.levelno >= logging.WARNING:
            warning(log_entry)
        else:
            debug(self.engineLevel, log_entry)


def configureLogger(name_: (str | tuple), level: Lvl):
    """
    Configure the logger with a custom logging handler for the specified Engine level.

    Args:
        name_ (str | tuple): The name(s) of the module(s) to attach the logging handler to.
        level: The Engine level to log to.
    """
    names = (name_,) if isinstance(name_, str) else name_

    # Create Engine logging handler if enabled
    handler = _LvlHandler(level) if level and isLevelEnabled(level) else None

    for name in names:
        # Configure logger for specified module
        logger = logging.getLogger(name)

        # Add Engine handler if enabled
        if handler:
            # Remove existing handlers
            while logger.handlers:
                logger.removeHandler(logger.handlers[0])

            logger.setLevel(logging.DEBUG)
            logger.addHandler(handler)

        # Let's only output errors otherwise
        else:
            logger.setLevel(logging.WARNING)
            for handler in logger.handlers:
                handler.setLevel(logging.WARNING)


def expand(value: str) -> str:
    """
    Expand %key% values in the engine environment to a string.
    """
    ...


expand = engLib.expand  # noqa


def validatePipeline(config: dict) -> dict:
    """
    Validate the pipeline configuration.
    """
    pass


globals()['validatePipeline'] = engLib.validatePipeline  # noqa


def getServiceDefinition(logicalType: str) -> Dict:
    """
    Return a service definition given a logical name.
    """
    ...


getServiceDefinition = engLib.getServiceDefinition  # noqa


def getServiceDefinitions() -> Dict:
    """
    Return a service definition given a logical name.
    """
    ...


getServiceDefinitions = engLib.getServiceDefinitions  # noqa


def getVersion() -> dict:
    """
    Return Engine version information.
    """
    pass


globals()['getVersion'] = engLib.getVersion


def processArguments(args: List[str]):
    """
    Process command line arguments.
    """
    ...


processArguments = engLib.processArguments  # noqa


# -----------------------------------------------------------------------------
# Additional functionality
# -----------------------------------------------------------------------------
def outputEndpointParameters(endpoint: IEndpointBase):
    """
    Output all the configuration parameters passed.
    """
    debug(endpoint.protocol + endpoint.name)
    debug('    openMode          :', endpoint.openMode)
    debug('    endpointMode      :', endpoint.endpointMode)
    debug('    level             :', endpoint.level)
    debug('    name              :', endpoint.name)
    debug('    key               :', endpoint.key)
    debug('    physicalType      :', endpoint.physicalType)
    debug('    logicalType       :', endpoint.logicalType)
    debug('    protocol          :', endpoint.protocol)
    debug('    serviceMode       :', endpoint.serviceMode)
    debug('    segmentSize       :', endpoint.segmentSize)
    debug('    storePath         :', endpoint.storePath)
    debug('    commonTargetPath  :', endpoint.commonTargetPath)
    debug('    serviceConfig     :', endpoint.serviceConfig)
    debug('    parameters        :', endpoint.parameters)


def outputField(object: Entry, item):
    """
    Output all the fields that have values set on the object.
    """
    mixed = item[:1].capitalize() + item[1:]

    hasValue = getattr(object, 'has' + mixed)
    if not hasValue:
        return

    value = getattr(object, item)
    debug('        ', item.ljust(18) + ':', value)


def outputEntry(object: Entry):
    """
    Output an object Entry.
    """
    debug('    ', object.url)
    outputField(object, 'path')
    outputField(object, 'fileName')
    outputField(object, 'objectId')
    outputField(object, 'instanceId')
    outputField(object, 'version')
    outputField(object, 'flags')
    outputField(object, 'attrib')
    outputField(object, 'size')
    outputField(object, 'storeSize')
    outputField(object, 'wordBatchId')
    outputField(object, 'keyId')
    outputField(object, 'createTime')
    outputField(object, 'accessTime')
    outputField(object, 'modifyTime')


def outputException():
    """
    Output an exception into a user readable form and log it to the engine.
    """
    # Get current system exception
    ex_type, ex_value, ex_traceback = sys.exc_info()

    # Extract unformatter stack traces as tuples
    trace_back = traceback.extract_tb(ex_traceback)

    debug('Exception type     : %s ' % ex_type.__name__)
    debug('Exception message : %s' % ex_value)
    for trace in trace_back:
        debug('    File : %s , Line : %d, Func.Name : %s, Message : %s' % (trace[0], trace[1], trace[2], trace[3]))


def hasInvalidCharacters(filepath: str):
    r"""
    Check if any part of the given file path (excluding the first component) contains invalid characters.

    Windows does not allow the following characters in filenames:
    < > : " / \ | ? * ;

    The first component is ignored unless it's a drive letter (e.g., "C:").

    :param filepath: The full file path to validate.
    :return: True if any invalid characters are found in any directory or filename (excluding the first component), otherwise False.
    """
    invalid_chars = r'[<>:"/\\|?*]'

    # Normalize and remove the scheme (e.g., aws://, file://)
    parsed = urlparse(filepath)
    path = unquote(parsed.path.strip('/'))  # Decode URL and remove leading slash

    # Use PurePosixPath to split path reliably
    parts = PurePosixPath(path).parts

    if not parts:
        return False  # No path components

    for part in parts:
        # Check for invalid characters
        if re.search(invalid_chars, part):
            return True
    return False
