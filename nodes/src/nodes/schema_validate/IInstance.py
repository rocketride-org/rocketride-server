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

from rocketlib import Entry, IInstanceBase
from ai.common.schema import Answer

from .IGlobal import IGlobal
from .validate import validate_payload


class IInstance(IInstanceBase):
    IGlobal: IGlobal  # Reference to the global context holding the resolved config

    # Validated payloads collected during the object, emitted at closing.
    # Each entry is (expectJson: bool, payload) — see writeAnswers/closing.
    pending: list = None

    def open(self, obj: Entry):
        self.pending = []

    def writeAnswers(self, answer: Answer):
        """Collect and validate an incoming answer; emit happens in ``closing``.

        We take ownership of the ``answers`` lane by calling ``preventDefault``
        (mirrors the ``anonymize`` node): the engine's default pass-through is
        suppressed and this node re-emits every record itself in ``closing``, so
        each answer appears exactly once. Fact records (dicts, or lists of them)
        are annotated with a ``validation`` block plus an appended provenance
        entry; everything else (plain text, non-fact JSON) is forwarded
        unchanged. Records are never dropped.

        Only JSON-lane answers (``isJson()`` — i.e. ``expectJson``) are treated
        as facts. A plain-text answer whose text merely looks like JSON is left
        on the text lane verbatim, preserving its ``expectJson=False`` flag. A
        JSON-lane answer whose value is a bare scalar (not a dict/list) carries
        no fact to validate and is re-emitted as text (``expectJson=False``) —
        its content is unchanged but its lane flag flips.

        The payload is extracted here (not the ``Answer`` object) so nothing
        depends on the engine reusing the object after this call returns.
        """
        payload = None
        if answer is not None and answer.isJson():
            try:
                payload = answer.getJson()
            except ValueError:
                payload = None

        if isinstance(payload, (dict, list)):
            self.pending.append((True, validate_payload(payload, self.IGlobal.config)))
        else:
            # Plain text, empty, or non-fact JSON scalar — pass through verbatim.
            self.pending.append((False, answer.getText() if answer is not None else ''))

        # Suppress the engine's default forward; we emit in closing().
        self.preventDefault()

    def closing(self):
        for expect_json, data in self.pending:
            out = Answer(expectJson=expect_json)
            out.setAnswer(data)
            self.instance.writeAnswers(out)

    def close(self):
        self.pending = None
