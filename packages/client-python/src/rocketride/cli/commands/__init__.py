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
CLI Command Implementations.

This module exports all available CLI command classes for the RocketRide command-line interface.
Each command provides a specific operation for interacting with RocketRide pipelines and services.

Available Commands:
    StartCommand: Start and run a pipeline from configuration
    UploadCommand: Upload files for pipeline processing
    StatusCommand: Query pipeline status and execution metrics
    StopCommand: Terminate running pipeline tasks
    EventsCommand: Monitor real-time pipeline events
    ListCommand: List all active tasks
    StoreCommand: Project and template storage operations
"""

from .start import StartCommand
from .upload import UploadCommand
from .status import StatusCommand
from .stop import StopCommand
from .events import EventsCommand
from .list import ListCommand
from .store import StoreCommand
from .init import InitCommand

__all__ = [
    'StartCommand',
    'UploadCommand',
    'StatusCommand',
    'StopCommand',
    'EventsCommand',
    'ListCommand',
    'StoreCommand',
    'InitCommand',
]
