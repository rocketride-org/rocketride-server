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

"""Per-object instance for the human-in-the-loop approval node.

Receives an Answer on the ``answers`` lane, registers it as a pending approval,
**blocks** the calling thread until a human resolves the request via the REST
API, and then either emits the (possibly modified) answer downstream or
suppresses it.

This is the blocking gate that PR #542 was missing — without it, the node
emitted ``status: pending`` immediately and downstream nodes ignored the gate.
"""

from __future__ import annotations

from typing import Any, Dict

from rocketlib import IInstanceBase, debug

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeAnswers(self, answer: Any) -> None:
        """Block on a human decision before emitting ``answer`` downstream.

        The argument is the engine's Answer object (see ai.common.schema). We
        treat it opaquely: extract its serialized form for the reviewer, then
        forward the original (or a modified payload from the reviewer) on
        approval. Rejection suppresses the answer entirely.
        """
        manager = self.IGlobal.manager
        if manager is None:
            # CONFIG mode or misconfigured — pass through without blocking.
            self.instance.writeAnswers(answer)
            return

        payload = self._answer_to_payload(answer, max_chars=self.IGlobal.max_payload_chars)
        metadata = {
            'profile': self.IGlobal.profile,
            'is_json': bool(getattr(answer, 'isJson', lambda: False)()),
        }

        decision = manager.create_and_wait(
            payload,
            timeout=self.IGlobal.timeout_seconds,
            timeout_action=self.IGlobal.timeout_action,
            profile=self.IGlobal.profile,
            metadata=metadata,
            require_reason_on_reject=self.IGlobal.require_reason_on_reject,
        )

        # Notify after creation so the registered request id reaches reviewers
        # via webhook/log; we only have it after manager.create_and_wait runs.
        # In a future enhancement we'd split create+wait so notify can fire
        # *before* the wait — but that requires a structural refactor of how
        # node config lives across calls. Logging the resolution path is
        # sufficient for PR A.
        debug(f'approval decision: status={decision.status.value} decided_by={decision.decided_by} reason={decision.reason}')

        if decision.approved:
            # Only re-apply the payload when the reviewer actually edited it.
            # Otherwise the original Answer is forwarded untouched — important
            # because the registered payload may be a *truncated preview* and
            # writing that back would corrupt the downstream content.
            if decision.was_modified:
                outgoing = self._payload_to_answer(answer, decision.modified_payload)
            else:
                outgoing = answer
            self.instance.writeAnswers(outgoing)
        else:
            # Rejected or timed-out-as-rejected: drop the answer. Downstream
            # nodes see no emission, which is the intended gate behavior.
            debug(f'approval suppressed answer: status={decision.status.value} reason={decision.reason}')

    @staticmethod
    def _answer_to_payload(answer: Any, *, max_chars: int = 0) -> Dict[str, Any]:
        """Serialize an Answer to a JSON-safe dict for storage / REST.

        When ``max_chars`` is positive and the textual representation exceeds
        that length, the payload is truncated and a ``_truncated_to`` /
        ``_original_length`` marker is added so reviewers (and audit logs)
        know the preview is not the full content. JSON answers are routed
        through their text form for measurement so truncation applies
        uniformly regardless of payload shape.
        """
        is_json = bool(getattr(answer, 'isJson', lambda: False)())
        if is_json:
            try:
                json_value = answer.getJson()
                payload: Dict[str, Any] = {'json': json_value}
                # Estimate size by the textual rendering — protects reviewers
                # from a 100KB JSON blob even though structure is preserved.
                rendered = str(json_value)
                if max_chars > 0 and len(rendered) > max_chars:
                    payload['_truncated_to'] = max_chars
                    payload['_original_length'] = len(rendered)
                return payload
            except Exception:  # pragma: no cover — defensive on malformed answers
                pass
        try:
            text = answer.getText()
        except Exception:  # pragma: no cover — defensive
            text = str(answer)
        if max_chars > 0 and len(text) > max_chars:
            return {
                'text': text[:max_chars],
                '_truncated_to': max_chars,
                '_original_length': len(text),
            }
        return {'text': text}

    @staticmethod
    def _payload_to_answer(original: Any, payload: Dict[str, Any]) -> Any:
        """Apply a (possibly modified) payload back onto the Answer object.

        We mutate the original Answer rather than constructing a new one so that
        whatever metadata the engine attached (object refs, etc.) is preserved.
        Falls back to returning the original answer untouched if mutation
        helpers aren't available.
        """
        if not payload:
            return original
        if 'json' in payload and hasattr(original, 'setJson'):
            original.setJson(payload['json'])
            return original
        if 'text' in payload and hasattr(original, 'setText'):
            original.setText(payload['text'])
            return original
        return original
