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

"""The engine key is PURE (ALB seam 1, plan 7.2).

``modules/task/engine_key.py`` imports the standard library only, so a front
end that is not the task server computes the same key from the same inputs.
Parity: the key computed in this (server) process equals the key a bare
``python -c`` computes after loading the file by path, with no package on
``sys.path``.
"""

import ast
import json
import subprocess
import sys
from pathlib import Path

from ai.modules.task import engine_key as engine_key_module
from ai.modules.task.engine_key import connections_of, engine_key, properties_digest

MODULE_PATH = Path(engine_key_module.__file__).resolve()

#: A resolved fixture: two components, wiring out of file order, a placeholder.
FIXTURE = {
    'resolved_config': {
        'webhook_1': {'type': 'webhook', 'mode': 'Source'},
        'prompt_1': {'instructions': ['${ROCKETRIDE_TONE}'], 'depth': 2},
    },
    'types': {'webhook_1': 'webhook', 'prompt_1': 'prompt'},
    'components': [
        {'id': 'webhook_1'},
        {
            'id': 'prompt_1',
            'input': [{'lane': 'text', 'from': 'webhook_1'}, {'lane': 'questions', 'from': 'webhook_1'}],
        },
    ],
    'source': 'webhook_1',
}

#: The bare-interpreter side: load the file by path, compute both key kinds.
BARE = r"""
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('engine_key_bare', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
fixture = json.loads(sys.argv[2])
wiring = {c['id']: module.connections_of(c) for c in fixture['components']}
args = (fixture['types'], wiring, fixture['source'])
digest = module.properties_digest(4, ['--x'])
print(json.dumps([module.engine_key(*args, rung='spec', owner_id=''),
                  module.engine_key(*args, rung='spec', owner_id='user-a'),
                  module.engine_key(*args, rung='public', owner_id='user-a'),
                  module.engine_key(*args, rung='me', owner_id='user-a', private=True),
                  module.engine_key(*args, rung='spec', owner_id='user-a', properties=digest)]))
"""


def _server_keys():
    """Every key kind (bare, owner-qualified, published, private, off-policy) computed in this process."""
    wiring = {c['id']: connections_of(c) for c in FIXTURE['components']}
    args = (FIXTURE['types'], wiring, FIXTURE['source'])
    digest = properties_digest(4, ['--x'])
    return [
        engine_key(*args, rung='spec', owner_id=''),
        engine_key(*args, rung='spec', owner_id='user-a'),
        engine_key(*args, rung='public', owner_id='user-a'),
        engine_key(*args, rung='me', owner_id='user-a', private=True),
        engine_key(*args, rung='spec', owner_id='user-a', properties=digest),
    ]


def test_engine_key_parity_between_the_server_and_a_bare_interpreter():
    """The same fixture keys the same in the server process and a bare python -c."""
    result = subprocess.run(
        [sys.executable, '-c', BARE, str(MODULE_PATH), json.dumps(FIXTURE)],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(MODULE_PATH.parent.parent.parent.parent.parent),
    )
    assert result.returncode == 0, result.stderr
    bare = json.loads(result.stdout.strip().splitlines()[-1])

    server = _server_keys()
    assert bare == server
    assert server[1] == f'{server[0]}:user-a'
    assert server[2] == server[0] and server[3] == server[1]
    assert server[4] == f'{server[0]}+{properties_digest(4, ["--x"])}:user-a'


def test_engine_key_imports_the_standard_library_only():
    """No ai.*, rocketlib, engLib, asyncio or relative import: the module stays pure.

    ``sys`` is there to LOOK UP the engine's ``pipelineStack`` binding in
    ``sys.modules`` (C.23); the engine itself is never imported.
    """
    tree = ast.parse(MODULE_PATH.read_text(encoding='utf-8'))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split('.')[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0, 'relative import in engine_key.py'
            imported.add((node.module or '').split('.')[0])
    assert imported <= {'hashlib', 'json', 'sys', 'typing'}, imported


def test_avoid_mocks_is_part_of_the_content_identity():
    """A spec that strips ROCKETRIDE_MOCK from its engine (avoidMocks) is another engine."""
    from ai.modules.task.engine_key import content_hash, engine_content

    parts = dict(types={'a': 'webhook'}, connections={'a': connections_of({})}, source='a')
    assert content_hash(**parts) == content_hash(**parts, avoid_mocks=False)
    assert content_hash(**parts) != content_hash(**parts, avoid_mocks=True)

    def facts(provider, stored):
        """A one-line catalog stand-in: every component resolves to its stored config, a door source."""
        return stored, ('source', 'webhook')

    spec = {'components': [{'id': 'a', 'provider': 'webhook', 'config': {}}], 'source': 'a'}
    plain = engine_content(spec, 'a', facts)
    mocked = engine_content({**spec, 'avoidMocks': True}, 'a', facts)
    assert (plain.avoid_mocks, mocked.avoid_mocks) == (False, True)
    assert plain.content_hash != mocked.content_hash


def test_configuration_is_out_of_the_engine_key_and_kept_for_the_control():
    """Plan 7.2: the key is the shape; the resolved config is kept, by id and by stack index, never hashed."""
    from ai.modules.task.engine_key import engine_content

    def facts(provider, stored):
        return {'provider': provider, **stored}, ('source', 'webhook')

    spec = {
        'source': 'a',
        'components': [
            {'id': 'a', 'provider': 'webhook', 'config': {}},
            {'id': 'b', 'provider': 'prompt', 'config': {'tone': 'dry'}, 'input': [{'lane': 'x', 'from': 'a'}]},
        ],
    }
    other = {**spec, 'components': [spec['components'][0], {**spec['components'][1], 'config': {'tone': 'wet'}}]}
    dry, wet = engine_content(spec, 'a', facts), engine_content(other, 'a', facts)
    assert dry.content_hash == wet.content_hash
    assert dry.config_by_index == [{'provider': 'webhook'}, {'provider': 'prompt', 'tone': 'dry'}]
    assert dry.stored_by_index == [{}, {'tone': 'dry'}]
    assert wet.config_by_index[1]['tone'] == 'wet'
    assert dry.resolved_config['b'] is dry.config_by_index[1]
