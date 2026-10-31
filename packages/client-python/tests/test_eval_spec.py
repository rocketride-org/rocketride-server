# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Unit tests for the eval spec loader (rocketride.evals.spec.load_spec).

Covers the happy path (all assertion types, path resolution relative to the
spec file, spec- and case-level judge overrides) and every validation error
class: missing/invalid pipeline, duplicate case names, unknown assertion
types, missing required parameters, unknown (e.g. misspelled) parameter keys,
out-of-range min_score, empty expect lists, unreadable files, and invalid
JSON. No server or client is required.
"""

import json
import os

import pytest

from rocketride.evals.spec import AssertionSpec, EvalSpecError, load_spec


def write_spec(tmp_path, document, name='sample.eval.json'):
    """Write an eval spec document to a temp file and return its path string."""
    path = tmp_path / name
    path.write_text(json.dumps(document), encoding='utf-8')
    return str(path)


def minimal_spec(**overrides):
    """Build a minimal valid spec document, applying top-level overrides."""
    document = {
        'pipeline': 'chat.pipe',
        'cases': [
            {
                'name': 'greeting',
                'input': 'Say hello',
                'expect': [{'type': 'contains', 'value': 'hello'}],
            }
        ],
    }
    document.update(overrides)
    return document


class TestLoadSpecHappyPath:
    def test_full_spec_with_all_assertion_types(self, tmp_path):
        document = {
            'pipeline': 'pipelines/chat.pipe',
            'source': 'webhook_1',
            'judge_pipeline': 'judges/spec-judge.pipe',
            'cases': [
                {
                    'name': 'greeting',
                    'input': 'Say hello',
                    'expect': [
                        {'type': 'contains', 'value': 'hello', 'ignore_case': True},
                        {'type': 'not_contains', 'value': 'error'},
                        {'type': 'regex', 'pattern': 'h.llo'},
                        {'type': 'equals', 'value': 'hello', 'ignore_case': False, 'strip': True},
                        {'type': 'min_length', 'value': 1},
                        {'type': 'max_length', 'value': 500},
                        {'type': 'json_path', 'path': 'a.b.0.c', 'equals': 5, 'gte': 1, 'lte': 10},
                        {'type': 'latency_max_ms', 'value': 2000},
                        {'type': 'llm_judge', 'criteria': 'Politely greets the user', 'min_score': 0.5},
                    ],
                },
                {
                    'name': 'follow-up',
                    'input': 'Say goodbye',
                    'judge_pipeline': 'judges/case-judge.pipe',
                    'expect': [{'type': 'contains', 'value': 'goodbye'}],
                },
            ],
        }
        path = write_spec(tmp_path, document)

        spec = load_spec(path)

        assert spec.path == path
        assert spec.pipeline == os.path.normpath(str(tmp_path / 'pipelines' / 'chat.pipe'))
        assert spec.source == 'webhook_1'
        assert spec.judge_pipeline == os.path.normpath(str(tmp_path / 'judges' / 'spec-judge.pipe'))
        assert [case.name for case in spec.cases] == ['greeting', 'follow-up']

        greeting = spec.cases[0]
        assert greeting.input == 'Say hello'
        assert greeting.judge_pipeline is None
        assert len(greeting.expect) == 9
        assert all(isinstance(assertion, AssertionSpec) for assertion in greeting.expect)
        assert greeting.expect[0].type == 'contains'
        assert greeting.expect[0].params == {'value': 'hello', 'ignore_case': True}
        assert greeting.expect[6].params == {'path': 'a.b.0.c', 'equals': 5, 'gte': 1, 'lte': 10}
        assert greeting.expect[8].params == {'criteria': 'Politely greets the user', 'min_score': 0.5}

        follow_up = spec.cases[1]
        assert follow_up.judge_pipeline == os.path.normpath(str(tmp_path / 'judges' / 'case-judge.pipe'))

    def test_optional_fields_default_to_none(self, tmp_path):
        path = write_spec(tmp_path, minimal_spec())

        spec = load_spec(path)

        assert spec.source is None
        assert spec.judge_pipeline is None
        assert spec.cases[0].judge_pipeline is None

    def test_relative_pipeline_path_resolves_against_spec_dir(self, tmp_path):
        # The spec lives in a subdirectory; the pipeline path climbs out of it
        nested = tmp_path / 'suites'
        nested.mkdir()
        path = write_spec(nested, minimal_spec(pipeline='../pipes/chat.pipe'))

        spec = load_spec(path)

        assert spec.pipeline == os.path.normpath(str(tmp_path / 'pipes' / 'chat.pipe'))

    def test_absolute_pipeline_path_passes_through(self, tmp_path):
        absolute = str(tmp_path / 'abs' / 'chat.pipe')
        path = write_spec(tmp_path, minimal_spec(pipeline=absolute))

        spec = load_spec(path)

        assert spec.pipeline == os.path.normpath(absolute)

    def test_llm_judge_min_score_boundaries_are_valid(self, tmp_path):
        for score in (0, 1, 0.0, 1.0):
            document = minimal_spec()
            document['cases'][0]['expect'] = [{'type': 'llm_judge', 'criteria': 'ok', 'min_score': score}]
            spec = load_spec(write_spec(tmp_path, document))
            assert spec.cases[0].expect[0].params['min_score'] == score


class TestLoadSpecFileErrors:
    def test_missing_file(self, tmp_path):
        missing = str(tmp_path / 'nope.eval.json')

        with pytest.raises(EvalSpecError, match='not found'):
            load_spec(missing)

    def test_invalid_json(self, tmp_path):
        path = tmp_path / 'broken.eval.json'
        path.write_text('{ not valid json', encoding='utf-8')

        with pytest.raises(EvalSpecError, match='Invalid JSON'):
            load_spec(str(path))

    def test_non_utf8_file_raises_spec_error(self, tmp_path):
        """A cp1252-encoded spec must surface as EvalSpecError (CLI exit 2)."""
        path = tmp_path / 'latin.eval.json'
        document = minimal_spec()
        document['cases'][0]['input'] = 'café naïve'
        path.write_bytes(json.dumps(document, ensure_ascii=False).encode('cp1252'))

        with pytest.raises(EvalSpecError, match='not valid UTF-8'):
            load_spec(str(path))

    def test_top_level_not_object(self, tmp_path):
        path = tmp_path / 'array.eval.json'
        path.write_text('[1, 2, 3]', encoding='utf-8')

        with pytest.raises(EvalSpecError, match='JSON object'):
            load_spec(str(path))

    def test_error_message_includes_file_path(self, tmp_path):
        path = write_spec(tmp_path, {'cases': []})

        with pytest.raises(EvalSpecError, match='sample.eval.json'):
            load_spec(path)


class TestLoadSpecValidationErrors:
    def test_missing_pipeline(self, tmp_path):
        document = minimal_spec()
        del document['pipeline']

        with pytest.raises(EvalSpecError, match="'pipeline'"):
            load_spec(write_spec(tmp_path, document))

    def test_pipeline_not_a_string(self, tmp_path):
        with pytest.raises(EvalSpecError, match="'pipeline'"):
            load_spec(write_spec(tmp_path, minimal_spec(pipeline={'nested': True})))

    def test_source_not_a_string(self, tmp_path):
        with pytest.raises(EvalSpecError, match="'source'"):
            load_spec(write_spec(tmp_path, minimal_spec(source=42)))

    def test_judge_pipeline_not_a_string(self, tmp_path):
        with pytest.raises(EvalSpecError, match="'judge_pipeline'"):
            load_spec(write_spec(tmp_path, minimal_spec(judge_pipeline=[])))

    def test_missing_cases(self, tmp_path):
        document = minimal_spec()
        del document['cases']

        with pytest.raises(EvalSpecError, match="'cases'"):
            load_spec(write_spec(tmp_path, document))

    def test_empty_cases(self, tmp_path):
        with pytest.raises(EvalSpecError, match="'cases'"):
            load_spec(write_spec(tmp_path, minimal_spec(cases=[])))

    def test_case_not_an_object(self, tmp_path):
        with pytest.raises(EvalSpecError, match=r'cases\[0\]'):
            load_spec(write_spec(tmp_path, minimal_spec(cases=['just a string'])))

    def test_case_missing_name(self, tmp_path):
        document = minimal_spec()
        del document['cases'][0]['name']

        with pytest.raises(EvalSpecError, match="'name'"):
            load_spec(write_spec(tmp_path, document))

    def test_duplicate_case_names(self, tmp_path):
        document = minimal_spec()
        document['cases'].append(dict(document['cases'][0]))

        with pytest.raises(EvalSpecError, match='duplicate case name'):
            load_spec(write_spec(tmp_path, document))

    def test_case_missing_input(self, tmp_path):
        document = minimal_spec()
        del document['cases'][0]['input']

        with pytest.raises(EvalSpecError, match="case 'greeting'.*'input'"):
            load_spec(write_spec(tmp_path, document))

    def test_case_missing_expect(self, tmp_path):
        document = minimal_spec()
        del document['cases'][0]['expect']

        with pytest.raises(EvalSpecError, match="'expect'"):
            load_spec(write_spec(tmp_path, document))

    def test_case_empty_expect(self, tmp_path):
        document = minimal_spec()
        document['cases'][0]['expect'] = []

        with pytest.raises(EvalSpecError, match="'expect'"):
            load_spec(write_spec(tmp_path, document))

    def test_assertion_not_an_object(self, tmp_path):
        document = minimal_spec()
        document['cases'][0]['expect'] = ['contains']

        with pytest.raises(EvalSpecError, match=r'expect\[0\]'):
            load_spec(write_spec(tmp_path, document))

    def test_assertion_missing_type(self, tmp_path):
        document = minimal_spec()
        document['cases'][0]['expect'] = [{'value': 'hello'}]

        with pytest.raises(EvalSpecError, match="'type'"):
            load_spec(write_spec(tmp_path, document))

    def test_unknown_assertion_type(self, tmp_path):
        document = minimal_spec()
        document['cases'][0]['expect'] = [{'type': 'sentiment', 'value': 'positive'}]

        with pytest.raises(EvalSpecError, match="unknown assertion type 'sentiment'"):
            load_spec(write_spec(tmp_path, document))

    def test_error_message_includes_case_context(self, tmp_path):
        document = minimal_spec()
        document['cases'][0]['expect'] = [{'type': 'contains'}]

        with pytest.raises(EvalSpecError, match=r"case 'greeting': expect\[0\]"):
            load_spec(write_spec(tmp_path, document))

    @pytest.mark.parametrize(
        'assertion',
        [
            {'type': 'contains'},  # missing value
            {'type': 'contains', 'value': 5},  # non-string value
            {'type': 'contains', 'value': 'x', 'ignore_case': 'yes'},  # non-bool flag
            {'type': 'not_contains'},  # missing value
            {'type': 'regex'},  # missing pattern
            {'type': 'regex', 'pattern': '('},  # invalid regex
            {'type': 'equals'},  # missing value
            {'type': 'equals', 'value': 'x', 'strip': 'always'},  # non-bool strip
            {'type': 'min_length'},  # missing value
            {'type': 'min_length', 'value': 'five'},  # non-int value
            {'type': 'min_length', 'value': True},  # bool is not an int here
            {'type': 'max_length', 'value': -1},  # negative length
            {'type': 'json_path'},  # missing path
            {'type': 'json_path', 'path': 'a.b', 'gte': 'low'},  # non-number bound
            {'type': 'latency_max_ms'},  # missing value
            {'type': 'latency_max_ms', 'value': 'fast'},  # non-number value
            {'type': 'latency_max_ms', 'value': 0},  # non-positive value
            {'type': 'llm_judge'},  # missing criteria
            {'type': 'llm_judge', 'criteria': ''},  # empty criteria
            {'type': 'llm_judge', 'criteria': 'ok', 'min_score': 1.5},  # > 1
            {'type': 'llm_judge', 'criteria': 'ok', 'min_score': -0.1},  # < 0
            {'type': 'llm_judge', 'criteria': 'ok', 'min_score': 'high'},  # non-number
        ],
    )
    def test_invalid_assertion_parameters(self, tmp_path, assertion):
        document = minimal_spec()
        document['cases'][0]['expect'] = [assertion]

        with pytest.raises(EvalSpecError):
            load_spec(write_spec(tmp_path, document))

    @pytest.mark.parametrize(
        'assertion',
        [
            # Each entry is valid except for one unknown/misspelled key; the
            # loader must reject it instead of silently ignoring the typo.
            {'type': 'contains', 'value': 'x', 'ignoreCase': True},  # camelCase typo
            {'type': 'not_contains', 'value': 'x', 'ignore_cas': True},  # misspelled flag
            {'type': 'regex', 'patern': 'h.llo', 'pattern': 'h.llo'},  # misspelled pattern
            {'type': 'equals', 'value': 'x', 'stripped': True},  # misspelled strip
            {'type': 'min_length', 'value': 1, 'min': 1},  # stray extra key
            {'type': 'max_length', 'value': 10, 'inclusive': True},  # unsupported option
            {'type': 'json_path', 'path': 'a.b', 'eq': 5},  # misspelled equals
            {'type': 'latency_max_ms', 'value': 1000, 'percentile': 95},  # unsupported option
            {'type': 'llm_judge', 'criteria': 'ok', 'min_scor': 0.5},  # misspelled min_score
        ],
    )
    def test_unknown_assertion_parameter_keys_are_rejected(self, tmp_path, assertion):
        document = minimal_spec()
        document['cases'][0]['expect'] = [assertion]

        with pytest.raises(EvalSpecError, match='unknown parameter'):
            load_spec(write_spec(tmp_path, document))

    def test_unknown_parameter_error_names_key_and_allowed_set(self, tmp_path):
        document = minimal_spec()
        document['cases'][0]['expect'] = [{'type': 'contains', 'value': 'x', 'ignoreCase': True}]

        with pytest.raises(
            EvalSpecError,
            match=r"case 'greeting': expect\[0\]: 'contains': unknown parameter\(s\) 'ignoreCase' "
            r"\(allowed parameters: 'ignore_case', 'value'\)",
        ):
            load_spec(write_spec(tmp_path, document))
