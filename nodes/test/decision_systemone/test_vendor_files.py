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
"""Every System One services file: profiles complete, limits sane, credentials registered (spec A5)."""

import json
import re
from pathlib import Path

import pytest

NODE = Path(__file__).parent.parent.parent / 'src' / 'nodes' / 'decision_systemone'
CREDENTIALS = Path(__file__).parents[3] / 'packages' / 'ai' / 'src' / 'ai' / 'modules' / 'mcp' / 'credentials.json'
LIMIT_KEYS = {'max_options', 'max_levels', 'max_questions', 'max_state_tokens'}
# Every lane IInstance decides on; each forwards to itself.
LANES = ('text', 'documents', 'table', 'questions', 'answers', 'json')


def _load(path: Path) -> dict:
    return json.loads(re.sub(r'(?m)^\s*//.*$', '', path.read_text()))


FILES = {path.name: _load(path) for path in sorted(NODE.glob('services*.json'))}


def test_expected_vendor_files_exist():
    assert set(FILES) == {
        'services.json',
        'services.ollama.json',
        'services.typesafe.json',
        'services.openrouter.json',
        'services.routmy.json',
        'services.laya.json',
        'services.clm.json',
        'services.superagent.json',
    }


@pytest.mark.parametrize('name', sorted(FILES))
def test_every_profile_has_model_serverbase_and_limits(name):
    for key, profile in FILES[name]['preconfig']['profiles'].items():
        # An empty serverbase is allowed where the user supplies the URL (the services.json custom profile).
        assert 'serverbase' in profile and (
            profile['serverbase'] == '' or str(profile['serverbase']).startswith(('http://', 'https://'))
        ), (name, key)
        assert 'model' in profile, (name, key)
        assert LIMIT_KEYS <= set(profile['limits']), (name, key)


@pytest.mark.parametrize('name', sorted(FILES))
def test_every_file_declares_every_lane(name):
    assert FILES[name]['lanes'] == {lane: [lane] for lane in LANES}


@pytest.mark.parametrize('name', sorted(FILES))
def test_icon_sits_next_to_the_file(name):
    assert (NODE / FILES[name]['icon']).is_file()


def test_new_profiles_and_their_limits():
    ollama = FILES['services.ollama.json']['preconfig']['profiles']
    assert {'clef', 'clef-flash'} <= set(ollama) and ollama['clef']['model'] == 'clef'
    assert 'jev-preview' in FILES['services.typesafe.json']['preconfig']['profiles']
    laya = FILES['services.laya.json']['preconfig']['profiles']
    assert (
        laya['english']['limits']['state_tokens_only'] is True and laya['english']['limits']['max_state_tokens'] <= 450
    )
    assert laya['multilingual']['limits']['max_state_tokens'] <= 950
    # Non-Latin text packs fewer characters per token, so the two 1,024-token profiles estimate pessimistically.
    assert laya['english']['limits']['chars_per_token'] == 4
    assert laya['multilingual']['limits']['chars_per_token'] == 3
    assert laya['typed-decisions']['limits']['chars_per_token'] == 3
    clm = FILES['services.clm.json']['preconfig']['profiles']
    assert clm['clm-latest']['limits']['state_tokens_only'] is True
    assert clm['clm-latest']['limits']['max_state_tokens'] <= 2000
    superagent = FILES['services.superagent.json']['preconfig']['profiles']
    assert set(superagent) == {'security-one'} and superagent['security-one']['model'] == 'security-one'
    assert superagent['security-one']['limits']['max_options'] == 16


def test_hosted_vendors_have_credentials():
    credentials = json.loads(CREDENTIALS.read_text())
    for protocol in ('decision_routmy', 'decision_laya', 'decision_superagent'):
        field = credentials[protocol]['fields'][0]
        assert field['path'] == 'decision.apikey' and field['required'] is True, protocol
    assert credentials['decision_clm']['fields'][0]['required'] is False
