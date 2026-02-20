# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
    """
    Global-level class for initializing dependencies required by the node.

    This class is responsible for performing any setup needed when the global context
    is initialized, such as loading external dependencies or configuration files.
    """

    def beginGlobal(self):
        """
        Initialize global context.

        This method loads required Python packages or dependencies specified
        in a 'requirements.txt' file relative to this script’s location.

        Uses the 'depends' module to dynamically ensure all requirements
        are installed before proceeding.

        Raises:
            Any exceptions raised by the 'depends' module if requirements fail to load.
        """
        # Import depends here to delay loading until global initialization
        from depends import depends

        # Build the full path to the requirements.txt file located alongside this script
        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'

        # Load and install dependencies specified in the requirements file
        depends(requirements)
