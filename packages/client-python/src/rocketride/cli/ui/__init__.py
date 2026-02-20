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
Terminal UI Components for RocketRide CLI.

This module provides components for creating visually appealing terminal displays
including box layouts, ANSI color codes, terminal detection, and rendering utilities.

Components:
    Box: Box drawing and layout management with borders and content formatting
    Colors: ANSI color codes and box-drawing characters for terminal rendering
    Display: Terminal detection, sizing, and screen clearing utilities

Features:
    - Automatic terminal capability detection
    - Box-based layouts with borders and titles
    - ANSI color support with fallback for non-color terminals
    - Unicode box-drawing characters with ASCII fallbacks
    - Terminal size detection and dynamic resizing
    - Screen clearing and cursor positioning
"""

from .box import Box
from .colors import (
    ANSI_RESET,
    ANSI_RED,
    ANSI_GREEN,
    ANSI_YELLOW,
    ANSI_BLUE,
    ANSI_GRAY,
    ANSI_CLEAR_SCREEN,
    ANSI_CURSOR_HOME,
    CHR_TL,
    CHR_TR,
    CHR_BL,
    CHR_BR,
    CHR_HORIZ,
    CHR_VERT,
    CHR_BLOCK,
    CHR_LIGHT_BLOCK,
    CHR_CHECK,
    CHR_CROSS,
)

from .display import detect_terminal_size, is_terminal, clear_screen, cursor_home

__all__ = [
    'Box',
    'ANSI_RESET',
    'ANSI_RED',
    'ANSI_GREEN',
    'ANSI_YELLOW',
    'ANSI_BLUE',
    'ANSI_GRAY',
    'ANSI_CLEAR_SCREEN',
    'ANSI_CURSOR_HOME',
    'CHR_TL',
    'CHR_TR',
    'CHR_BL',
    'CHR_BR',
    'CHR_HORIZ',
    'CHR_VERT',
    'CHR_BLOCK',
    'CHR_LIGHT_BLOCK',
    'CHR_CHECK',
    'CHR_CROSS',
    'detect_terminal_size',
    'is_terminal',
    'clear_screen',
    'cursor_home',
]
