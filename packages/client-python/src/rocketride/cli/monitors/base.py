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
Base Monitor Class for Terminal Display Management.

This module provides the BoxMonitor base class that manages terminal box display
with automatic sizing, screen clearing, cursor management, and box-based layout
system. Use this class as the foundation for specialized monitors that display
different types of real-time information in organized, visually appealing boxes.

The base monitor provides fundamental terminal display management including
automatic terminal size detection, screen clearing strategies, cursor positioning,
box layout management, and consistent rendering for all monitor implementations.

Key Features:
    - Automatic terminal size detection with fallback handling
    - Efficient screen clearing and cursor management
    - Box-based layout system for organized information display
    - Dynamic terminal resizing support during operation
    - Consistent rendering pipeline for all monitor types
    - Standard error handling and resource management

Usage:
    class MyMonitor(BoxMonitor):
        def __init__(self, cli, title):
            super().__init__(cli, title)

        def display_data(self, data):
            self.clear()
            self.add_box("Data", data_lines)
            self.draw()

Components:
    BoxMonitor: Base monitor class for terminal box display management
"""

import sys
from typing import List, Union
from ..ui.box import Box
from ..ui.display import detect_terminal_size, is_terminal, clear_screen, cursor_home


class BoxMonitor:
    """
    Base monitor class that manages terminal box display.

    Provides fundamental terminal display management with automatic sizing,
    screen clearing, cursor management, and box-based layout system.
    Serves as the foundation for specialized monitors that display different
    types of real-time information in organized, visually appealing boxes.

    Example:
        ```python
        # Create base monitor
        monitor = BoxMonitor(cli, 'My Application')

        # Add content boxes
        monitor.add_box('Status', ['Connected', 'Processing...'])
        monitor.add_box('Statistics', ['Files: 10', 'Errors: 0'])

        # Render display
        monitor.draw()
        ```

    Key Features:
        - Automatic terminal size detection and management
        - Box-based layout system for organized content
        - Efficient screen clearing and cursor positioning
        - Dynamic terminal resizing support
        - Consistent rendering pipeline for all content types
        - Standard error handling and resource cleanup
    """

    def __init__(self, cli, command_title: str, width: int = None, height: int = None):
        """
        Initialize BoxMonitor with CLI context and terminal dimensions.

        Sets up the monitor with terminal detection, size management, and
        basic display state tracking for consistent rendering.

        Args:
            cli: CLI instance for access to cancellation state and events
            command_title: Title to display in the main command status box
            width: Terminal width override (None for auto-detect)
            height: Terminal height override (None for auto-detect)

        Usage:
            Creates a monitor with automatic terminal size detection and
            initializes the display management system for organized box
            layout and rendering with proper resource management.
        """
        # Store configuration
        self.command_title = command_title
        self._cli = cli

        # Initialize terminal dimensions
        if width is None or height is None:
            detected_width, detected_height = detect_terminal_size()
            self.width = width if width is not None else detected_width
            self.height = height if height is not None else detected_height
        else:
            self.width = width
            self.height = height

        # Display state management
        self.boxes = []  # List of boxes to display
        self.last_line_count = 0  # Track lines for proper clearing
        self.screen_cleared = False  # Track whether screen has been cleared
        self.command_status = ['Initializing...']  # Status lines for command box
        self.is_terminal = is_terminal()  # Whether we're running in a terminal

    def _update_terminal_size(self):
        """
        Update terminal size on every draw call.

        Refreshes terminal dimensions to handle window resizing during
        long-running operations like monitoring or file uploads.

        Usage:
            Called automatically during each draw operation to ensure
            the display adapts to terminal window size changes without
            requiring application restart or manual refresh.
        """
        self.width, self.height = detect_terminal_size()

    def clear(self):
        """
        Reset the internal list of boxes.

        Clears all boxes that have been added since the last draw,
        preparing for a fresh display cycle.

        Usage:
            Call this method before adding new boxes for the current
            frame to ensure old content doesn't persist between updates.
        """
        self.boxes.clear()

    def clear_screen(self):
        """
        Force a complete screen clear on next draw.

        Resets screen clearing state to ensure the next draw operation
        performs a full screen clear rather than incremental updates.

        Usage:
            Call this method when you need to ensure a completely clean
            screen, such as when switching between different display modes
            or recovering from display corruption.
        """
        self.screen_cleared = False
        self.last_line_count = 0

    def set_command_status(self, status: Union[str, List[str]]):
        """
        Set the content for the top command status box.

        Updates the command status that appears in the main header box,
        accepting either a single string or list of status lines.

        Args:
            status: Status message(s) to display in command box

        Usage:
            Use this method to update the main status display with current
            operation information, progress messages, or error states.
            Supports both single-line and multi-line status updates.
        """
        if isinstance(status, str):
            self.command_status = [status]
        else:
            self.command_status = status

    def connecting(self, url: str, attempt: int = 0):
        """
        Display connecting status.

        Shows connection status while attempting to establish server connection,
        with retry attempt information and user instructions.

        Args:
            url: Server URL being connected to
            attempt: Current connection attempt number (0 for first attempt)

        Usage:
            Call this method during connection establishment to provide
            user feedback about connection progress and retry attempts
            with clear status information.
        """
        self.clear()

        # Show attempt number if this is a retry
        retry = f' (attempt {attempt})' if attempt > 0 else ''

        # Display connection status
        self.add_box('Connection Status', [f'Connecting to {url}{retry}...'])
        self.draw()

    def add_box(self, title: str, lines: List[str]):
        """
        Add a box to be displayed.

        Adds a new display box with the specified title and content lines
        to the list of boxes that will be rendered on the next draw call.

        Args:
            title: Title for the box header
            lines: Content lines to display in the box

        Usage:
            Use this method to add organized content sections to the display.
            Each box will be rendered with a title header and bordered content
            area for clear visual separation and organization.
        """
        if lines:
            box = Box(title, lines, self.width)
            self.boxes.append(box)

    def draw(self):
        """
        Draw all boxes to screen with proper clearing.

        Renders the complete display including command status box and all
        added content boxes, handling screen clearing, cursor positioning,
        and line management for clean updates.

        Usage:
            Call this method to render the current display state to the
            terminal. Handles all aspects of screen management including
            clearing, positioning, and efficient line updates.

        Display Process:
            1. Update terminal dimensions for window resize handling
            2. Clear screen on first draw or when forced
            3. Position cursor at top-left for consistent rendering
            4. Render command status box followed by content boxes
            5. Clear any remaining lines from previous longer displays
            6. Flush output to ensure immediate terminal update
        """
        # Update dimensions in case terminal was resized
        self._update_terminal_size()

        # Clear screen on first draw
        if not self.screen_cleared:
            clear_screen()
            self.screen_cleared = True

        # Position cursor at top-left
        cursor_home()

        # Build complete list of boxes to render
        all_boxes = []

        # Add command status box first if we have status
        if self.command_status:
            command_box = Box(self.command_title, self.command_status, self.width)
            all_boxes.append(command_box)

        # Add all content boxes
        all_boxes.extend(self.boxes)

        # Render all boxes into lines
        all_lines = []
        for i, box in enumerate(all_boxes):
            box_lines = box.render()
            all_lines.extend(box_lines)

            # Add spacing between boxes (except after last box)
            if i < len(all_boxes) - 1 and box_lines:
                all_lines.append(' ' * self.width)

        # Output all lines to terminal
        for line in all_lines:
            print(line + ' ')  # Extra space to ensure line clearing

        # Clear any remaining lines from previous longer displays
        current_line_count = len(all_lines)
        if current_line_count < self.last_line_count:
            for _ in range(current_line_count, self.last_line_count):
                print(' ' * self.width)

        # Update line count for next clearing operation
        self.last_line_count = current_line_count

        # Ensure output is flushed to terminal immediately
        sys.stdout.flush()
