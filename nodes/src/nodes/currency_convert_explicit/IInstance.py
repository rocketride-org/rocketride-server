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

from rocketlib import warning, Entry, IInstanceBase
from ai.common.schema import Answer

from .convert import convert_payload


class IInstance(IInstanceBase):
    # Converted payloads collected during the object, emitted at closing.
    # Each entry is (expectJson: bool, payload) — see writeAnswers/closing.
    pending: list = None

    def open(self, object: Entry):
        self.pending = []

    def _conversion(self) -> dict:
        """
        The normalised conversion settings this binding converts with, built once from its settings view.

        The resolver has applied the defaults and typed every value; the codes
        are stripped because the fact comparison is textual. Read through
        ``settings`` (never ``IGlobal.config``) so a caller's env placeholder
        resolves to that caller's value on a shared engine.
        """
        cached = getattr(self, '_conversion_cache', None)
        if cached is not None:
            return cached
        cfg = self.settings
        conversion = {
            'source_currency': str(cfg.source_currency or '').strip(),
            'target_currency': str(cfg.target_currency or '').strip(),
            'rate': cfg.rate,
            'rate_date': str(cfg.rate_date or '').strip(),
            'amount_field': str(cfg.amount_field or '').strip() or 'amount',
            'currency_field': str(cfg.currency_field or '').strip() or 'currency',
            'decimals': cfg.decimals,
        }
        # Conversion is opt-in: a blank code is loud but never fatal; the
        # answers pass through unchanged (convert_fact handles the blank)
        if not conversion['source_currency'] or not conversion['target_currency']:
            warning(
                'currency_convert_explicit: both source_currency and target_currency '
                'must be set; answers will pass through unchanged.'
            )
        self._conversion_cache = conversion
        return conversion

    def writeAnswers(self, answer: Answer):
        """Collect and convert an incoming answer; emit happens in ``closing``.

        We take ownership of the ``answers`` lane by calling ``preventDefault``
        (mirrors the ``anonymize`` node): the engine's default pass-through is
        suppressed and this node re-emits every record itself in ``closing``, so
        each answer appears exactly once. Source-currency fact records are
        enriched with a ``converted`` value plus provenance; everything else
        (plain text, non-fact JSON, non-matching currencies) is forwarded
        unchanged. Records are never dropped.

        Only JSON-lane answers (``isJson()`` — i.e. ``expectJson``) are treated
        as facts. A plain-text answer whose text merely looks like JSON is left
        on the text lane verbatim, preserving its ``expectJson=False`` flag.

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
            self.pending.append((True, convert_payload(payload, self._conversion())))
        else:
            # Plain text / scalar JSON carries no currency — pass through verbatim.
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
