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
Real-time Status Monitor for RocketRide Tasks.

This module provides the StatusMonitor class for continuous monitoring and display
of task execution status with detailed metrics, processing statistics, and error
reporting. Use this monitor to track pipeline progress, view performance data,
and monitor task health in real-time with comprehensive status visualization.

The status monitor creates organized displays showing pipeline state, processing
metrics, error conditions, and warnings with color-coded indicators and
formatted data presentation for enhanced readability and analysis.

Key Features:
    - Real-time task status monitoring with live updates
    - Comprehensive status display with organized information boxes
    - Color-coded state indicators for quick status assessment
    - Processing statistics with throughput and completion data
    - Error and warning tracking with detailed reporting
    - Metrics display for custom pipeline measurements
    - Automatic data formatting for human-readable display

Usage:
    monitor = StatusMonitor(cli, task_token)
    monitor.display_status(status_data)

Components:
    StatusMonitor: Real-time status monitor with comprehensive display
"""

from typing import Dict, Any, List
from datetime import datetime
from .base import BoxMonitor
from ..ui.colors import ANSI_RESET, ANSI_RED, ANSI_GREEN, ANSI_YELLOW, ANSI_BLUE, ANSI_GRAY
from ..utils.formatters import format_duration, format_size


class StatusMonitor(BoxMonitor):
    """
    Real-time status monitor for RocketRide tasks.

    Provides live monitoring of task execution with detailed status information,
    processing statistics, metrics, and error reporting. Displays information
    in organized boxes with color-coded state indicators.

    Example:
        ```python
        # Create status monitor for a specific task
        monitor = StatusMonitor(cli, task_token)

        # Display current task status
        monitor.display_status(status_data)
        ```

    Key Features:
        - Live task status updates with automatic refresh
        - Organized display sections for different status types
        - Color-coded pipeline states for visual feedback
        - Processing statistics with rates and completion data
        - Error and warning display with message formatting
        - Custom metrics display for pipeline-specific data
        - Automatic data formatting for readability
    """

    def __init__(self, cli, token: str, width: int = None, height: int = None):
        """
        Initialize StatusMonitor with CLI context, token, and terminal dimensions.

        Set up the monitor for displaying status information from a specific
        task with the configured terminal display settings.

        Args:
            cli: CLI instance for access to cancellation state and events
            token: Task token to monitor
            width: Terminal width override (None for auto-detect)
            height: Terminal height override (None for auto-detect)

        Usage:
            Creates a comprehensive status monitor that organizes task
            information into clearly labeled sections with visual formatting
            for enhanced readability and quick status assessment.
        """
        super().__init__(cli, 'RocketRide Task Monitor', width, height)

        # Store task token for monitoring
        self.token = token

        # Set initial command status display
        self.set_command_status(f'Token: {self.token}')

    def _get_state_display(self, state: int) -> tuple:
        """
        Get display representation of task state.

        Maps numeric state codes to human-readable names with appropriate colors
        for visual distinction of different task states.

        Args:
            state: Numeric state code from task status

        Returns:
            tuple: (state_name, color_code) for display

        State Mappings:
            - 0,1: Offline (gray) - Task not running or stopped
            - 2: Initializing (blue) - Task starting up
            - 3: Online (green) - Task running normally
            - 4: Stopping (yellow) - Task shutting down
            - 5,6: Offline (gray) - Task terminated or failed
        """
        state_map = {
            0: ('Offline', ANSI_GRAY),  # Task not running
            1: ('Offline', ANSI_GRAY),  # Task stopped
            2: ('Initializing', ANSI_BLUE),  # Task starting up
            3: ('Online', ANSI_GREEN),  # Task running normally
            4: ('Stopping', ANSI_YELLOW),  # Task shutting down
            5: ('Offline', ANSI_GRAY),  # Task terminated
            6: ('Offline', ANSI_GRAY),  # Task failed
        }
        return state_map.get(state, ('Unknown', ANSI_RESET))

    def _has_count_data(self, status: Dict[str, Any]) -> bool:
        """
        Check if there's processing statistics data.

        Determines whether the status contains meaningful processing statistics
        that should be displayed to the user.

        Args:
            status: Task status dictionary

        Returns:
            bool: True if processing statistics are available

        Checks for:
            - Total, completed, or failed item counts and sizes
            - Processing rate information (items/size per second)
            - Any non-zero statistical values
        """
        return (
            status.get('totalSize', 0) > 0
            or status.get('totalCount', 0) > 0
            or status.get('completedSize', 0) > 0
            or status.get('completedCount', 0) > 0
            or status.get('failedSize', 0) > 0
            or status.get('failedCount', 0) > 0
            or status.get('rateSize', 0) > 0
            or status.get('rateCount', 0) > 0
        )

    def _has_metrics_data(self, status: Dict[str, Any]) -> bool:
        """
        Check if there's metrics data to display.

        Determines whether the status contains custom metrics that should
        be shown in a separate metrics section.

        Args:
            status: Task status dictionary

        Returns:
            bool: True if metrics data is available

        Checks for:
            - Non-zero numeric values in the metrics dictionary
            - Any meaningful custom measurements from the pipeline
        """
        metrics = status.get('metrics') or {}
        return any(value > 0 for value in metrics.values() if isinstance(value, (int, float)))

    def display_status(self, status: Dict[str, Any]):
        """
        Display the current task status.

        Main display method that organizes status information into sections
        and renders the complete status view with all available data.

        Args:
            status: Complete task status dictionary from server

        Display Sections:
            - Pipeline Status: Core pipeline information and state
            - Metrics: Custom pipeline measurements (if available)
            - Errors: Error messages and failure details (if any)
            - Warnings: Warning messages and notices (if any)
            - Notes: Informational notes and messages (if any)
        """
        # Clear previous display
        self.clear()

        if status:
            # Always show pipeline status
            self.add_box('Pipeline Status', self._build_pipeline_lines(status))

            # Show metrics if available
            metrics_lines = self._build_metrics_lines(status)
            if metrics_lines:
                self.add_box('Metrics', metrics_lines)

            # Show errors if any
            error_lines = self._build_error_lines(status.get('errors', []), 'Error')
            if error_lines:
                self.add_box('Errors', error_lines)

            # Show warnings if any
            warning_lines = self._build_error_lines(status.get('warnings', []), 'Warning')
            if warning_lines:
                self.add_box('Warnings', warning_lines)

            # Show notes if any
            note_lines = self._build_note_lines(status.get('notes', []))
            if note_lines:
                self.add_box('Notes', note_lines)
        else:
            # Fallback for empty status
            self.add_box('Status', ['No status available'])

        # Render the complete display
        self.draw()

    def _build_pipeline_lines(self, status: Dict[str, Any]) -> List[str]:
        """
        Build pipeline status lines.

        Creates formatted display lines for core pipeline information including
        name, status message, state, timing, and processing statistics.

        Args:
            status: Task status dictionary

        Returns:
            List[str]: Formatted lines for pipeline status display

        Information Displayed:
            - Pipeline name and current status message
            - Current execution state with color coding
            - Start time and elapsed duration
            - Processing statistics (counts, sizes, rates)
        """
        lines = []

        # Pipeline name with spacing
        if status.get('name'):
            lines.extend([status['name'], ''])

        # Status message with spacing
        if status.get('status'):
            lines.extend([status['status'], ''])

        # Current state with color coding
        state = status.get('state', 0)
        state_name, state_color = self._get_state_display(state)
        lines.append(f'State: {state_color}{state_name}{ANSI_RESET}')

        # Timing information
        start_time = status.get('startTime', 0)
        if start_time > 0:
            # Format start time for display
            start_str = datetime.fromtimestamp(start_time).strftime('%Y-%m-%d %H:%M:%S')
            lines.append(f'Started: {start_str}')

            # Calculate and display elapsed time
            end_time = status.get('endTime', 0) if status.get('completed', False) else None
            duration = format_duration(start_time, end_time)
            lines.append(f'Elapsed: {duration}')

        # Processing statistics if available
        if self._has_count_data(status):
            lines.append('')  # Add spacing before statistics

            # Show total, completed, and failed statistics
            for key_base, label in [('total', 'Total'), ('completed', 'Completed'), ('failed', 'Failed')]:
                count = status.get(f'{key_base}Count', 0)
                size = status.get(f'{key_base}Size', 0)
                if count > 0 or size > 0:
                    lines.append(f'{label}: {count} items ({format_size(size)})')

            # Show processing rates if available
            rate_size = status.get('rateSize', 0)
            rate_count = status.get('rateCount', 0)
            if rate_size > 0 or rate_count > 0:
                lines.append(f'Rate: {format_size(rate_size)}/s ({rate_count}/s items)')

        return lines or ['No pipeline data available']

    def _build_metrics_lines(self, status: Dict[str, Any]) -> List[str]:
        """
        Build metrics lines.

        Creates formatted display lines for custom metrics data,
        filtering out zero values and formatting keys for readability.

        Args:
            status: Task status dictionary

        Returns:
            List[str]: Formatted lines for metrics display, empty if no metrics

        Formatting Features:
            - Converts underscore-separated keys to title case
            - Filters out zero values for cleaner display
            - Formats numeric values appropriately
        """
        # Skip if no meaningful metrics data
        if not self._has_metrics_data(status):
            return []

        lines = []
        metrics = status.get('metrics', {})

        # Format each metric with non-zero values
        for key, value in metrics.items():
            if isinstance(value, (int, float)) and value > 0:
                # Convert underscore-separated keys to title case
                label = key.replace('_', ' ').title()
                lines.append(f'{label}: {value}')

        return lines

    def _build_error_lines(self, items: List[str], error_type: str) -> List[str]:
        """
        Build error/warning lines.

        Formats error and warning messages for display with appropriate
        colors and structured parsing of error format.

        Args:
            items: List of error/warning strings
            error_type: 'Error' or 'Warning' for color selection

        Returns:
            List[str]: Formatted lines for error display

        Error Format Parsing:
            - Structured format: type*message*file_info
            - Extracts error type, message, and file information
            - Provides fallback for unstructured messages
            - Limits display to most recent 5 items
        """
        if not items:
            return []

        lines = []
        # Choose color based on error type
        color = ANSI_RED if error_type == 'Error' else ANSI_YELLOW

        # Show only the most recent 5 items to avoid overwhelming display
        for item in items[-5:]:
            # Parse structured error format: type*message*file_info
            parts = item.split('*')
            if len(parts) >= 3:
                err_type = parts[0].strip()
                message = parts[1].replace('`', '').strip()  # Remove backticks
                file_info = parts[2].strip()

                # Extract just filename from full path
                filename = (
                    file_info.split('\\')[-1].split('/')[-1] if ('\\' in file_info or '/' in file_info) else file_info
                )

                # Format as type: message with filename on next line
                lines.append(f'{color}{err_type}{ANSI_RESET}: {message}')
                if filename:
                    lines.append(f'  -> {filename}')
            else:
                # Fallback for unstructured error messages
                lines.append(f'{color}• {ANSI_RESET} {item}')

        return lines

    def _build_note_lines(self, items: List[str]) -> List[str]:
        """
        Build note lines.

        Formats informational notes for display as simple bullet points.

        Args:
            items: List of note strings

        Returns:
            List[str]: Formatted lines for notes display

        Formatting:
            - Simple bullet point format
            - Shows only recent notes (last 5)
            - Clean, minimal presentation
        """
        if not items:
            return []

        # Format as bullet points, showing only recent notes
        return [f'• {item}' for item in items[-5:]]
