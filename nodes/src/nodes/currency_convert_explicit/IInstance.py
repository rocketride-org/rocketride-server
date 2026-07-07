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

from rocketlib import IInstanceBase
from ai.common.schema import Answer

from .IGlobal import IGlobal
from .convert import convert_payload


class IInstance(IInstanceBase):
    IGlobal: IGlobal  # Reference to the global context holding the resolved config

    def writeAnswers(self, answer: Answer):
        """Convert matching facts on the ``answers`` lane, then forward.

        This node owns forwarding for the lane: source-currency fact records are
        enriched with a ``converted`` value plus provenance, and everything else
        (plain text, non-fact JSON, non-matching currencies) is passed through
        unchanged. Records are never dropped, so there is no ``preventDefault``.
        """
        if answer is None:
            self.instance.writeAnswers(answer)
            return

        try:
            payload = answer.getJson()
        except ValueError:
            # Answer holds plain, non-JSON text — nothing structured to convert.
            self.instance.writeAnswers(answer)
            return

        if not isinstance(payload, (dict, list)):
            # Scalar JSON (a bare number/string) carries no currency; forward it.
            self.instance.writeAnswers(answer)
            return

        converted = convert_payload(payload, self.IGlobal.config)

        out = Answer(expectJson=True)
        out.setAnswer(converted)
        self.instance.writeAnswers(out)
