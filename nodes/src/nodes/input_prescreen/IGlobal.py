# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Global lifecycle for the Static Input Pre-Screen node."""

from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config

from .models import HeuristicRule, PreScreenConfig


class IGlobal(IGlobalBase):
    config: PreScreenConfig = None
    heuristic_engine = None
    nonce_fencer = None

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        import os
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        # Load configuration from .pipe JSON
        raw = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig) or {}

        config = PreScreenConfig()
        config.block_ignore_instructions = bool(raw.get('block_ignore_instructions', True))
        config.enable_nonce_fencing = bool(raw.get('enable_nonce_fencing', True))

        # Validate nonce_length: min 16, max 128
        nonce_length = raw.get('nonce_length', 16)
        if not isinstance(nonce_length, int) or nonce_length < 16:
            warning(f"[PreScreen] nonce_length must be integer >= 16, got {nonce_length!r}; using 16")
            nonce_length = 16
        elif nonce_length > 128:
            warning(f"[PreScreen] nonce_length must be <= 128, got {nonce_length}; using 128")
            nonce_length = 128
        config.nonce_length = nonce_length

        # Validate policy_mode
        policy_mode = raw.get('policy_mode', 'block')
        if policy_mode not in ('block', 'warn', 'log'):
            warning(f"[PreScreen] Unrecognized policy_mode '{policy_mode}'; defaulting to 'block'")
            policy_mode = 'block'
        config.policy_mode = policy_mode

        config.custom_rules = raw.get('custom_rules', [])
        config.max_input_length = int(raw.get('max_input_length', 0))

        self.config = config

        # Initialize heuristic engine with built-in + custom rules
        from .heuristic_engine import HeuristicRuleset, BUILTIN_RULES

        rules = list(BUILTIN_RULES)

        # Add custom rules from config
        for i, rule_def in enumerate(config.custom_rules):
            if not isinstance(rule_def, dict):
                continue
            rule = HeuristicRule(
                id=rule_def.get('id', f'custom_{i}'),
                pattern=rule_def.get('pattern', ''),
                category=rule_def.get('category', 'custom'),
                severity=rule_def.get('severity', 'high'),
                description=rule_def.get('description', 'Custom rule'),
                enabled=rule_def.get('enabled', True),
            )
            rules.append(rule)

        self.heuristic_engine = HeuristicRuleset(rules)
        self.heuristic_engine.compile()

        # Initialize nonce fencer
        from .nonce_fencer import NonceFencer

        self.nonce_fencer = NonceFencer(nonce_length=config.nonce_length)

    def endGlobal(self):
        self.heuristic_engine = None
        self.nonce_fencer = None
        self.config = None
