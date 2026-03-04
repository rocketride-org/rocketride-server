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
Box UI Component for Terminal Display.

This module provides the Box class for creating bordered content areas with
titles in terminal applications. Use this component to display organized
information sections with visual borders, title headers, and proper text
formatting for enhanced readability and professional appearance.

The Box component handles Unicode box drawing characters, ANSI color codes,
text truncation, padding, and proper visual length calculation for complex
text content including multi-byte characters and escape sequences.

Key Features:
    - Professional bordered box display with Unicode drawing characters
    - Title integration in box borders for clear content identification
    - ANSI color code support with proper visual length calculation
    - Unicode character width handling for international text
    - Automatic text truncation and padding for consistent layout
    - Configurable width with responsive content formatting

Usage:
    box = Box("Status", ["Line 1", "Line 2"], width=80)
    rendered_lines = box.render()

Components:
    Box: Single bordered content area with title and formatted content
"""

import re
import unicodedata
from typing import List
from .colors import CHR_TL, CHR_TR, CHR_BL, CHR_BR, CHR_HORIZ, CHR_VERT

ANSI_ESCAPE_PATTERN = re.compile(r'\x1b\[[0-9;]*[mK]')


class Box:
    """
    A single box display with title and content lines.

    Creates a bordered content area with integrated title display using
    Unicode box drawing characters. Handles complex text formatting including
    ANSI color codes, Unicode characters, and automatic content fitting.

    Example:
        ```python
        # Create a status box
        box = Box('Pipeline Status', ['State: Running', 'Files processed: 150', 'Errors: 0'], width=60)

        # Render to terminal
        for line in box.render():
            print(line)
        ```

    Visual Output:
        ┌─ Pipeline Status ─────────────┐
        │ State: Running                │
        │ Files processed: 150          │
        │ Errors: 0                     │
        └───────────────────────────────┘

    Key Features:
        - Unicode box drawing characters for professional appearance
        - Title integration within top border for clean design
        - ANSI color code preservation with proper width calculation
        - Multi-byte Unicode character support for international content
        - Automatic text truncation for content that exceeds box width
        - Consistent padding and alignment for visual consistency
    """

    def __init__(self, title: str, lines: List[str], width: int = 75):
        """
        Initialize Box with title, content lines, and width.

        Set up the box component with content and display parameters
        for rendering bordered content areas.

        Args:
            title: Title to display in the box header
            lines: Content lines to display within the box
            width: Total width of the box including borders

        Usage:
            Creates a box with the specified content and formatting
            parameters. The width includes borders, so content area
            is slightly smaller than the total width.
        """
        self.title = title
        self.lines = lines or []
        self.width = width

    def _visual_length(self, text: str) -> int:
        """
        Calculate visual length accounting for ANSI codes and Unicode.

        Computes the actual display width of text by removing ANSI escape
        sequences and properly handling Unicode character widths.

        Args:
            text: Text string to measure

        Returns:
            int: Visual width of the text when displayed

        Handling:
            - Removes ANSI escape sequences (colors, formatting)
            - Counts wide Unicode characters (East Asian) as 2 characters
            - Ignores combining characters that don't add width
            - Provides accurate measurement for layout calculations
        """
        stripped = ANSI_ESCAPE_PATTERN.sub('', text)

        width = 0
        for char in stripped:
            if unicodedata.east_asian_width(char) in ('F', 'W'):
                width += 2
            elif unicodedata.combining(char):
                width += 0
            else:
                width += 1

        return width

    def _box_top(self) -> str:
        """
        Create top of box with title.

        Generates the top border line with integrated title display
        using Unicode box drawing characters.

        Returns:
            str: Formatted top border line with title

        Format:
            ┌─ Title ─────────────────────┐
            - Top-left corner, horizontal line, title, remaining horizontal line, top-right corner
        """
        title_part = f' {self.title} '
        remaining_width = (self.width - 3) - len(title_part)
        return CHR_TL + CHR_HORIZ + title_part + (CHR_HORIZ * remaining_width) + CHR_TR

    def _box_middle(self, content: str) -> str:
        """
        Create middle line of box with proper padding.

        Formats content lines with borders and proper padding to fit
        within the box width while preserving ANSI formatting.

        Args:
            content: Text content for this line

        Returns:
            str: Formatted line with borders and padding

        Format:
            │ Content text with padding    │
            - Vertical border, space, content, padding, vertical border
        """
        visual_width = self._visual_length(content)
        available_width = self.width - 3

        if visual_width > available_width:
            content = content[: available_width - 3] + '...'
            visual_width = self._visual_length(content)

        padding = available_width - visual_width
        return CHR_VERT + ' ' + content + (' ' * max(0, padding)) + CHR_VERT

    def _box_bottom(self) -> str:
        """
        Create bottom of box.

        Generates the bottom border line using Unicode box drawing characters.

        Returns:
            str: Formatted bottom border line

        Format:
            └───────────────────────────────┘
            - Bottom-left corner, horizontal line, bottom-right corner
        """
        return CHR_BL + (CHR_HORIZ * (self.width - 2)) + CHR_BR

    def render(self) -> List[str]:
        """
        Render the box to a list of formatted lines.

        Generates the complete box display including top border with title,
        content lines with proper formatting, and bottom border.

        Returns:
            List[str]: Complete rendered box as list of terminal lines

        Usage:
            Call this method to get the final rendered output that can
            be printed to the terminal. Returns empty list if no content
            lines are available for display.
        """
        if not self.lines:
            return []

        output = [self._box_top()]
        for line in self.lines:
            output.append(self._box_middle(line))
        output.append(self._box_bottom())
        return output
