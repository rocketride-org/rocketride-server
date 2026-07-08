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

import json
from typing import Any, Dict, List
from rocketlib import IInstanceBase, Entry
from rocketlib.types import IInvokeLLM
from ai.common.schema import Doc, DocMetadata, Question, QuestionType, Answer
from ai.common.util import normalize
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    Instance handler for the extract_facts node.

    Accumulates document and table context across all chunks of an object,
    then runs a two-pass LLM extraction:

      1. Extraction pass  - read the source (cell by cell for tables) and emit
                            user-configured target fields plus a _provenance
                            block per fact.
      2. Validator pass   - a SECOND prompt to the SAME llm invoke lane that
                            re-reads the source, reconciles disagreements, and
                            returns corrected, fully-qualified facts.

    Facts are emitted on closing() to the answers and/or documents lanes.
    """

    # Reference to a global instance providing shared functionality.
    IGlobal: IGlobal

    # Accumulated per-object context.
    doc_text: str = ''
    table_text: str = ''
    table_id: int = 0

    # Final reconciled facts, populated in closing().
    facts: List[Dict[str, Any]] = []

    # -- lifecycle ------------------------------------------------------------

    def open(self, obj: Entry):
        """
        Initialize the instance for a new object. Resets all accumulators so
        each object is extracted independently.

        Args:
            obj (Entry): The object to initialize processing for.
        """
        self.doc_text = ''
        self.table_text = ''
        self.table_id = 0
        self.facts = []

    # -- input lanes (buffered, not forwarded) --------------------------------

    def writeText(self, text: str):
        """
        Accumulate free-text document context. The text is buffered rather than
        forwarded; the node re-emits derived facts in closing().

        Args:
            text (str): The input text to process.
        """
        if text:
            self.doc_text += text + '\n'

        # We consume the input; downstream sees only our facts.
        self.preventDefault()

    def writeTable(self, text: str):
        """
        Accumulate tabular context. Each distinct table is fenced with a stable
        [TABLE <id>] marker so the extractor can address cells (row/col) and
        return the matching table_id in provenance.

        Args:
            text (str): The raw table text (e.g. markdown/delimited).
        """
        if text:
            self.table_text += f'[TABLE {self.table_id}]\n{text}\n[/TABLE {self.table_id}]\n'
            self.table_id += 1

        self.preventDefault()

    def writeDocuments(self, documents: List[Doc]):
        """
        Accumulate context arriving on the documents lane. Table documents are
        routed to the table buffer (with a fence + tableId from metadata when
        available); all others feed the free-text buffer. A [Page N] marker is
        emitted inline with each chunk when the document carries page metadata,
        so the extractor can cite the page in provenance.

        Args:
            documents (List[Doc]): Incoming documents.
        """
        for doc in documents:
            content = doc.page_content or ''
            metadata = doc.metadata if isinstance(doc.metadata, dict) else {}

            page = metadata.get('page')
            page_tag = f'[Page {page}]\n' if page is not None else ''

            if metadata.get('isTable'):
                tid = metadata.get('tableId', self.table_id)
                self.table_text += f'{page_tag}[TABLE {tid}]\n{content}\n[/TABLE {tid}]\n'
                self.table_id = max(self.table_id, tid + 1)
            elif content:
                self.doc_text += f'{page_tag}{content}\n'

        self.preventDefault()

    # -- prompt construction --------------------------------------------------

    def _fieldSpec(self) -> str:
        """Render the user-configured target fields into prompt text."""
        fields: List[str] = []
        for field in self.IGlobal.fields:
            field_name = field.get('column', '').ljust(32)
            field_type = field.get('type', '').ljust(16)
            field_defval = field.get('defval', '')
            fields.append(f'          Field: {field_name}  Type: {field_type}  Default Value: {field_defval}')

        return 'The target fields you must extract are:\n' + '\n'.join(fields)

    def _buildExtractionQuestion(self) -> Question:
        """
        Build the first-pass extraction question. Asks for the user target
        fields plus a mandatory _provenance block on every fact.
        """
        question: Question = Question(
            type=QuestionType.QUESTION,
            expectJson=True,
            role='You are a meticulous extraction engine that reads documents and tables and emits fully-qualified facts.',
        )

        question.addInstruction(
            'Fact Extraction',
            normalize("""
            Examine the context carefully and extract every fact that fills one of
            the target fields. Infer values where an exact label is absent, using
            your understanding of the document.
            """),
        )

        question.addInstruction('Fields', self._fieldSpec())

        if self.table_text:
            question.addInstruction(
                'Table Reading',
                normalize("""
                Tables are fenced with [TABLE <id>] ... [/TABLE <id>] markers and are
                delimited (markdown or CSV-like). Treat the first row of each table as
                the header. Read each table row by row, and within each row cell by
                cell. For every value you take from a table cell, record:
                  - table_id: the id from the enclosing [TABLE <id>] fence
                  - row: the 0-based data row index (header row is -1)
                  - col: the 0-based column index of the cell
                  - source_text: the verbatim text of that exact cell
                """),
            )

        question.addInstruction(
            'Provenance',
            normalize("""
            EVERY fact object you return MUST contain the target fields above AND a
            "_provenance" object with these keys:
              page        - source page number from the nearest preceding [Page N]
                            marker in the context, else null
              table_id    - the [TABLE <id>] id if the fact came from a table, else null
              row         - 0-based table row, else null
              col         - 0-based table column, else null
              source_text - the exact snippet/cell the value was taken from
              confidence  - your confidence from 0.0 to 1.0
            Never omit _provenance. For free-text facts set table_id/row/col to null.
            """),
        )

        question.addInstruction(
            'Return a List',
            normalize("""
            Return a JSON array of fact objects. If you find nothing, return an empty
            array. Do not wrap the array in another object.
            """),
        )

        question.addExample(
            '[TABLE 0]\n| Name | Age |\n| Alice | 30 |\n[/TABLE 0]',
            [
                {
                    'name': 'Alice',
                    'age': 30,
                    '_provenance': {
                        'page': None,
                        'table_id': 0,
                        'row': 0,
                        'col': 0,
                        'source_text': 'Alice',
                        'confidence': 0.98,
                    },
                }
            ],
        )

        if self.table_text:
            question.addContext(self.table_text)

        if self.doc_text:
            question.addDocuments(self.doc_text)

        return question

    def _buildValidatorQuestion(self, candidates: List[Dict[str, Any]]) -> Question:
        """
        Build the second-pass validator question. Re-reads the same source plus
        the first-pass facts, and returns a reconciled, corrected list.
        """
        question: Question = Question(
            type=QuestionType.QUESTION,
            expectJson=True,
            role='You are a rigorous fact-checking auditor that verifies extracted facts against their source.',
        )

        question.addInstruction(
            'Re-verify',
            normalize("""
            You are given a list of candidate facts and the original source. For each
            candidate, independently re-read the exact location named in its
            _provenance (the cited page, or the [TABLE <id>] cell at row/col) and
            decide whether the value truly matches the source there.
            """),
        )

        question.addInstruction(
            'Disagreement Handling',
            normalize("""
            When a candidate disagrees with the source:
              - If the value is wrong, replace it with the correct value from the source.
              - If the cited cell is wrong, fix table_id/row/col/source_text.
              - If the fact is unsupported by the source, drop it entirely.
              - Lower confidence when the source is ambiguous.
            When a candidate is correct, keep it unchanged.
            """),
        )

        question.addInstruction(
            'Output Contract',
            normalize("""
            Return the full reconciled JSON array. Each surviving fact keeps its target
            fields and _provenance, and additionally carries a "_validation" object:
              changed        - true if you altered any field or provenance, else false
              reason         - short explanation of the check / correction
              original_value - the previous value you replaced, or null if unchanged
            Return an empty array if no candidate survives.
            """),
        )

        question.addContext(json.dumps(candidates))

        if self.table_text:
            question.addContext(self.table_text)

        if self.doc_text:
            question.addDocuments(self.doc_text)

        return question

    # -- extraction pipeline --------------------------------------------------

    def _normalizeFacts(self, raw: Any) -> List[Dict[str, Any]]:
        """Coerce an LLM result into a clean list of fact dicts."""
        if not isinstance(raw, list):
            return []

        facts: List[Dict[str, Any]] = []
        for item in raw:
            if isinstance(item, dict):
                facts.append(item)
        return facts

    def _runExtraction(self) -> List[Dict[str, Any]]:
        """First LLM pass: extract candidate facts with provenance."""
        question = self._buildExtractionQuestion()
        result = self.instance.invoke(IInvokeLLM.Ask(question=question))
        return self._normalizeFacts(result.getJson())

    def _runValidator(self, candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Second LLM pass on the SAME llm invoke lane: re-check the candidates and
        reconcile disagreements. Falls back to the candidates if the validator
        returns nothing usable. Skipped entirely when validation is disabled.
        """
        if not candidates:
            return []

        # Validator toggle (services.json facts.validate).
        if not self.IGlobal.validate:
            return candidates

        question = self._buildValidatorQuestion(candidates)
        result = self.instance.invoke(IInvokeLLM.Ask(question=question))
        reconciled = self._normalizeFacts(result.getJson())

        if not reconciled:
            # Validator failed / returned garbage: keep first-pass facts as-is.
            return candidates

        # Defensive fallback: if the validator omitted _validation, stamp it. We
        # can only diff reliably when the validator returned the same shape it was
        # given; if it dropped or reordered facts, positional pairing is unsafe, so
        # mark 'changed' as unknown (None) rather than guessing.
        same_shape = len(reconciled) == len(candidates)
        for idx, fact in enumerate(reconciled):
            if '_validation' in fact:
                continue
            if same_shape:
                original = candidates[idx]
                changed = any(fact.get(f.get('column')) != original.get(f.get('column')) for f in self.IGlobal.fields)
                reason = 'validator did not annotate; diffed against first pass'
            else:
                changed = None
                reason = 'validator did not annotate; fact set reshaped, diff unavailable'
            fact['_validation'] = {
                'changed': changed,
                'reason': reason,
                'original_value': None,
            }

        return reconciled

    def _stripProvenance(self, facts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Remove _provenance when the include_provenance toggle is off."""
        if self.IGlobal.include_provenance:
            return facts
        cleaned: List[Dict[str, Any]] = []
        for fact in facts:
            cleaned.append({k: v for k, v in fact.items() if k != '_provenance'})
        return cleaned

    # -- emit -----------------------------------------------------------------

    def closing(self):
        """
        Run the two-pass extraction over the accumulated context and emit the
        reconciled facts to whichever output lanes have listeners.
        """
        # Nothing to work with.
        if not self.doc_text and not self.table_text:
            return

        candidates = self._runExtraction()
        self.facts = self._stripProvenance(self._runValidator(candidates))

        if self.instance.hasListener('answers'):
            answer = Answer(expectJson=True)
            answer.setAnswer(self.facts)
            self.instance.writeAnswers(answer)

        if self.instance.hasListener('documents'):
            documents: List[Doc] = []

            for index, fact in enumerate(self.facts):
                provenance = fact.get('_provenance', {}) or {}
                fact_table_id = provenance.get('table_id')

                metadata = DocMetadata(
                    self,
                    chunkId=index,
                    isTable=fact_table_id is not None,
                    tableId=fact_table_id if fact_table_id is not None else 0,
                    isDeleted=False,
                )

                doc = Doc(page_content=json.dumps(fact), type='Document', metadata=metadata)
                documents.append(doc)

            self.instance.writeDocuments(documents)
