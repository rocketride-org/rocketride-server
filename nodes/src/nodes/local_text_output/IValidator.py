# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Local Text Output save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check is the host's path rule.
Linux and Mac have no special characters that are not allowed in paths (the
only one is '/', which is also the separator, so it is up to the user); Windows
refuses a set of characters, and a path carrying one of them fails here.
"""

from sys import platform

from rocketlib import IValidatorBase

#: Characters a Windows path component may not carry ('/' is the wrong separator).
WINDOWS_INVALID_CHARACTERS = ('<', '>', ':', '"', '/', '|', '?', '*')


def windows_path_problem(value: object, what: str) -> str | None:
    """
    Return the message for a Windows path holding a forbidden character, else None.

    Args:
        value: The configured path (anything but a string passes).
        what: What the path is, for the message ('output path', 'exclude path').
    """
    if not isinstance(value, str) or value == 'N/A':
        return None
    if any(char in value for char in WINDOWS_INVALID_CHARACTERS):
        return f'Invalid {what}: {value}'
    return None


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the host path rule."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config and, unless ``syntaxOnly``, the paths for this host.

        Args:
            syntaxOnly (bool): True checks the shape only.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
            Exception: A path carries a character the host refuses.
        """
        config = self.config
        if syntaxOnly or platform != 'win32':
            return
        for value, what in ((config.storePath, 'output path'), (config.exclude, 'exclude path')):
            problem = windows_path_problem(value, what)
            if problem:
                raise Exception(problem)
