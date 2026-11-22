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

from .normalize import build_mapping, dedupe_facts, normalize_payload


class IInstance(IInstanceBase):
    """Normalize fact answers by this call's rules; the control holds nothing (no IGlobal)."""

    # Normalized payloads collected during the object, emitted at closing.
    # Each entry is (kind, data): kind == 'json' for dict/list payloads,
    # kind == 'text' for pass-through text. See writeAnswers/closing.
    pending: list = None

    # This call's normalisation rules, built from its settings on first use
    rules: dict = None

    def normalization_rules(self) -> dict:
        """
        This call's normalisation rules, built once from its settings (types and enums are the schema's).

        Returns:
            The rules ``normalize_payload`` takes: the two field names, the
            default currency, the decimal format and the merged metric mapping.
        """
        if self.rules is None:
            settings = self.settings
            self.rules = {
                'label_field': settings.label_field,
                'value_field': settings.value_field,
                # Written verbatim into normalized.currency, which downstream currency
                # conversion matches on; the schema holds it to three letters, the
                # case is normalised here.
                'default_currency': settings.default_currency.upper(),
                'decimal_format': settings.decimal_format,
                # Merge the built-in mapping with the call's overrides (a pure dict merge)
                'mapping': build_mapping(settings.label_to_metric),
            }
        return self.rules

    def open(self, obj: Entry):
        self.pending = []

    def writeAnswers(self, answer: Answer):
        """Collect and normalize an incoming answer; emission happens in ``closing``.

        Dedupe is cross-record, so — unlike a per-record filter — this node takes
        ownership of the ``answers`` lane via ``preventDefault`` and re-emits the
        whole batch itself in ``closing`` after de-duplicating. Fact dicts are
        enriched with a ``normalized`` block plus provenance; plain text and
        non-fact JSON pass through unchanged. Records are never dropped except as
        exact duplicates.

        The payload is extracted here (not the ``Answer`` object) so nothing
        depends on the engine reusing the object after this call returns.
        """
        try:
            payload = answer.getJson() if answer is not None else None
        except ValueError:
            payload = None

        if isinstance(payload, (dict, list)):
            self.pending.append(('json', normalize_payload(payload, self.normalization_rules())))
        else:
            # Plain text / scalar JSON carries no fact — pass through verbatim.
            self.pending.append(('text', answer.getText() if answer is not None else ''))

        # Suppress the engine's default forward; we emit in closing().
        self.preventDefault()

    def closing(self):
        """Partition queued items into deduplicated facts and ordered extras, then emit.

        Fact dicts are batch-deduplicated via ``dedupe_facts`` and re-emitted as
        one list answer — so N incoming dict answers can collapse into a single
        list payload (a lone bare dict keeps its shape). Non-fact items are
        emitted verbatim, in arrival order, after the facts.
        """
        # Separate normalized fact dicts (deduped as a batch) from everything
        # else (emitted verbatim, in order, after the facts).
        facts = []
        extras = []
        saw_list = False
        for kind, data in self.pending:
            if kind == 'json' and isinstance(data, dict):
                facts.append(data)
            elif kind == 'json' and isinstance(data, list):
                saw_list = True
                for item in data:
                    (facts if isinstance(item, dict) else extras).append(item)
            else:
                extras.append(data)

        deduped = dedupe_facts(facts, self.normalization_rules().get('label_field') or 'label')

        if deduped:
            # Preserve a lone bare-dict payload's shape; otherwise emit one list.
            if len(deduped) == 1 and not saw_list and not extras:
                self._emit(deduped[0])
            else:
                self._emit(deduped)

        for item in extras:
            self._emit(item)

    def _emit(self, data):
        """Emit a single value on the answers lane with the right expectJson flag."""
        if isinstance(data, (dict, list)):
            out = Answer(expectJson=True)
            out.setAnswer(data)
        elif isinstance(data, str):
            out = Answer(expectJson=False)
            out.setAnswer(data)
        else:
            # Bare scalars cannot be stored on an Answer; render as text.
            out = Answer(expectJson=False)
            out.setAnswer(str(data))
        self.instance.writeAnswers(out)

    def close(self):
        self.pending = None
