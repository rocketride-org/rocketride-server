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

"""Pure deploy/publish helpers (TS deploy-helpers twin)."""

import math

import pytest

from rocketride import (
    parse_registry_version,
    pick_publish_version,
    pipeline_name_from_path,
    resolve_deploy_teams,
    resolve_team_arg,
    team_name_of,
    wire_team_id_of,
)


class _Identity:
    def __init__(self, info):
        self._info = info

    def get_account_info(self):
        return self._info


ROSTER = _Identity(
    {
        'userId': 'u1',
        'organization': {
            'id': 'o',
            'name': 'Org',
            'permissions': [],
            'teams': [
                {'id': 't-qa', 'name': 'QA', 'permissions': ['task.control']},
                {'id': 't-prod', 'name': 'Production', 'permissions': []},
            ],
        },
    }
)


def test_parse_registry_version_accepts_ints_strings_and_v_prefix():
    assert parse_registry_version(3) == 3
    assert parse_registry_version(' 12 ') == 12
    assert parse_registry_version('v4') == 4


@pytest.mark.parametrize('value', [0, -1, 1.5, '', 'abc', None, math.nan, True])
def test_parse_registry_version_rejects(value):
    with pytest.raises(ValueError, match='Invalid registry version'):
        parse_registry_version(value)


def _row(version, state, build):
    return {'registryVersion': version, 'state': state, 'buildStatus': build}


def test_pick_publish_version_takes_the_newest_non_failed_even_while_building():
    rows = [_row(1, 'private', 'ok'), _row(3, 'private', 'building'), _row(2, 'private', 'ok')]
    assert pick_publish_version(rows)['registryVersion'] == 3


def test_pick_publish_version_skips_failed_builds_and_states():
    rows = [_row(1, 'ready', 'ok'), _row(2, 'private', 'failed'), _row(3, 'failed', 'ok')]
    assert pick_publish_version(rows)['registryVersion'] == 1


def test_pick_publish_version_is_none_when_nothing_qualifies():
    assert pick_publish_version([_row(1, 'private', 'failed')]) is None
    assert pick_publish_version([]) is None


def test_resolve_deploy_teams_lists_me_first_then_the_roster():
    assert resolve_deploy_teams(ROSTER, []) == [
        {'id': '@me', 'name': 'Me', 'canControl': True},
        {'id': 't-qa', 'name': 'QA', 'canControl': True},
        {'id': 't-prod', 'name': 'Production', 'canControl': False},
    ]


def test_resolve_deploy_teams_rosterless_derives_from_rows_never_personal():
    teams = resolve_deploy_teams(
        _Identity({'userId': 'u1', 'organization': None}),
        [{'teamId': 'local'}, {'teamId': 'user~u1'}, {'teamId': 'local'}],
    )
    assert [t['id'] for t in teams] == ['@me', 'local']


def test_resolve_deploy_teams_admin_controls_every_team():
    admin = _Identity(
        {'userId': 'u1', 'sysPermissions': ['sys.admin'], 'organization': {'teams': [{'id': 't', 'name': 'T'}]}}
    )
    assert resolve_deploy_teams(admin, [])[1]['canControl'] is True


def test_resolve_team_arg_maps_me_ids_and_names():
    teams = resolve_deploy_teams(ROSTER, [])
    assert resolve_team_arg('@me', teams) == '@me'
    assert resolve_team_arg('t-qa', teams) == 't-qa'
    assert resolve_team_arg('production', teams) == 't-prod'
    assert resolve_team_arg('t-other', teams) == 't-other'
    assert resolve_team_arg('', teams) == ''


def test_resolve_team_arg_refuses_an_ambiguous_name():
    teams = [{'id': 'a', 'name': 'Ops', 'canControl': True}, {'id': 'b', 'name': 'ops', 'canControl': True}]
    with pytest.raises(ValueError, match='ambiguous.*a, b'):
        resolve_team_arg('OPS', teams)


def test_team_name_of_names_personal_spaces_and_falls_back():
    teams = resolve_deploy_teams(ROSTER, [])
    assert team_name_of(teams, 'user~u1', 'u1') == 'Me'
    assert team_name_of(teams, 'user~u2', 'u1') == 'Personal'
    assert team_name_of(teams, 't-qa', 'u1') == 'QA'
    assert team_name_of(teams, 't-gone', 'u1') == 't-gone'


def test_wire_team_id_of_addresses_own_space_as_me():
    assert wire_team_id_of('user~u1', 'u1') == '@me'
    assert wire_team_id_of('t-qa', 'u1') == 't-qa'


def test_pipeline_name_from_path_strips_pipe_extensions():
    assert pipeline_name_from_path('pipelines/ingest.pipe') == 'ingest'
    assert pipeline_name_from_path('C:\work\chat.pipe.json') == 'chat'
    assert pipeline_name_from_path('plain.json') == 'plain.json'
