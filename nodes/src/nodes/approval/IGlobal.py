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

"""Global state for the human-in-the-loop approval node.

Loaded once per pipeline run. Reads timeout, profile, and notifier configuration
from the node's config; surfaces invalid values as errors instead of silently
falling back to defaults (a known issue from PR #542's review).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from rocketlib import IGlobalBase, OPEN_MODE, debug

from ai.approvals import (
    ApprovalManager,
    ApprovalNotifier,
    NotifierConfig,
    TimeoutAction,
    get_manager,
)


_VALID_PROFILES = {'auto', 'manual', 'custom'}
_DEFAULT_TIMEOUT_SECONDS = 300.0
_DEFAULT_PENDING_CAP = 1000


class IGlobal(IGlobalBase):
    """Per-pipeline configuration for the approval node."""

    config: Dict[str, Any]
    profile: str
    timeout_seconds: float
    timeout_action: TimeoutAction
    pending_cap: int
    notifier: Optional[ApprovalNotifier]
    manager: Optional[ApprovalManager]

    def beginGlobal(self) -> None:
        """Load and validate config; resolve the shared ApprovalManager.

        Validation errors are raised so the pipeline fails fast with a clear
        message rather than silently behaving as if a default were intended.
        """
        # Defaults — also used in CONFIG mode where no actual data flows.
        self.config = {}
        self.profile = 'auto'
        self.timeout_seconds = _DEFAULT_TIMEOUT_SECONDS
        self.timeout_action = TimeoutAction.REJECT
        self.pending_cap = _DEFAULT_PENDING_CAP
        self.notifier = None
        self.manager = None

        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        config = dict(self.glb.connConfig or {})
        self.config = config

        profile = config.get('profile', 'auto')
        if profile not in _VALID_PROFILES:
            raise ValueError(f'approval node: profile must be one of {sorted(_VALID_PROFILES)}; got {profile!r}')
        self.profile = profile

        timeout_seconds = config.get('timeout_seconds', _DEFAULT_TIMEOUT_SECONDS)
        try:
            timeout_seconds = float(timeout_seconds)
        except (TypeError, ValueError) as exc:
            raise ValueError(f'approval node: timeout_seconds must be a number; got {timeout_seconds!r}') from exc
        if timeout_seconds <= 0:
            raise ValueError(f'approval node: timeout_seconds must be positive; got {timeout_seconds}')
        self.timeout_seconds = timeout_seconds

        # parse() raises on unknown values — replaces PR #542's silent fallback.
        self.timeout_action = TimeoutAction.parse(config.get('timeout_action', 'reject'))

        pending_cap = config.get('pending_cap', _DEFAULT_PENDING_CAP)
        try:
            pending_cap = int(pending_cap)
        except (TypeError, ValueError) as exc:
            raise ValueError(f'approval node: pending_cap must be an integer; got {pending_cap!r}') from exc
        if pending_cap <= 0:
            raise ValueError(f'approval node: pending_cap must be positive; got {pending_cap}')
        self.pending_cap = pending_cap

        self.notifier = self._build_notifier(config)
        self.manager = get_manager()
        debug(f'approval node ready: profile={self.profile} timeout={self.timeout_seconds}s timeout_action={self.timeout_action.value} pending_cap={self.pending_cap}')

    def endGlobal(self) -> None:
        """Drop references; no other resources to clean up."""
        self.notifier = None
        self.manager = None

    def _build_notifier(self, config: Dict[str, Any]) -> ApprovalNotifier:
        """Construct an ApprovalNotifier from config, honoring the profile.

        The ``manual`` profile no longer hides ``webhook_url`` — that was a
        UI-side bug PR #542 reviewers flagged (config masking).
        """
        log_enabled = bool(config.get('log_channel_enabled', True))
        webhook_url = config.get('webhook_url') or None
        webhook_timeout = float(config.get('webhook_timeout_seconds', 5.0))
        webhook_headers = dict(config.get('webhook_headers') or {})
        allow_private = bool(config.get('allow_private_webhook_hosts', False))

        notifier_config = NotifierConfig(
            log_channel_enabled=log_enabled,
            webhook_url=webhook_url,
            webhook_timeout_seconds=webhook_timeout,
            webhook_headers=webhook_headers,
            allow_private_webhook_hosts=allow_private,
        )
        return ApprovalNotifier(notifier_config)
