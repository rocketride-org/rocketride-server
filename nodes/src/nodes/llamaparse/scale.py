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

"""Financial scale-header detection and preservation for the LlamaParse node.

A statement's scale caption ("(In millions)", "$ in thousands", ...) declares
the magnitude of every figure in the table below it. When that caption is
separated from its table by downstream chunking or an LLM step, the figures
read as raw units and are silently 1,000x / 1,000,000x / 1,000,000,000x off.
Nothing downstream catches it, because a wrong-by-1e6 number looks exactly like
a right one.

This module keeps scale loss non-silent. It (1) detects scale declarations that
the parser already emitted, (2) welds a normalized marker to the table so a
later chunker cannot split the header away, and (3) flags any numeric table that
has no scale in scope, turning a silent magnitude error into a visible warning.

Recovering a caption that the parser dropped from the source entirely is out of
scope; that needs source re-extraction and belongs to the audit-grade
``datalab_parse`` node. See this node's README ("Scale-header preservation").

Pure text logic, no external dependencies, so it is unit-testable without the
LlamaParse API or the native engine.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterator, List, Optional, Tuple

# Canonical scale word -> (normalized unit label, multiplier).
_SCALE_UNITS = {
    'thousand': ('thousands', 1_000),
    'thousands': ('thousands', 1_000),
    'lakh': ('lakhs', 100_000),
    'lakhs': ('lakhs', 100_000),
    'million': ('millions', 1_000_000),
    'millions': ('millions', 1_000_000),
    'crore': ('crores', 10_000_000),
    'crores': ('crores', 10_000_000),
    'billion': ('billions', 1_000_000_000),
    'billions': ('billions', 1_000_000_000),
    'trillion': ('trillions', 1_000_000_000_000),
    'trillions': ('trillions', 1_000_000_000_000),
}

_SCALE_WORD_RE = re.compile(
    r'\b(thousands?|lakhs?|millions?|crores?|billions?|trillions?)\b',
    re.IGNORECASE,
)

# Words that, following "... <scale> of <word>", keep it a monetary declaration
# ("in millions of dollars"). Anything else after "of" ("millions of users")
# means the scale word is prose, not a caption.
_CURRENCY_WORDS = {
    'dollar',
    'dollars',
    'usd',
    'euro',
    'euros',
    'eur',
    'pound',
    'pounds',
    'sterling',
    'gbp',
    'rupee',
    'rupees',
    'inr',
    'yen',
    'jpy',
    'franc',
    'francs',
    'chf',
    'cad',
    'aud',
    'won',
    'krw',
    'yuan',
    'renminbi',
    'rmb',
    'cny',
    'real',
    'reais',
    'brl',
    'peso',
    'pesos',
}

_CURRENCY_WORDS_RE = re.compile(
    r'\b(?:' + '|'.join(re.escape(w) for w in sorted(_CURRENCY_WORDS)) + r')\b',
    re.IGNORECASE,
)

_SYMBOL_TO_CODE = {'$': 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR', '¥': 'JPY'}

_WORD_TO_CODE = {
    'dollar': 'USD',
    'dollars': 'USD',
    'usd': 'USD',
    'euro': 'EUR',
    'euros': 'EUR',
    'eur': 'EUR',
    'pound': 'GBP',
    'pounds': 'GBP',
    'sterling': 'GBP',
    'gbp': 'GBP',
    'rupee': 'INR',
    'rupees': 'INR',
    'inr': 'INR',
    'yen': 'JPY',
    'jpy': 'JPY',
}

# Amount of surrounding text inspected to decide whether a scale word is a
# genuine declaration.
_CONTEXT_CHARS = 48

# "in" (optionally preceded by a currency symbol) sitting immediately before the
# scale word: "(in millions)", "$ in thousands", "amounts in millions".
_LEADIN_RE = re.compile(r'\bin\s*$', re.IGNORECASE)
# A lone currency symbol immediately before the scale word: "($ millions)".
_CURRENCY_PREFIX_RE = re.compile(r'[$€£₹¥]\s*$')
# "of" immediately before the scale word: prose like "hundreds of thousands".
_TRAILING_OF_RE = re.compile(r'\bof\s*$', re.IGNORECASE)
# "of <word>" immediately after the scale word; the word decides monetary vs
# prose. An optional "U.S." prefix is skipped (outside the capture) so
# "of U.S. dollars" yields "dollars", while "of USD" stays intact.
_OF_CLAUSE_RE = re.compile(r'^\s*of\s+(?:u\.?\s*s\.?\s+)?([a-z]+)', re.IGNORECASE)

# Verb sitting immediately before the "in" lead-in marks the scale word as prose,
# not a caption: "valued in billions", "grew to ... reaching in ...". A caption
# ("Dollars in millions", "Amounts are in thousands") never leads with these, so
# vetoing them costs no real captions while killing a class of false welds.
_PROSE_LEADIN_WORD_RE = re.compile(
    r'\b(?:valued|worth|grew|grown|rose|risen|fell|fallen|reaching|reached|'
    r'totaling|totalling|generating|generated|earning|earned|spending|spent|'
    r'costing|saving|saved|raising|raised|investing|invested|losing|lost|'
    r'measured|priced|estimated)\s+in\s*$',
    re.IGNORECASE,
)

# A page or section boundary between a caption and a table puts the caption out
# of scope: a form feed, a horizontal rule, or an explicit "Page N" marker.
_PAGE_BREAK_RE = re.compile(
    r'\f'
    r'|^\s*(?:-{3,}|\*{3,}|_{3,})\s*$'
    r'|^\s*#{1,6}\s+.*\bpage\s+\d+'
    r'|\bpage\s+\d+\s+of\s+\d+\b',
    re.IGNORECASE | re.MULTILINE,
)

# A table cell that is essentially a number: "1,234", "(1,234)", "$1,234.56",
# "45%", "-5.0". Used to decide whether a headerless table looks financial.
_NUMERIC_CELL_RE = re.compile(r'^[(\-+]?\s*[$€£₹¥]?\s*[\d,]+(?:\.\d+)?\s*%?\)?$')

# Markers this module injects; used for idempotence and for the metadata signal.
# Plain text only: these lines are welded into the parsed text that flows down
# the pipeline (application output), where a non-ASCII glyph can raise a
# UnicodeEncodeError on a cp1252 console.
_SCALE_MARKER_PREFIX = '> Scale:'
_WARNING_MARKER_PREFIX = '> [scale?]'
_WARNING_MARKER = (
    f'{_WARNING_MARKER_PREFIX} Scale not detected for this table. Figures may be in '
    'thousands, millions, or billions. Verify against the source.'
)

# Longest gap (in characters) allowed between a caption and the table it scales,
# as a backstop when the parser emits no page break between unrelated sections.
_MAX_SCOPE_DISTANCE = 1500


@dataclass(frozen=True)
class ScaleDeclaration:
    """A detected scale caption and its normalized magnitude."""

    phrase: str
    unit: str
    factor: int
    currency: Optional[str]
    start: int
    end: int


def _classify_of_clause(right: str) -> Tuple[bool, bool]:
    """Return (is_currency, is_non_currency) for an "of <word>" tail, if any."""
    m = _OF_CLAUSE_RE.match(right)
    if not m:
        return (False, False)
    if m.group(1).lower() in _CURRENCY_WORDS:
        return (True, False)
    return (False, True)


def _detect_currency(left: str, right: str) -> Optional[str]:
    """Best-effort currency label from the text around a scale word."""
    for sym, code in _SYMBOL_TO_CODE.items():
        if sym in left or sym in right:
            return code
    combined = (left + ' ' + right).lower()
    for word, code in _WORD_TO_CODE.items():
        if re.search(r'\b' + re.escape(word) + r'\b', combined):
            return code
    return None


def _build_phrase(text: str, left: str, start: int, end: int, right: str) -> str:
    """Reconstruct a readable caption snippet for logging/metadata."""
    p_start = start
    lead = re.search(r'((?:[$€£₹¥]\s*)?in\s+)$', left, re.IGNORECASE)
    if lead:
        p_start = start - len(lead.group(1))
    p_end = end
    tail = re.match(
        r'\s*(?:of\s+[\w.]+(?:\s+[\w.]+)?)?(?:\s*,\s*except[^)\n.]*)?',
        right,
        re.IGNORECASE,
    )
    if tail and tail.end() > 0:
        p_end = end + tail.end()
    return ' '.join(text[p_start:p_end].split())


def detect_scale_declarations(text: str) -> List[ScaleDeclaration]:
    """Find scale captions in ``text``.

    A scale word ("millions", "thousands", ...) is treated as a declaration only
    when it is anchored to a monetary context: preceded by "in" or a currency
    symbol, or followed by "of <currency>". Prose uses of the same words are
    rejected: "millions of users", "billions served", "hundreds of thousands of
    dollars", "$5 million in revenue".
    """
    if not text:
        return []

    declarations: List[ScaleDeclaration] = []
    for m in _SCALE_WORD_RE.finditer(text):
        if _on_marker_line(text, m.start()):
            # A scale word inside a marker we injected ("> Scale: ... in millions",
            # "> [scale?] ... in thousands, millions, or billions") is not a source
            # caption; skipping it keeps re-annotation idempotent.
            continue
        word = m.group(1).lower()
        unit, factor = _SCALE_UNITS[word]
        left = text[max(0, m.start() - _CONTEXT_CHARS) : m.start()]
        right = text[m.end() : m.end() + _CONTEXT_CHARS]

        of_currency, of_non_currency = _classify_of_clause(right)
        if of_non_currency:
            # "millions of ways", "thousands of customers" -> prose.
            continue
        if _TRAILING_OF_RE.search(left):
            # "hundreds of thousands", "tens of millions" -> prose.
            continue
        if _PROSE_LEADIN_WORD_RE.search(left):
            # "valued in billions", "reached ... in millions" -> prose, not a caption.
            continue

        has_in = bool(_LEADIN_RE.search(left))
        has_currency_prefix = bool(_CURRENCY_PREFIX_RE.search(left))
        if not (has_in or of_currency or has_currency_prefix):
            continue

        declarations.append(
            ScaleDeclaration(
                phrase=_build_phrase(text, left, m.start(), m.end(), right),
                unit=unit,
                factor=factor,
                currency=_detect_currency(left, right),
                start=m.start(),
                end=m.end(),
            )
        )
    return declarations


def _is_table_row(line: str) -> bool:
    """A markdown table row: a pipe-delimited line with at least two cells.

    Matches the heuristic the node uses to split tables out of parsed text, so
    table detection stays consistent between the two callers.
    """
    stripped = line.strip()
    return '|' in stripped and len(stripped.split('|')) > 2


def iter_table_blocks(text: str) -> Iterator[Tuple[int, int, List[str]]]:
    """Yield (start_line, end_line_exclusive, lines) for each markdown table."""
    lines = text.split('\n')
    start: Optional[int] = None
    for i, line in enumerate(lines):
        if _is_table_row(line):
            if start is None:
                start = i
        elif start is not None:
            yield (start, i, lines[start:i])
            start = None
    if start is not None:
        yield (start, len(lines), lines[start:])


def extract_markdown_tables(text: str) -> List[str]:
    """Return each detected markdown table as a string of its stripped rows.

    Shared implementation for the node's ``table`` lane so there is one table
    heuristic, not two.
    """
    return ['\n'.join(line.strip() for line in block) for _, _, block in iter_table_blocks(text)]


def _line_offsets(lines: List[str]) -> List[int]:
    offsets = []
    pos = 0
    for line in lines:
        offsets.append(pos)
        pos += len(line) + 1  # + 1 for the '\n' that split removed
    return offsets


def find_markdown_table_spans(text: str) -> List[Tuple[int, int]]:
    """Return (char_start, char_end) offsets in ``text`` for each table block."""
    lines = text.split('\n')
    offsets = _line_offsets(lines)
    spans = []
    for start, end, _ in iter_table_blocks(text):
        last = end - 1
        spans.append((offsets[start], offsets[last] + len(lines[last])))
    return spans


def _table_looks_numeric(table_text: str) -> bool:
    """True when a table is mostly numbers, so a missing scale matters."""
    cells = []
    for line in table_text.split('\n'):
        for cell in line.strip().strip('|').split('|'):
            c = cell.strip()
            # Skip separator cells like "---" / ":--:".
            if c and set(c) - set('-: '):
                cells.append(c)
    if not cells:
        return False
    numeric = sum(1 for c in cells if _NUMERIC_CELL_RE.match(c))
    return numeric >= 3 and numeric / len(cells) >= 0.3


def _nearest_in_scope(declarations: List[ScaleDeclaration], text: str, table_start: int) -> Optional[ScaleDeclaration]:
    """Nearest declaration ending before ``table_start`` with nothing (page
    break / oversized gap) separating it from the table.
    """
    best: Optional[ScaleDeclaration] = None
    for d in declarations:
        if d.end > table_start:
            continue
        if table_start - d.end > _MAX_SCOPE_DISTANCE:
            continue
        if _PAGE_BREAK_RE.search(text[d.end : table_start]):
            continue
        if best is None or d.end > best.end:
            best = d
    return best


def _on_marker_line(text: str, pos: int) -> bool:
    """True when ``pos`` falls on a line that is one of our injected markers."""
    line_start = text.rfind('\n', 0, pos) + 1
    stripped = text[line_start:].lstrip()
    return stripped.startswith(_SCALE_MARKER_PREFIX) or stripped.startswith(_WARNING_MARKER_PREFIX)


def _already_annotated(prev_line: str) -> bool:
    stripped = prev_line.strip()
    return stripped.startswith(_SCALE_MARKER_PREFIX) or stripped.startswith(_WARNING_MARKER_PREFIX)


def _table_has_currency(table_text: str) -> bool:
    """True when a table carries a currency signal of its own (symbol or code).

    Lets a numeric, uncaptioned table still be flagged in an otherwise
    non-financial document, without warning on plain numeric tables (inventory
    counts, sports standings, server metrics) that carry no financial signal.
    """
    if any(sym in table_text for sym in _SYMBOL_TO_CODE):
        return True
    return _CURRENCY_WORDS_RE.search(table_text) is not None


def _scale_marker(decl: ScaleDeclaration) -> str:
    marker = f'{_SCALE_MARKER_PREFIX} amounts in {decl.unit} (x{decl.factor:,})'
    if decl.currency:
        marker += f' [{decl.currency}]'
    return marker


def annotate_scale(
    text: str,
    declarations: Optional[List[ScaleDeclaration]] = None,
) -> Tuple[str, List[dict]]:
    """Weld scale markers to tables and flag numeric tables missing a scale.

    Returns the annotated text plus a list of per-table warning records
    ``{'table_index', 'status', ...}`` where ``status`` is one of:

    - ``scale_detected``: a caption was in scope; its marker was welded above.
    - ``scale_missing``: a numeric table with a financial signal but no caption
      in scope; a missing-scale warning was welded above.
    - ``not_financial``: no marker welded, either because the table is not
      numeric or it carries no financial signal (so a warning would be noise).
    - ``already_annotated``: the table already carried one of our markers and was
      left untouched.

    A marker is welded only above a *numeric* table, so a caption sitting over a
    prose/roster table is never mis-attached. The missing-scale warning is gated
    on a financial signal (a caption elsewhere in the document, or a currency
    marking in the table itself) so ordinary numeric tables are not annotated.
    Idempotent: re-running does not double-inject.
    """
    if not text or not text.strip():
        return text, []
    if declarations is None:
        declarations = detect_scale_declarations(text)

    lines = text.split('\n')
    offsets = _line_offsets(lines)
    blocks = list(iter_table_blocks(text))
    if not blocks:
        return text, []

    doc_has_declaration = bool(declarations)
    warnings: List[dict] = []
    insertions: dict = {}
    for idx, (start, _end, block) in enumerate(blocks):
        prev_line = lines[start - 1] if start > 0 else ''
        if _already_annotated(prev_line):
            warnings.append({'table_index': idx, 'status': 'already_annotated'})
            continue

        block_text = '\n'.join(block)
        is_numeric = _table_looks_numeric(block_text)
        decl = _nearest_in_scope(declarations, text, offsets[start])
        if decl is not None and is_numeric:
            insertions[start] = _scale_marker(decl)
            warnings.append(
                {
                    'table_index': idx,
                    'status': 'scale_detected',
                    'unit': decl.unit,
                    'factor': decl.factor,
                    'currency': decl.currency,
                }
            )
        elif is_numeric and (doc_has_declaration or _table_has_currency(block_text)):
            insertions[start] = _WARNING_MARKER
            warnings.append({'table_index': idx, 'status': 'scale_missing', 'factor': None})
        else:
            warnings.append({'table_index': idx, 'status': 'not_financial'})

    if not insertions:
        return text, warnings

    out = []
    for i, line in enumerate(lines):
        if i in insertions:
            out.append(insertions[i])
        out.append(line)
    return '\n'.join(out), warnings
