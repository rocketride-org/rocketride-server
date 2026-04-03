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

# ------------------------------------------------------------------------------
# This class controls the data shared between all threads for the router node.
# It creates and holds the ModelRouter instance that is shared across all
# pipeline instances.
# ------------------------------------------------------------------------------

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    # Holds the shared ModelRouter instance
    router = None

    def validateConfig(self, syntaxOnly: bool) -> None:
        """Validate the routing configuration.

        When syntaxOnly is True, only lightweight checks are performed
        (e.g. verifying the strategy name). Expensive validation such as
        parsing fallback model lists is skipped.

        Checks that the strategy is one of the known routing strategies
        and that fallback_chain strategy has at least one fallback model.
        """
        from rocketlib.error import APERR, Ec

        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        strategy = config.get('strategy', 'complexity')

        valid_strategies = {'complexity', 'cost_aware', 'latency', 'fallback_chain', 'ab_test'}
        if strategy not in valid_strategies:
            raise APERR(Ec.InvalidParam, f'Invalid routing strategy "{strategy}". Must be one of: {", ".join(sorted(valid_strategies))}')

        budget_limit = float(config.get('budget_limit', 0.0))
        if budget_limit < 0:
            raise APERR(Ec.InvalidParam, f'budget_limit must be >= 0, got {budget_limit}')

        complexity_threshold = int(config.get('complexity_threshold', 50))
        if complexity_threshold < 1:
            raise APERR(Ec.InvalidParam, f'complexity_threshold must be >= 1, got {complexity_threshold}')

        ab_split_percent = int(config.get('ab_split_percent', 50))
        if not (0 <= ab_split_percent <= 100):
            raise APERR(Ec.InvalidParam, f'ab_split_percent must be between 0 and 100, got {ab_split_percent}')

        if syntaxOnly:
            return

        if strategy == 'fallback_chain':
            fallback_raw = config.get('fallback_models', '')
            if isinstance(fallback_raw, str):
                models = [m.strip() for m in fallback_raw.split(',') if m.strip()]
            elif isinstance(fallback_raw, list):
                models = [m.strip() for m in fallback_raw if m.strip()]
            else:
                models = []
            if not models:
                raise APERR(Ec.InvalidParam, 'fallback_chain strategy requires at least one model in fallback_models')

        if strategy == 'ab_test':
            primary_model = config.get('primary_model', 'claude-sonnet')
            fallback_raw = config.get('fallback_models', '')
            if isinstance(fallback_raw, str):
                fallback_list = [m.strip() for m in fallback_raw.split(',') if m.strip()]
            elif isinstance(fallback_raw, list):
                fallback_list = [m.strip() for m in fallback_raw if m.strip()]
            else:
                fallback_list = []
            distinct = [m for m in fallback_list if m != primary_model]
            if not distinct:
                raise APERR(Ec.InvalidParam, 'ab_test strategy requires at least one fallback model that differs from primary_model for meaningful A/B testing')

    def beginGlobal(self) -> None:
        """Initialize the ModelRouter with the node configuration."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # Configuration mode - no need to create the router
            pass
        else:
            from .router import ModelRouter

            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            self.router = ModelRouter(config)

    def endGlobal(self) -> None:
        """Release the router instance."""
        self.router = None
