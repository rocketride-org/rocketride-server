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
# This class controls the per-thread data for the approval node.
#
# For each incoming answer it:
#   1. Creates an approval request via ApprovalManager
#   2. Sends a notification via ApprovalNotifier
#   3. Either auto-approves (forwarding immediately) or attaches approval
#      metadata with 'pending' status so downstream nodes can act on it.
# ------------------------------------------------------------------------------

import copy
import uuid
from rocketlib import IInstanceBase, Entry
from ai.common.schema import Answer
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def open(self, obj: Entry) -> None:
        """Reset per-object state (nothing stateful for this node)."""
        pass

    def writeAnswers(self, answer: Answer) -> None:
        """Process an incoming answer through the approval gate.

        1. Deep-copy the answer so upstream data is never mutated.
        2. Create an approval request from the answer content.
        3. Send a notification via the configured channel.
        4. If auto_approve is enabled, forward immediately with approval metadata.
        5. Otherwise, attach the approval_id and 'pending' status.
        """
        # Deep copy to prevent mutation of the original answer
        answer = copy.deepcopy(answer)

        # Extract a content preview from the answer
        if answer.isJson():
            content = answer.getJson()
        else:
            content = answer.getText()

        # Build a stable item_id using UUID (not memory address which can be reused)
        item_id = str(uuid.uuid4())

        # Create the approval request
        request = self.IGlobal.approval_manager.request_approval(
            item_id=item_id,
            content=content,
            metadata={'source': 'pipeline'},
        )

        approval_id = request['approval_id']

        # Notify via the configured channel
        self.IGlobal.notifier.notify(request)

        # Decide whether to auto-approve or leave pending
        if self.IGlobal.auto_approve:
            # Immediately approve and forward with metadata
            self.IGlobal.approval_manager.approve(approval_id, reviewer='__auto__', comment='Auto-approved by pipeline configuration')

            approved_request = self.IGlobal.approval_manager.get_request(approval_id)

            # Create a new answer carrying the approval metadata
            result = Answer(expectJson=True)
            result.setAnswer(
                {
                    'approval_id': approval_id,
                    'status': 'approved',
                    'reviewer': '__auto__',
                    'content': content,
                    'metadata': approved_request.get('metadata', {}),
                }
            )
            self.instance.writeAnswers(result)
        else:
            # Forward with pending status so downstream nodes know review is needed
            result = Answer(expectJson=True)
            result.setAnswer(
                {
                    'approval_id': approval_id,
                    'status': 'pending',
                    'item_id': item_id,
                    'content': content,
                    'metadata': request.get('metadata', {}),
                }
            )
            self.instance.writeAnswers(result)
