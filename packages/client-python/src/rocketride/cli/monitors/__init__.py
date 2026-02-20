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

"""
Monitor Implementations for Real-time Terminal Display.

This module provides monitor classes for displaying real-time information in organized,
visually appealing terminal interfaces with automatic sizing, box-based layouts, and
live updates.

Available Monitors:
    GenericMonitor: General-purpose monitor for basic status and progress display
    StatusMonitor: Specialized monitor for task status with processing statistics
    EventsMonitor: Real-time event monitoring with scrollable history
    UploadProgressMonitor: File upload progress tracking with statistics

All monitors provide:
    - Automatic terminal size detection and dynamic resizing
    - Box-based layout system for organized information display
    - Real-time updates with efficient screen rendering
    - Error handling and graceful degradation
"""

from .generic import GenericMonitor
from .status import StatusMonitor
from .events import EventsMonitor
from .upload import UploadProgressMonitor

__all__ = [
    'GenericMonitor',
    'StatusMonitor',
    'EventsMonitor',
    'UploadProgressMonitor',
]
