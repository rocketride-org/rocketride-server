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
from typing import Optional
from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """Global interface for the Google Translate node."""

    translator: Optional[object] = None

    VALIDATION_TEXT = 'Hi'

    def validateConfig(self):
        """
        Validate configuration at save-time using a minimal API probe.

        Surfaces auth / quota / API-not-enabled errors early as UI warnings
        via `warning(...)`. Does not raise.

        Returns:
            None.
        """
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        try:
            from google.api_core.exceptions import GoogleAPICallError
        except Exception:
            GoogleAPICallError = Exception  # type: ignore
        try:
            from google.auth.exceptions import GoogleAuthError
        except Exception:
            GoogleAuthError = Exception  # type: ignore

        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        apikey = config.get('apikey') or ''
        target = config.get('targetLanguage') or 'en'

        if not apikey:
            # Let the UI prompt for it; no probe needed.
            return

        try:
            from .translate import Translator

            probe = Translator(apikey=apikey, source=None, target=target)
            probe.translate(self.VALIDATION_TEXT)
        except GoogleAuthError as e:
            warning(f'Google Translate auth error: {e}')
        except GoogleAPICallError as e:
            message = getattr(e, 'message', None) or str(e)
            warning(f'Google Translate API error: {message}')
        except Exception as e:
            warning(f'Google Translate validation error: {e}')

    def beginGlobal(self):
        """
        Initialize the Translator instance shared by all pipeline instances.

        Short-circuits when the endpoint is opened in CONFIG mode, since the
        Google SDK is not needed for UI configuration.

        Returns:
            None.
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # UI will call configureService; no SDK needed for that path.
            return

        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        from .translate import Translator

        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        apikey = config.get('apikey') or ''
        source = config.get('sourceLanguage') or ''
        target = config.get('targetLanguage') or 'en'

        self.translator = Translator(apikey=apikey, source=source, target=target)

    def endGlobal(self):
        """
        Release the Translator instance and its underlying Google client.

        Returns:
            None.
        """
        self.translator = None
