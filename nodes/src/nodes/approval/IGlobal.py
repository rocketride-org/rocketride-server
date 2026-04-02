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
# This class controls the data shared between all threads for the approval node.
# It creates the shared ApprovalManager and ApprovalNotifier instances used by
# every IInstance.
# ------------------------------------------------------------------------------

from rocketlib import IGlobalBase
from ai.common.config import Config

from .approval_manager import ApprovalManager
from .notifier import ApprovalNotifier


class IGlobal(IGlobalBase):
    approval_manager: ApprovalManager = None
    notifier: ApprovalNotifier = None
    auto_approve: bool = False

    def beginGlobal(self) -> None:
        # Read this node's merged profile configuration
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        try:
            timeout_seconds = int(config.get('timeout_seconds', 3600))
            if timeout_seconds < 0:
                timeout_seconds = 3600
        except (TypeError, ValueError):
            timeout_seconds = 3600
        timeout_action = config.get('timeout_action', 'approve')
        notification_type = config.get('notification_type', 'log')
        webhook_url = config.get('webhook_url', None)
        self.auto_approve = bool(config.get('auto_approve', False))
        require_comment = bool(config.get('require_comment', False))

        # Shared manager -- one per pipeline lifetime
        self.approval_manager = ApprovalManager(
            timeout_seconds=timeout_seconds,
            timeout_action=timeout_action,
            require_comment=require_comment,
        )

        # Shared notifier
        self.notifier = ApprovalNotifier(
            notification_type=notification_type,
            webhook_url=webhook_url if notification_type == 'webhook' else None,
        )

    def endGlobal(self) -> None:
        self.approval_manager = None
        self.notifier = None
