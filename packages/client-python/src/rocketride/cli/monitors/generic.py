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
Generic Monitor for Simple Command Display.

This module provides the GenericMonitor class for basic command status display
without specialized event handling or data formatting. Use this monitor for
simple commands that only need to show status messages and progress updates
without complex data visualization or real-time event monitoring.

The generic monitor provides a clean, minimal interface for commands that require
basic status display functionality without the overhead of specialized monitoring
features like progress bars, event streaming, or data visualization.

Key Features:
    - Simple command status display with clean formatting
    - Minimal overhead for basic status reporting
    - Inherited terminal management and box display functionality
    - Flexible text-based status updates
    - Standard error and message handling

Usage:
    monitor = GenericMonitor(cli, "Command Title")
    monitor.set_command_status("Processing...")
    monitor.draw()

Components:
    GenericMonitor: Basic monitor for simple command status display
"""

from .base import BoxMonitor


class GenericMonitor(BoxMonitor):
    """
    Generic monitor that only displays command status.

    A minimal monitor implementation that provides basic command status display
    without specialized event handling or data formatting. Useful for simple
    commands that only need to show status messages and don't require complex
    data visualization or real-time updates.

    Example:
        ```python
        # Create generic monitor for simple status display
        monitor = GenericMonitor(cli, 'Pipeline Management')

        # Update status message
        monitor.set_command_status('Connecting to server...')
        monitor.draw()

        # Display error message
        monitor.add_box('Error', ['Connection failed'])
        monitor.draw()
        ```

    Key Features:
        - Minimal overhead for basic status reporting
        - Clean text-based status display
        - Standard terminal management inherited from BoxMonitor
        - Support for multiple status lines and error boxes
        - Simple API for quick status updates
        - No specialized event handling or data processing
    """

    def __init__(self, cli, command_title: str, width: int = None, height: int = None):
        """
        Initialize GenericMonitor with CLI context and terminal dimensions.

        Creates a basic monitor with the specified title that inherits all
        standard monitor functionality from BoxMonitor but doesn't add any
        specialized display logic or event handling.

        Args:
            cli: CLI instance for access to cancellation state and events
            command_title: Title to display in the monitor header
            width: Terminal width override (None for auto-detect)
            height: Terminal height override (None for auto-detect)

        Usage:
            Creates a clean, minimal monitor suitable for commands that need
            basic status display without complex data visualization or
            real-time event monitoring capabilities.
        """
        super().__init__(cli, command_title, width, height)
