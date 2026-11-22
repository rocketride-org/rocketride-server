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

"""
Bland AI tool node instance.

Delegates tool invocation to a ``BlandDriver`` built once per call from the
control's account and this call's defaults (voice, maximum duration,
recording, language).
"""

from __future__ import annotations

from typing import Any

from rocketlib import IInstanceBase

from .IGlobal import IGlobal
from .bland_driver import BlandDriver


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    # This call's driver, built on its first invoke
    driver: BlandDriver | None = None

    def _driver(self) -> BlandDriver:
        """
        This call's driver: the control's key and namespace with this call's defaults.

        Returns:
            The driver.

        Raises:
            RuntimeError: The control has no key (it never began).
        """
        if self.driver is None:
            if not getattr(self.IGlobal, 'api_key', ''):
                raise RuntimeError('bland_ai: driver not initialized — check API key configuration')
            settings = self.settings
            self.driver = BlandDriver(
                server_name=self.IGlobal.server_name,
                api_key=self.IGlobal.api_key,
                default_voice=settings.voice,
                max_duration=settings.maxDuration,
                record=settings.record,
                language=settings.language,
            )
        return self.driver

    def invoke(self, param: Any) -> Any:  # noqa: ANN401
        return self._driver().handle_invoke(param)
