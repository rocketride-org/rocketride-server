# =============================================================================
# RocketRide Engine
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
Skills tool node - global state.

The control holds nothing: the skills and the skills folder are per-call
parameters, and the folder is read through the call's own file store, so the
instance builds the skill catalog from its settings (see ``IInstance``).
"""

import os

from rocketlib import IGlobalBase

from depends import depends

# skill_catalog imports yaml at module scope, and IInstance imports this module
# before it, so the requirements are installed first. This module is only
# imported on the run path (config mode imports the validator alone), so the
# install never runs while a user is merely opening the node's settings panel.
depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')


class IGlobal(IGlobalBase):
    """Nothing per control: the skills are read per call."""
