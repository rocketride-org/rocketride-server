from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """No per-pipeline state: the probe needs no configuration or dependencies."""

    def beginGlobal(self):
        """Nothing to set up."""
        self.tool_description = ''

    def endGlobal(self):
        """Nothing to release."""
