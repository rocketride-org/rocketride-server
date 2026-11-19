"""Live smoke test for tool_linear's client.

Skipped unless ROCKETRIDE_LINEAR_API_KEY and ROCKETRIDE_LINEAR_TEST_TEAM are
set. Read-only: it never creates or changes anything.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

_KEY = os.environ.get('ROCKETRIDE_LINEAR_API_KEY', '')
_TEAM = os.environ.get('ROCKETRIDE_LINEAR_TEST_TEAM', '')

pytestmark = pytest.mark.skipif(not (_KEY and _TEAM), reason='live Linear credentials not set')

_PATH = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_linear' / 'linear_client.py'


def _client():
    spec = importlib.util.spec_from_file_location('linear_client_live', _PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_viewer_and_team_search():
    lc = _client()
    assert lc.post(lc.Q_VIEWER, api_key=_KEY)['viewer']['id']
    flt = lc.build_issue_filter(allowed_teams=[_TEAM.upper()], team_key=_TEAM)
    data = lc.post(lc.Q_ISSUES, {'filter': flt, 'first': 5}, api_key=_KEY)
    for node in data['issues']['nodes']:
        assert node['team']['key'].upper() == _TEAM.upper()
