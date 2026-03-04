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
Display Utilities for Terminal Management.

This module provides essential utilities for terminal display management including
size detection, terminal type checking, screen clearing, and cursor positioning.
Use these functions to create responsive terminal applications that adapt to
different terminal environments and provide consistent display behavior.

The utilities handle cross-platform terminal operations with fallback mechanisms
for environments where standard terminal operations may not be available or
may behave differently than expected.

Key Features:
    - Robust terminal size detection with fallback handling
    - Terminal type detection for appropriate display strategies
    - Cross-platform screen clearing and cursor management
    - Safe operation in non-terminal environments
    - Consistent behavior across different terminal types

Usage:
    width, height = detect_terminal_size()
    if is_terminal():
        clear_screen()
        cursor_home()

Components:
    Terminal detection, size management, and display control functions
"""

import os
import sys
from .colors import ANSI_CLEAR_SCREEN, ANSI_CURSOR_HOME


def detect_terminal_size() -> tuple[int, int]:
    """
    Detect terminal size with fallback.

    Determines the current terminal window size using the most reliable
    method available, with validation and fallback to sensible defaults
    when detection fails or returns invalid values.

    Returns:
        tuple[int, int]: (width, height) of terminal in characters

    Detection Strategy:
        1. Use os.get_terminal_size() for accurate current size
        2. Validate returned values are within reasonable ranges
        3. Apply safety margins to prevent edge cases
        4. Fall back to standard 80x24 equivalent if detection fails

    Size Constraints:
        - Width: 20-300 characters (adjusted down by 1 for safety)
        - Height: 10-100 lines (adjusted down by 2 for command area)
        - Fallback: 79x41 characters for compatibility
    """
    try:
        size = os.get_terminal_size()
        width, height = size.columns, size.lines

        if 20 <= width <= 300 and 10 <= height <= 100:
            return max(width - 1, 20), max(height - 2, 10)
    except Exception:
        pass

    return 79, 41  # Default fallback


def is_terminal() -> bool:
    """
    Check if running in actual terminal.

    Determines whether the application is running in a real terminal
    environment that supports interactive display operations.

    Returns:
        bool: True if running in a terminal with interactive capabilities

    Detection Method:
        Checks both stdout and stderr for TTY capability to ensure
        the environment supports interactive terminal operations
        including color display and cursor control.

    Usage:
        Use this function to conditionally enable terminal-specific
        features like colors, cursor positioning, and screen clearing
        while maintaining compatibility with non-terminal environments.
    """
    return sys.stdout.isatty() and sys.stderr.isatty()


def clear_screen():
    """
    Clear the terminal screen.

    Sends ANSI escape sequence to clear the entire terminal screen
    and prepare for fresh content display.

    Usage:
        Call this function to clear the terminal screen before
        displaying new content. Uses standard ANSI escape sequences
        for broad terminal compatibility.

    Behavior:
        - Immediately flushes output to ensure clearing takes effect
        - Works with most ANSI-compatible terminals
        - Safe to call in non-terminal environments (no-op)
    """
    print(ANSI_CLEAR_SCREEN, end='', flush=True)


def cursor_home():
    """
    Move cursor to top-left.

    Positions the terminal cursor at the top-left corner (1,1)
    for consistent rendering start position.

    Usage:
        Call this function before rendering content to ensure
        consistent positioning regardless of previous cursor location.
        Commonly used after screen clearing operations.

    Behavior:
        - Immediately flushes output to ensure positioning takes effect
        - Uses standard ANSI cursor positioning sequences
        - Safe to call in non-terminal environments (no-op)
    """
    print(ANSI_CURSOR_HOME, end='', flush=True)
