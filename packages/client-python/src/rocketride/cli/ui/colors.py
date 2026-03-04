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
ANSI Color and Display Constants for Terminal Applications.

This module provides ANSI escape sequence constants for terminal color formatting,
cursor control, and Unicode box drawing characters. Use these constants to create
consistent, professional-looking terminal interfaces with color-coded status
indicators, formatted displays, and visual elements.

The constants are organized into logical groups for colors, cursor control, and
visual characters to support comprehensive terminal UI development with
consistent styling and behavior across different display components.

Key Features:
    - Standard ANSI color codes for consistent color schemes
    - Terminal cursor control sequences for screen management
    - Unicode box drawing characters for professional borders
    - Progress indicator characters for visual feedback
    - Status symbols for success/failure indication

Usage:
    from colors import ANSI_GREEN, ANSI_RED, CHR_CHECK
    print(f"{ANSI_GREEN}Success{ANSI_RESET}")

Components:
    Color constants, cursor control sequences, and visual characters
"""

# ANSI Color Codes
ANSI_RESET = '\033[0m'
ANSI_RED = '\033[91m'
ANSI_GREEN = '\033[92m'
ANSI_YELLOW = '\033[93m'
ANSI_BLUE = '\033[94m'
ANSI_GRAY = '\033[90m'

# ANSI Cursor Control
ANSI_CLEAR_SCREEN = '\033[2J'
ANSI_CURSOR_HOME = '\033[1;1H'

# Box Drawing Characters
CHR_TL = '┌'
CHR_TR = '┐'
CHR_BL = '└'
CHR_BR = '┘'
CHR_HORIZ = '─'
CHR_VERT = '│'
CHR_BLOCK = '█'
CHR_LIGHT_BLOCK = '░'
CHR_CHECK = '✓'
CHR_CROSS = '✗'
