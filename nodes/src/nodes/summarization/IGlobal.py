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

import os

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    # The four counts; the schema defaults until beginGlobal runs
    numberOfSummaries: int = 2
    numberOfSummaryWords: int = 1500
    numberOfKeyPointWords: int = 250
    numberOfEntities: int = 25

    def beginGlobal(self) -> None:
        """Install the dependencies and read the four counts from the resolved config."""
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        config = self.config
        self.numberOfSummaries = int(config.numberOfSummaries)
        self.numberOfSummaryWords = int(config.numberOfSummaryWords)
        self.numberOfKeyPointWords = int(config.numberOfKeyPointWords)
        self.numberOfEntities = int(config.numberOfEntities)
