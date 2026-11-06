# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config
from .nonce_fencer import NonceFencer


class IGlobal(IGlobalBase):
    config = None
    engine = None
    nonce_fencer = None

    def beginGlobal(self):
        """Initialize the guardrails engine and optional nonce fencer."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        import os
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)
        self.config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        from .guardrails_engine import GuardrailsEngine

        self.engine = GuardrailsEngine(self.config)
        if self.config.get('enable_nonce_fencing', False):
            nonce_length = self.config.get('nonce_length', 16)
            if (
                not isinstance(nonce_length, int)
                or isinstance(nonce_length, bool)
                or nonce_length < 16
            ):
                warning(f'[Guardrails] nonce_length must be integer >= 16, got {nonce_length!r}; using 16')
                nonce_length = 16
            elif nonce_length > 128:
                warning(f'[Guardrails] nonce_length must be <= 128, got {nonce_length}; using 128')
                nonce_length = 128
            self.nonce_fencer = NonceFencer(nonce_length=nonce_length)

    def endGlobal(self):
        """Release guardrails resources."""
        self.engine = None
        self.nonce_fencer = None
        self.config = None
