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

"""The retired audience spellings: translated in ONE function, refused everywhere else (plan 2.5, B45).

This is the test file of ``legacy_audience.py``, the one OSS read-time
translator, and the only test file allowed to spell the retired forms (the
repository gate, ``test_retired_spellings_gate.py``, exempts the two). It
pins the translation, that every decoder of ``audience.py`` and ``roots.py``
refuses the retired forms rather than reading them as a team, and that a
registry file an older release wrote reads in the new strings and is written
back in them by the next write.
"""

import json
import shutil
import tempfile

import pytest

from ai.account.audience import AudienceError, is_audience, parse_audience, parse_owner, parse_target, rung_of
from ai.account.deployment_backend import FileDeploymentBackend
from ai.account.legacy_audience import translate_legacy_audience
from ai.account.roots import parse_root
from ai.account.store_providers.filesystem import FilesystemStore

#: The four retired spellings, as an older release wrote them.
RETIRED = ['user~u1', 'team~t1', 'org~o1', '~public']

ACTOR = {'userId': 'user-1', 'display': 'Rod C', 'email': 'rod@example.com'}
PIPE = {'project_id': 'proj-1', 'name': 'Invoice Ingest', 'source': 'webhook_1', 'components': []}


@pytest.fixture
def store():
    """A throwaway filesystem IStore."""
    temp_path = tempfile.mkdtemp()
    yield FilesystemStore(f'filesystem://{temp_path}')
    shutil.rmtree(temp_path, ignore_errors=True)


@pytest.fixture
def backend(store):
    """The file deployment backend over the throwaway store."""
    return FileDeploymentBackend(store)


# ============================================================================
# The translator
# ============================================================================


@pytest.mark.parametrize(
    ('old', 'new'),
    [
        ('user~u1', '=user/u1'),
        ('team~t1', '=team/t1'),
        ('~public', '@public'),
        # A bare team id: what the pointer map's team slots held
        ('local', '=team/local'),
        ('t-1', '=team/t-1'),
        # Already the grammar: normalized, never re-read as a team
        ('=user/u1', '=user/u1'),
        ('=org/o1', '=org/o1'),
        ('@public', '@public'),
        ('=TEAM/t1', '=team/t1'),
    ],
)
def test_translates(old, new):
    assert translate_legacy_audience(old) == new


def test_refuses_what_carries_no_usable_id():
    for bad in ('', 'user~', 'team~', 'user~a/b', 'a/b'):
        with pytest.raises(AudienceError):
            translate_legacy_audience(bad)


# ============================================================================
# Every other decoder refuses them
# ============================================================================


@pytest.mark.parametrize('old', RETIRED)
def test_no_decoder_reads_a_retired_spelling(old):
    for decode in (parse_audience, parse_owner, parse_target):
        with pytest.raises(AudienceError):
            decode(old)
    with pytest.raises(AudienceError):
        rung_of(old, 'u1')
    assert not is_audience(old)


@pytest.mark.parametrize('old', RETIRED)
def test_the_root_grammar_reads_a_retired_spelling_as_plain_text(old):
    # No root, so never a team: the audience decoders above refuse it
    assert parse_root(old).kind == 'none'


# ============================================================================
# An OSS registry file written by an older release
# ============================================================================


@pytest.mark.asyncio
async def test_a_registry_file_in_the_retired_spellings_reads_in_the_grammar_and_is_rewritten(backend, store):
    """The publish map's keys and the history rows' teamId translate at read; the next write stores the new form."""
    await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
    await backend.deploy('org-1', '=team/team-a', 'acme.proj-1', 1, ACTOR, 'team-a')
    await backend.deploy('org-1', '=user/u1', 'acme.proj-1', 1, ACTOR, 'team-a')
    await backend.deploy('org-1', '@public', 'acme.proj-1', 1, ACTOR, 'team-a')

    # Step 1: write the file back as the older release left it
    old = {'=team/team-a': 'team~team-a', '=user/u1': 'user~u1', '@public': '~public'}
    old_history = {'=team/team-a': 'team-a', '=user/u1': 'user~u1', '@public': '~public'}
    path = backend._meta_path('org-1', 'acme.proj-1')
    meta = json.loads(await store.read_file(path))
    meta['publishes'] = {old[key]: row for key, row in meta['publishes'].items()}
    for event in meta['history']:
        if event.get('teamId'):
            event['teamId'] = old_history[event['teamId']]
    await store.write_file(path, json.dumps(meta))

    # Step 2: every read answers in the one grammar
    new = ['=team/team-a', '=user/u1', '@public']
    assert sorted(d['teamId'] for d in await backend.list_team('org-1')) == new
    assert (await backend.get('org-1', '=user/u1', 'acme.proj-1'))['version'] == 1
    rows = await backend.publish_of_app('org-1', 'pipe', 'acme.proj-1')
    assert sorted((r['audience']['type'], r['audience']['id']) for r in rows) == [
        ('public', ''),
        ('team', 'team-a'),
        ('user', 'u1'),
    ]
    history = (await backend.history('org-1', 'acme.proj-1'))['rows']
    assert sorted({r['teamId'] for r in history} - {''}) == new
    assert [
        r['teamId'] for r in (await backend.history('org-1', 'acme.proj-1', '=user/u1'))['rows'] if r['teamId']
    ] == ['=user/u1']
    feed = [d['teamId'] async for d in backend.iter_enabled()]
    assert sorted(feed) == new

    # Step 3: the next write stores the new form
    await backend.set_state('org-1', '=team/team-a', 'acme.proj-1', 'disabled', ACTOR)
    rewritten = json.loads(await store.read_file(path))
    assert sorted(rewritten['publishes']) == new
    assert {e['teamId'] for e in rewritten['history'] if e.get('teamId')} == set(new)
    assert not any(old_key in json.dumps(rewritten) for old_key in ('user~', 'team~', '~public'))


@pytest.mark.asyncio
async def test_a_pre_c17_pointer_map_keyed_by_the_retired_spellings_folds_into_the_grammar(backend, store):
    """The pre-C.17 ``deployments`` dict (team ids and personal slots) folds into publish rows keyed by audience."""
    await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
    path = backend._meta_path('org-1', 'acme.proj-1')
    meta = json.loads(await store.read_file(path))
    meta.pop('publishes', None)
    pointer = {'version': 1, 'state': 'enabled', 'billingTeamId': 'team-a', 'schedules': {}}
    meta['deployments'] = {'team-a': {**pointer, 'teamId': 'team-a'}, 'user~u1': {**pointer, 'teamId': 'user~u1'}}
    await store.write_file(path, json.dumps(meta))

    assert sorted(d['teamId'] for d in await backend.list_team('org-1')) == ['=team/team-a', '=user/u1']
    await backend.set_state('org-1', '=user/u1', 'acme.proj-1', 'disabled', ACTOR)
    rewritten = json.loads(await store.read_file(path))
    assert 'deployments' not in rewritten
    assert sorted(rewritten['publishes']) == ['=team/team-a', '=user/u1']
