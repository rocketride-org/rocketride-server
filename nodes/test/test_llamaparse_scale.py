"""Unit tests for the llamaparse scale-header detector/annotator (scale.py).

Pure-logic tests, no engine / LlamaParse API / rocketlib required. Cover:
- a labeled detection corpus (positive captions + adversarial negatives),
- table annotation (marker injection) and missing-scale warnings,
- idempotence and empty-input safety,
- parity of the shared table-extraction heuristic.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'nodes', 'llamaparse'))
from scale import (  # noqa: E402
    annotate_scale,
    detect_scale_declarations,
    extract_markdown_tables,
    find_markdown_table_spans,
)


# ---------------------------------------------------------------------------
# Detection corpus: captions that MUST be detected, with their expected factor.
# ---------------------------------------------------------------------------
POSITIVE_CASES = [
    ('(In millions)', 1_000_000),
    ('(in thousands)', 1_000),
    ('(In billions)', 1_000_000_000),
    ('$ in millions', 1_000_000),
    ('$ in thousands', 1_000),
    ('($ millions)', 1_000_000),
    ('Amounts in thousands of dollars', 1_000),
    ('in millions of USD', 1_000_000),
    ('In millions of U.S. dollars', 1_000_000),
    ('(in billions, except per-share data)', 1_000_000_000),
    ('In thousands, except share and per share amounts', 1_000),
    ('Dollars in millions', 1_000_000),
    ('(Millions of dollars)', 1_000_000),
    ('Amounts are in thousands unless otherwise stated', 1_000),
    ('(€ in millions)', 1_000_000),
    ('(£ in thousands)', 1_000),
    ('(₹ in crore)', 10_000_000),
    ('in lakhs', 100_000),
    ('figures in trillions of dollars', 1_000_000_000_000),
]

# ---------------------------------------------------------------------------
# Adversarial negatives: prose that MUST NOT be detected as a scale caption.
# ---------------------------------------------------------------------------
NEGATIVE_CASES = [
    'millions of users signed up last year',
    'in millions of ways this helped customers',
    'thousands of customers rely on the service',
    'billions served worldwide since 1955',
    'a bare million appears in this sentence',
    'the company saved hundreds of thousands of dollars',
    'tens of millions of shares were outstanding',
    'we processed $5 million in revenue',
    'revenue grew to 3.5 billion dollars over the decade',
    'affects millions of people globally',
]


def test_positive_captions_all_detected_with_correct_factor():
    misses = []
    for text, factor in POSITIVE_CASES:
        decls = detect_scale_declarations(text)
        if not decls or decls[0].factor != factor:
            misses.append((text, factor, [(d.unit, d.factor) for d in decls]))
    assert not misses, f'detection misses: {misses}'


def test_no_false_positives_on_prose():
    false_positives = []
    for text in NEGATIVE_CASES:
        decls = detect_scale_declarations(text)
        if decls:
            false_positives.append((text, [(d.phrase, d.factor) for d in decls]))
    assert not false_positives, f'false positives: {false_positives}'


def test_detection_reports_measurable_accuracy():
    # The resume-honest numbers, asserted so they cannot silently regress.
    detected = sum(1 for t, _ in POSITIVE_CASES if detect_scale_declarations(t))
    clean = sum(1 for t in NEGATIVE_CASES if not detect_scale_declarations(t))
    assert detected == len(POSITIVE_CASES)
    assert clean == len(NEGATIVE_CASES)


def test_currency_is_extracted():
    assert detect_scale_declarations('in millions of USD')[0].currency == 'USD'
    assert detect_scale_declarations('(€ in millions)')[0].currency == 'EUR'
    assert detect_scale_declarations('(₹ in crore)')[0].currency == 'INR'
    assert detect_scale_declarations('(In millions)')[0].currency is None


# ---------------------------------------------------------------------------
# Annotation.
# ---------------------------------------------------------------------------
TABLE = '| Item | 2024 | 2023 |\n| --- | --- | --- |\n| Revenue | 1,234 | 1,100 |\n| Net income | 456 | 400 |'


def test_marker_welded_above_table_with_scale_in_scope():
    text = f'Consolidated Statements of Operations\n(In millions)\n\n{TABLE}'
    out, warnings = annotate_scale(text)
    assert '> Scale: amounts in millions (×1,000,000)' in out
    # Marker sits on the line directly above the first table row.
    lines = out.split('\n')
    table_start = next(i for i, ln in enumerate(lines) if ln.startswith('| Item'))
    assert lines[table_start - 1].startswith('> Scale:')
    assert any(w['status'] == 'scale_detected' and w['factor'] == 1_000_000 for w in warnings)


def test_warning_injected_for_numeric_table_without_scale():
    text = f'Some financial figures follow.\n\n{TABLE}'
    out, warnings = annotate_scale(text)
    assert 'Scale not detected for this table' in out
    assert any(w['status'] == 'scale_missing' for w in warnings)


def test_non_numeric_table_gets_no_warning():
    table = '| Name | Role |\n| --- | --- |\n| Ada | Engineer |\n| Grace | Admiral |'
    text = f'Team roster\n\n{table}'
    out, warnings = annotate_scale(text)
    assert 'Scale not detected' not in out
    assert '> Scale:' not in out
    assert any(w['status'] == 'not_financial' for w in warnings)


def test_scale_out_of_scope_when_page_break_between():
    text = f'(In millions)\n\n---\n\nUnrelated section\n\n{TABLE}'
    out, warnings = annotate_scale(text)
    # A page/section break severs the caption from the table -> warned, not welded.
    assert '> Scale:' not in out
    assert any(w['status'] == 'scale_missing' for w in warnings)


def test_annotation_is_idempotent():
    text = f'(In millions)\n\n{TABLE}'
    once, _ = annotate_scale(text)
    twice, warnings = annotate_scale(once)
    assert once == twice
    assert once.count('> Scale:') == 1


def test_empty_and_tableless_text_are_noops():
    assert annotate_scale('') == ('', [])
    assert annotate_scale('   ') == ('   ', [])
    prose = 'Just a paragraph with no tables in it at all.'
    assert annotate_scale(prose) == (prose, [])


# ---------------------------------------------------------------------------
# Shared table heuristic.
# ---------------------------------------------------------------------------
def test_extract_markdown_tables_matches_legacy_heuristic():
    text = f'intro\n{TABLE}\noutro\n\n| a | b |\n| 1 | 2 |'
    tables = extract_markdown_tables(text)
    assert len(tables) == 2
    # Rows are stripped and pipe-delimited, as the table lane expects.
    assert tables[0].splitlines()[0] == '| Item | 2024 | 2023 |'


def test_table_spans_point_at_table_text():
    text = f'header line\n{TABLE}\nfooter'
    spans = find_markdown_table_spans(text)
    assert len(spans) == 1
    start, end = spans[0]
    assert text[start:end].startswith('| Item')
    assert text[start:end].rstrip().endswith('|')
