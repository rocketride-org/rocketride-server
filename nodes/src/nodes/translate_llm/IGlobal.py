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

from rocketlib import IGlobalBase
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """Global state for the LLM Translate node.

    Reads translation configuration from the pipeline profile and exposes it
    to all IInstance objects. No external SDK is initialised here — the LLM is
    reached through the RocketRide invoke channel wired in the UI.
    """

    target_language: str = 'en'
    source_language: str = ''
    style: str = 'standard'
    custom_prompt: str = ''

    def beginGlobal(self) -> None:
        """Load translation configuration from the active profile.

        Returns:
            None.
        """
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.target_language = config.get('targetLanguage') or 'en'
        self.source_language = config.get('sourceLanguage') or ''
        self.style = config.get('style') or 'standard'
        self.custom_prompt = config.get('customPrompt') or ''

    def endGlobal(self) -> None:
        """Clean up global state.

        Returns:
            None.
        """
        pass
