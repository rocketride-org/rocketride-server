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
Real-time Event Monitor for RocketRide CLI.

This module provides the EventsMonitor class for displaying live DAP events with
detailed formatting, timestamp tracking, and scrollable event history. Use this
monitor to view real-time events in a structured, chronological display with
color-coded event types and comprehensive event data visualization.

The events monitor creates a live scrolling display of all incoming events with
structured data presentation, automatic history management, and visual formatting
for enhanced readability and analysis.

Key Features:
    - Real-time live event display with timestamps
    - Structured columnar data formatting for event details
    - Automatic scrolling with configurable history limits
    - Color-coded event types for visual distinction
    - Intelligent space management for terminal display
    - Event correlation and indexing for analysis

Usage:
    monitor = EventsMonitor(cli, token, event_types)
    monitor.display_events(events_log, total_received)

Components:
    EventsMonitor: Real-time event monitor with structured display
"""

from .base import BoxMonitor
from typing import List, Dict, Any
from ..ui.colors import ANSI_BLUE, ANSI_GREEN, ANSI_RESET


class EventsMonitor(BoxMonitor):
    """
    Real-time event monitor for displaying all incoming events.

    Provides live monitoring and display of DAP events with detailed formatting,
    timestamp tracking, and scrollable event history. Shows events in reverse
    chronological order with structured display of event data.

    Example:
        ```python
        # Create events monitor for a specific task
        monitor = EventsMonitor(cli, task_token, 'SUMMARY,OUTPUT')

        # Display current events with total count
        monitor.display_events(events_log, total_received=50)
        ```

    Key Features:
        - Live event streaming with timestamp precision
        - Structured display of complex event data
        - Automatic history pruning to prevent memory issues
        - Columnar formatting for nested event properties
        - Color-coded event types and status indicators
        - Terminal space optimization for maximum event visibility
    """

    def __init__(self, cli, token: str, event_types: int, width: int = None, height: int = None):
        """
        Initialize EventsMonitor with CLI context, token, event types, and terminal dimensions.

        Set up the monitor for displaying events from a specific task with
        the specified event type filters and terminal display configuration.

        Args:
            cli: CLI instance for access to cancellation state and events
            token: Task token being monitored for events
            event_types: Bitmask of event types being monitored
            width: Terminal width override (None for auto-detect)
            height: Terminal height override (None for auto-detect)
        """
        super().__init__(cli, 'RocketRide Event Monitor', width, height)

        # Store monitoring configuration
        self.token = token
        self.event_types = event_types

        # Set initial status display
        self.set_command_status([f'Token: {self.token}', f'Event Types: {self.event_types}'])

    def display_events(self, events_log: List[Dict[str, Any]], total_received: int = 0) -> None:
        """
        Display the events in a full-screen box.

        Creates a scrollable display of recent events with formatting for
        readability, showing events in chronological order with
        structured display of event data and automatic truncation.

        Args:
            events_log: List of event entries with timestamps and data
            total_received: Total number of events received (for display stats)

        Display Features:
            - Events shown in chronological order (oldest to newest)
            - Automatic fitting of complete events within available space
            - Partial event display when space is limited
            - Event indexing and timestamp display
            - Structured columnar formatting for event data
            - Visual indicators for truncated event lists
        """
        self.clear()

        # Calculate available space for events (reserve space for command status)
        command_box_lines = 8
        available_height = max(self.height - command_box_lines, 10)

        event_lines = []

        if not events_log:
            # Show placeholder when no events received yet
            event_lines = ['No events received yet...']
        else:
            # Work backwards from newest event, fitting complete events
            events_to_display = []
            lines_used = 0

            # Start from the newest event and work backwards
            for i in range(len(events_log) - 1, -1, -1):
                event_entry = events_log[i]

                # Calculate how many lines this event will take
                event_line_count = 1  # Header line

                # Count body lines
                if 'body' in event_entry['message']:
                    body = event_entry['message']['body']
                    if isinstance(body, dict):
                        # Calculate columnar lines for this event
                        temp_columnar_lines = self._format_dict_as_columns(body)
                        event_line_count += len(temp_columnar_lines)
                    else:
                        event_line_count += 1  # Single line for non-dict body
                else:
                    event_line_count += 1  # Single line for fallback

                event_line_count += 1  # Spacing line after event

                # Check if we have room for this complete event
                if lines_used + event_line_count <= available_height:
                    events_to_display.insert(0, event_entry)  # Insert at beginning
                    lines_used += event_line_count
                else:
                    # Try to fit partial event if this is the first one we can't fit
                    if len(events_to_display) > 0:
                        # We have some complete events, try to partially show this one
                        remaining_lines = available_height - lines_used
                        if remaining_lines > 1:  # Need at least header line
                            events_to_display.insert(0, {'partial': True, 'remaining_lines': remaining_lines, **event_entry})
                    break

            # Now format the events we can display (oldest to newest)
            for event_entry in events_to_display:
                timestamp = event_entry['timestamp']
                message = event_entry['message']
                index = event_entry['index']
                is_partial = event_entry.get('partial', False)
                remaining_lines = event_entry.get('remaining_lines', 0)

                # Format event header with timestamp, index, and type
                event_type = message.get('event', 'unknown')
                header_line = f'{ANSI_BLUE}[{timestamp}]{ANSI_RESET} Event {index}: {ANSI_GREEN}{event_type}{ANSI_RESET}'
                event_lines.append(header_line)

                lines_added = 1

                # Format event body data
                if 'body' in message:
                    body = message['body']
                    if isinstance(body, dict):
                        # Create columnar display for dictionary fields
                        columnar_lines = self._format_dict_as_columns(body)

                        if is_partial:
                            # Only show what fits in remaining lines (minus 1 for spacing)
                            lines_to_show = min(len(columnar_lines), remaining_lines - 1)
                            event_lines.extend(columnar_lines[:lines_to_show])
                            lines_added += lines_to_show
                        else:
                            event_lines.extend(columnar_lines)
                            lines_added += len(columnar_lines)
                    else:
                        # Fallback for non-dict body
                        if not is_partial or remaining_lines > 1:
                            msg_str = str(body)
                            if len(msg_str) > 80:
                                msg_str = msg_str[:77] + '...'
                            event_lines.append(f'  {msg_str}')
                            lines_added += 1
                else:
                    # Fallback for events without body structure
                    if not is_partial or remaining_lines > 1:
                        msg_str = str(message)
                        if len(msg_str) > 80:
                            msg_str = msg_str[:77] + '...'
                        event_lines.append(f'  {msg_str}')
                        lines_added += 1

                # Add spacing between events (but not if partial and no room)
                if not is_partial or lines_added < remaining_lines:
                    event_lines.append('')

            # Add indicator showing which events are displayed
            if len(events_to_display) > 0:
                oldest_shown = events_to_display[0]['index']
                newest_shown = events_to_display[-1]['index']

                # Check if we're showing all events or just a subset
                if oldest_shown > 0 or newest_shown < total_received - 1:
                    event_lines.insert(0, f'... (showing events {oldest_shown}-{newest_shown} of {total_received} total)')
                    event_lines.insert(1, '')

        # Display events box
        self.add_box(f'Live Events ({len(events_log)} received)', event_lines)

        # Update command status with current statistics
        self.set_command_status(
            [
                f'Token: {self.token}, Event Types: {self.event_types}, Events received: {total_received}',
            ]
        )

        # Render the complete display
        self.draw()

    def _format_dict_as_columns(self, body: dict) -> List[str]:
        """
        Format dictionary fields into columns with alphabetical sorting.

        Convert event body dictionary into a columnar display format that
        maximizes readability while fitting within terminal constraints.
        Automatically organizes data alphabetically and handles value truncation.

        Args:
            body: Dictionary to format

        Returns:
            List of formatted lines for display

        Formatting Features:
            - Alphabetical key sorting for consistent display
            - Automatic value truncation for long content
            - Column width optimization for terminal space
            - Special handling for nested data structures
            - Dynamic column count based on available width
        """
        # Sort keys alphabetically and format each key-value pair
        formatted_items = []
        for key in sorted(body.keys()):
            value = body[key]

            # Format the value based on its type
            if isinstance(value, (str, int, float, bool)):
                # Truncate long string values for display
                if isinstance(value, str) and len(value) > 60:
                    value_str = value[:57] + '...'
                else:
                    value_str = str(value)
            elif isinstance(value, (list, dict)):
                # Show summary for complex nested data
                if isinstance(value, list):
                    value_str = f'[list with {len(value)} items]'
                else:
                    value_str = f'{{dict with {len(value)} keys}}'
            else:
                value_str = str(value)

            # Create display string with maximum 30 characters
            display_str = f'{key}: {value_str}'
            if len(display_str) > 30:
                # Truncate and ensure we keep the key and some value
                if len(key) < 25:
                    # If key is short enough, truncate the value
                    max_value_len = 30 - len(key) - 5  # 5 for ": " and "..."
                    truncated_value = value_str[:max_value_len] + '...'
                    display_str = f'{key}: {truncated_value}'
                else:
                    # If key is too long, truncate both
                    truncated_key = key[:20] + '...'
                    display_str = f'{truncated_key}: ...'

            formatted_items.append(display_str)

        # Calculate how many columns can fit
        # Available width is roughly self.width - 4 (for box borders and padding)
        # Account for 2 spaces of indentation for event body
        available_width = max(self.width - 6, 40)  # Minimum 40 chars width
        column_width = 30  # Maximum display length per item
        column_spacing = 5  # Spaces between columns

        # Calculate number of columns that fit
        # Formula: n * column_width + (n-1) * spacing <= available_width
        # Solving: n <= (available_width + spacing) / (column_width + spacing)
        max_columns = max(1, (available_width + column_spacing) // (column_width + column_spacing))

        # Distribute items across columns
        total_items = len(formatted_items)
        if total_items == 0:
            return ['  (no data)']

        # Calculate items per column
        base_items_per_col = total_items // max_columns
        extra_items = total_items % max_columns

        # Create column distribution
        columns = []
        start_idx = 0

        for col_idx in range(max_columns):
            # First 'extra_items' columns get one extra item
            items_in_this_col = base_items_per_col + (1 if col_idx < extra_items else 0)

            if items_in_this_col > 0:
                end_idx = start_idx + items_in_this_col
                columns.append(formatted_items[start_idx:end_idx])
                start_idx = end_idx
            else:
                columns.append([])

        # Format columns into lines
        result_lines = []
        max_rows = max(len(col) for col in columns) if columns else 0

        for row_idx in range(max_rows):
            line_parts = []
            for col in columns:
                if row_idx < len(col):
                    # Pad the item to column width for alignment
                    padded_item = col[row_idx].ljust(column_width)
                    line_parts.append(padded_item)
                else:
                    # Empty cell
                    line_parts.append(' ' * column_width)

            # Join columns with spacing and add indentation
            line = '  ' + (' ' * column_spacing).join(line_parts).rstrip()
            result_lines.append(line)

        return result_lines
