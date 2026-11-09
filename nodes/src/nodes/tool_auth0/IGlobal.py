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

"""Shared configuration and lifecycle for the Auth0 tool node."""

from pathlib import Path

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .auth0_client import Auth0Client, validate_config


class IGlobal(IGlobalBase):
    """Hold one client shared by the node's tool instances."""

    client = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return
        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        validate_config(cfg)
        from depends import depends

        depends(str(Path(__file__).parent / 'requirements.txt'))
        self.client = Auth0Client(cfg)

    def validateConfig(self) -> None:
        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        try:
            validate_config(cfg)
        except ValueError as exc:
            warning(str(exc))

    def endGlobal(self) -> None:
        if self.client is not None:
            self.client.close()
        self.client = None
