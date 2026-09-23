# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pure-logic unit tests for the anonymize node.

These exercise the import-light helpers in ``nodes/anonymize/anonymize.py``
(token replacement, label-tag formatting, entity-type cleaning) plus the
code/services.json default-label sync. No GLiNER model or running server is
required, so this file runs under plain ``python3`` as well as pytest.
"""

import importlib.util
import json
import os

_ANON_DIR = os.path.join(os.path.dirname(__file__), '..', 'src', 'nodes', 'anonymize')


def _load_anonymize_module():
    """Load anonymize.py by file path, bypassing the package __init__ (heavy deps)."""
    path = os.path.join(_ANON_DIR, 'anonymize.py')
    spec = importlib.util.spec_from_file_location('anonymize_pure', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


anon = _load_anonymize_module()


# --- anonymize_tokens: adjacency (#1) -------------------------------------


def test_adjacent_distinct_entities_keep_both_tokens():
    # "JohnDoe" [0,7) name immediately followed by "a@b.co" [7,13) email,
    # no separator. Each must keep its own tag, not collapse into one.
    text = 'JohnDoea@b.co!'
    matches = [(0, 7, '[NAME]'), (7, 6, '[EMAIL]')]
    assert anon.anonymize_tokens(text, matches) == '[NAME][EMAIL]!'


def test_true_overlap_merges_keeping_first_token():
    # Genuinely overlapping spans collapse to one token (the first by offset).
    text = 'abcdefgh'
    matches = [(0, 4, '[A]'), (2, 4, '[B]')]  # [0,4) and [2,6) overlap
    assert anon.anonymize_tokens(text, matches) == '[A]gh'


def test_exact_duplicate_span_merges():
    text = 'secret stuff'
    matches = [(0, 6, '[X]'), (0, 6, '[X]')]
    assert anon.anonymize_tokens(text, matches) == '[X] stuff'


# --- anonymize_tokens: first-in-list wins on equal offset (#2 invariant) ---


def test_equal_offset_keeps_first_in_list_order():
    # process() relies on this: a specific NER token listed BEFORE a generic
    # [REDACTED] fallback at the same span must win.
    text = 'jane@x.com here'
    specific_first = [(0, 10, '[EMAIL]'), (0, 10, '[REDACTED]')]
    assert anon.anonymize_tokens(text, specific_first) == '[EMAIL] here'


# --- anonymize_tokens: correctness / ordering ------------------------------


def test_replaces_multiple_spans_in_order():
    text = 'A bob B carol C'
    matches = [(2, 3, '[P1]'), (8, 5, '[P2]')]
    assert anon.anonymize_tokens(text, matches) == 'A [P1] B [P2] C'


def test_unsorted_input_is_handled():
    text = 'A bob B carol C'
    matches = [(8, 5, '[P2]'), (2, 3, '[P1]')]
    assert anon.anonymize_tokens(text, matches) == 'A [P1] B [P2] C'


def test_no_matches_returns_original():
    assert anon.anonymize_tokens('untouched', []) == 'untouched'


# --- format_token: readable multi-word tags (#3) ---------------------------


def test_format_token_single_word():
    assert anon.format_token('person') == '[PERSON]'


def test_format_token_multiword_uses_spaces_not_underscores():
    assert anon.format_token('phone_number') == '[PHONE NUMBER]'
    assert anon.format_token('social_security_number') == '[SOCIAL SECURITY NUMBER]'


def test_format_token_accepts_spaced_input():
    assert anon.format_token('ip address') == '[IP ADDRESS]'


# --- clean_entity_types: non-list guard + intended fallback (#4, #5) --------


def test_clean_entity_types_string_does_not_become_per_char_labels():
    # A stray string config must NOT iterate into single-character labels.
    result = anon.clean_entity_types('person')
    assert result == anon.DEFAULT_PII_LABELS


def test_clean_entity_types_none_returns_defaults():
    assert anon.clean_entity_types(None) == anon.DEFAULT_PII_LABELS


def test_clean_entity_types_empty_list_returns_defaults():
    # Intended: an empty list never disables detection.
    assert anon.clean_entity_types([]) == anon.DEFAULT_PII_LABELS


def test_clean_entity_types_strips_and_drops_blanks():
    assert anon.clean_entity_types(['  email ', '', '   ', 'ssn']) == ['email', 'ssn']


def test_clean_entity_types_all_blank_returns_defaults():
    assert anon.clean_entity_types(['  ', '']) == anon.DEFAULT_PII_LABELS


def test_clean_entity_types_drops_non_string_items():
    assert anon.clean_entity_types(['email', 123, None, 'ssn']) == ['email', 'ssn']


# --- DEFAULT_PII_LABELS stays in sync with services.json (#9) --------------


def test_default_labels_match_services_json():
    # services.json is JSONC (// comments, and "//" appears inside the protocol
    # string), so a plain json.load fails. Extract just the entityTypes.default
    # array — its contents are plain JSON with no comments.
    with open(os.path.join(_ANON_DIR, 'services.json'), encoding='utf-8') as f:
        raw = f.read()
    key = raw.index('"entityTypes"')
    default = raw.index('"default"', key)
    start = raw.index('[', default)
    end = raw.index(']', start)
    json_default = json.loads(raw[start : end + 1])
    assert json_default == anon.DEFAULT_PII_LABELS, (
        'entityTypes.default in services.json drifted from DEFAULT_PII_LABELS'
    )


if __name__ == '__main__':
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f'  ok - {t.__name__}')
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f'  FAIL - {t.__name__}: {type(e).__name__}: {e}')
    print(f'\n{len(tests) - failed}/{len(tests)} passed')
    raise SystemExit(1 if failed else 0)
