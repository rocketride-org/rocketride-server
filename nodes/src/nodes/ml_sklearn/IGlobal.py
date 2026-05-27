# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide Contributors
# =============================================================================
import os
from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """Global state for the ml_sklearn node — holds the loaded sklearn model."""

    preprocessor: object = None

    def validateConfig(self):
        """Validate that scikit-learn and joblib are available."""
        try:
            from depends import depends

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)
        except Exception as e:
            warning(str(e))

    def beginGlobal(self):
        """Load the sklearn model at runtime startup."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            pass
        else:
            from depends import depends

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            from .code import PreProcessor

            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            self.preprocessor = PreProcessor(config)

    def endGlobal(self):
        """Release the sklearn model."""
        self.preprocessor = None
