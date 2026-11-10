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
AI Global Configuration Module.

This module defines the IGlobal class which handles global configuration
for AI processing tasks including text summarization and entity extraction.
"""

import os

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """
    Global configuration class for AI processing tasks.

    This class extends IGlobalBase and manages configuration parameters
    for text analysis operations including summarization, key point extraction,
    and entity recognition. It installs the dependencies and reads the
    resolved node configuration.

    Attributes:
        numberOfTokens (int): Maximum number of tokens per chunk.
    """

    # Number of tokens per chunk; the schema default until beginGlobal runs
    numberOfTokens: int = 384

    def beginGlobal(self) -> None:
        """
        Install the dependencies and read the resolved configuration.

        The schema supplies the default and the lower bound, so the value is
        read as it is.
        """
        from depends import depends  # type: ignore

        requirements_path = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements_path)

        self.numberOfTokens = int(self.config.numberOfTokens)
