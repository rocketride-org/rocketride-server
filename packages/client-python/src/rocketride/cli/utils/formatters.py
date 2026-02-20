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
String Formatting Utilities for RocketRide CLI Display.

This module provides formatting functions for converting raw data into
human-readable display formats. Use these utilities to format file sizes,
time durations, and filenames for consistent, professional display in
terminal interfaces with appropriate units and precision.

The formatting utilities handle edge cases, provide appropriate precision
for different value ranges, and ensure consistent display formatting
across all CLI components for enhanced user experience.

Key Features:
    - Human-readable file size formatting with appropriate units
    - Duration formatting with multiple time units and precision
    - Filename truncation with intelligent path handling
    - Consistent formatting standards across all display components
    - Proper handling of edge cases and zero values

Usage:
    size_str = format_size(1048576)  # "1.0 MB"
    duration_str = format_duration(start, end)  # "2min, 30secs"
    short_name = truncate_filename("very_long_filename.txt", 20)

Components:
    format_size: Convert bytes to human-readable size format
    format_duration: Convert timestamps to readable duration format
    truncate_filename: Intelligently truncate long filenames
"""


def format_size(size_bytes: int) -> str:
    """
    Format byte size in human-readable format.

    Converts raw byte counts into human-readable format using appropriate
    units (B, KB, MB, GB, TB) with proper precision for each unit type.

    Args:
        size_bytes: Size in bytes to format

    Returns:
        str: Formatted size string with appropriate unit

    Format Rules:
        - Bytes: No decimal places (e.g., "1024 B")
        - KB/MB/GB/TB: One decimal place (e.g., "1.5 MB")
        - Zero bytes: "0 B"
        - Uses 1024-based conversion for accurate binary measurements

    Usage:
        ```python
        # Format various sizes
        print(format_size(0))  # "0 B"
        print(format_size(512))  # "512 B"
        print(format_size(1536))  # "1.5 KB"
        print(format_size(2097152))  # "2.0 MB"
        ```
    """
    if size_bytes == 0:
        return '0 B'

    units = ['B', 'KB', 'MB', 'GB', 'TB']
    unit_index = 0
    size = float(size_bytes)

    while size >= 1024 and unit_index < len(units) - 1:
        size /= 1024
        unit_index += 1

    if unit_index == 0:
        return f'{int(size)} {units[unit_index]}'
    else:
        return f'{size:.1f} {units[unit_index]}'


def format_duration(start_time: float, end_time: float = None) -> str:
    """
    Format duration with detailed labels.

    Converts start and end timestamps into human-readable duration format
    with appropriate time units and precision based on duration length.

    Args:
        start_time: Start timestamp (Unix timestamp)
        end_time: End timestamp (Unix timestamp, None for current time)

    Returns:
        str: Formatted duration string with appropriate units

    Format Rules:
        - Less than 1 minute: "30secs"
        - 1-59 minutes: "5min, 30secs"
        - 1+ hours: "2hr, 15min, 30secs"
        - Not started: "Not started"

    Usage:
        ```python
        import time

        start = time.time()
        # ... some processing ...
        duration = format_duration(start)  # Current duration
        duration = format_duration(start, end)  # Specific duration
        ```
    """
    from datetime import datetime

    if start_time == 0:
        return 'Not started'

    if end_time is None or end_time == 0:
        end_time = datetime.now().timestamp()

    total_seconds = int(end_time - start_time)

    if total_seconds < 60:
        return f'{total_seconds}secs'
    elif total_seconds < 3600:
        minutes = total_seconds // 60
        seconds = total_seconds % 60
        return f'{minutes}min, {seconds}secs'
    else:
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        seconds = total_seconds % 60
        return f'{hours}hr, {minutes}min, {seconds}secs'


def truncate_filename(filename: str, max_length: int) -> str:
    """
    Truncate filename to fit specified length.

    Intelligently truncates long filenames while preserving file extensions
    and providing clear indication of truncation for display purposes.

    Args:
        filename: Original filename to truncate
        max_length: Maximum length for truncated filename

    Returns:
        str: Truncated filename with ellipsis indicator

    Truncation Strategy:
        1. If filename fits within max_length, return unchanged
        2. Preserve file extension when possible
        3. Truncate base name and add "..." indicator
        4. If extension is too long, truncate entire filename

    Usage:
        ```python
        # Truncate for display
        short = truncate_filename('very_long_document_name.pdf', 20)
        # Result: "very_long_docu....pdf"

        # Handle very long extensions
        short = truncate_filename('file.very_long_extension', 15)
        # Result: "file.very_lo..."
        ```
    """
    from pathlib import Path

    if len(filename) <= max_length:
        return filename

    path = Path(filename)
    name = path.stem
    ext = path.suffix

    if len(ext) < max_length - 3:
        available = max_length - len(ext) - 3
        return f'{name[:available]}...{ext}'
    else:
        return f'{filename[: max_length - 3]}...'
