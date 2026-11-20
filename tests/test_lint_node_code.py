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

"""
The node-code lint (plan 4.3): red on each rule's fixture, green on every catalog node.

Each fixture is a minimal node package written to ``tmp_path``; the lint parses
it and never imports it.
"""

import importlib.util
import json
import textwrap
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[1] / 'scripts' / 'lint-node-code.py'
SPEC = importlib.util.spec_from_file_location('lint_node_code', SCRIPT)
LINT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(LINT)

NODES_ROOT = Path(__file__).parents[1] / 'nodes' / 'src' / 'nodes'


# =============================================================================
# Helpers
# =============================================================================


def write_node(tmp_path: Path, sources: dict, services: dict | None = None) -> Path:
    """Write a fixture node package: ``{file name: source}`` plus a services.json."""
    node = tmp_path / 'fixture_node'
    node.mkdir()
    (node / '__init__.py').write_text('', encoding='utf-8')
    for name, source in sources.items():
        (node / name).write_text(textwrap.dedent(source), encoding='utf-8')
    (node / 'services.json').write_text(
        json.dumps(services or {'title': 'Fixture', 'protocol': 'fixture://', 'properties': []}), encoding='utf-8'
    )
    return node


def rules(node: Path) -> list:
    """Return the rule ids the lint reports for a node, in order."""
    return [f.rule for f in LINT.lint_node(node)]


# =============================================================================
# The plan's two named fixtures
# =============================================================================


def test_a_host_keyed_module_cache_is_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                from rocketlib import IGlobalBase

                _CLIENTS = {}

                class IGlobal(IGlobalBase):
                    def beginGlobal(self):
                        host = self.config.host
                        if host not in _CLIENTS:
                            _CLIENTS[host] = object()
                        self.client = _CLIENTS[host]

                    def endGlobal(self):
                        self.client = None
            """
        },
    )
    assert rules(node) == ['module-cache']


def test_a_glb_read_is_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                from rocketlib import IGlobalBase

                class IGlobal(IGlobalBase):
                    def beginGlobal(self):
                        self.provider = self.glb.logicalType
            """
        },
    )
    assert rules(node) == ['glb-pipetype']


# =============================================================================
# One fixture per remaining rule
# =============================================================================


def test_a_pipetype_read_is_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IInstance.py': """
                class IInstance:
                    def describe(self):
                        return self.instance.pipeType['id']
            """
        },
    )
    assert rules(node) == ['glb-pipetype']


def test_a_global_rebound_from_config_is_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                _CLIENT = None

                class IGlobal:
                    def beginGlobal(self):
                        global _CLIENT
                        _CLIENT = make_client(self.config.host)
            """
        },
    )
    assert rules(node) == ['module-cache']


def test_an_lru_cache_keyed_from_config_is_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                from functools import lru_cache

                @lru_cache(maxsize=8)
                def _client(host):
                    return object()

                class IGlobal:
                    def beginGlobal(self):
                        cfg = self.config
                        self.handle = _client(cfg.host)

                    def endGlobal(self):
                        self.handle = None
            """
        },
    )
    assert rules(node) == ['module-cache']


def test_a_bag_write_is_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'chat.py': """
                class Chat:
                    def __init__(self, bag):
                        bag['chat'] = self
            """
        },
    )
    assert rules(node) == ['bag-write']


def test_a_bag_delete_and_update_are_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                class IGlobal:
                    def endGlobal(self):
                        del self.IEndpoint.endpoint.bag['x']
                        self.IEndpoint.endpoint.bag.update(y=1)
            """
        },
    )
    assert rules(node) == ['bag-write', 'bag-write']


def test_a_class_level_mutable_on_iinstance_is_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IInstance.py': """
                class IInstance:
                    rows = []
                    seen: dict = {}
                    name: str = ''
            """
        },
    )
    assert rules(node) == ['class-mutable', 'class-mutable']


def test_print_and_logging_are_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'helper.py': """
                import logging

                def report(x):
                    print(x)
            """
        },
    )
    assert rules(node) == ['print-logging', 'print-logging']


def test_a_begin_global_resource_end_global_drops_nothing_of_is_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                class IGlobal:
                    def beginGlobal(self):
                        self.pool = ConnectionPool(self.config.dsn)
                        self.session = self._open_session()
                        self.url = self.config.url.rstrip('/')

                    def _open_session(self):
                        return object()

                    def endGlobal(self):
                        self._close()

                    def _close(self):
                        self.session = None
            """
        },
    )
    findings = LINT.lint_node(node)
    assert [f.rule for f in findings] == ['global-unclosed']
    assert 'self.pool' in findings[0].message


def test_a_begin_global_without_end_global_is_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                class IGlobal:
                    def beginGlobal(self):
                        self.client = connect_client(self.config.host)
            """
        },
    )
    assert rules(node) == ['global-unclosed']


def test_a_param_read_through_config_in_begin_global_is_refused(tmp_path):
    services = {
        'title': 'Fixture',
        'protocol': 'fixture://',
        'propertyDefinitions': {'fixture.maxEdge': {'type': 'integer', 'default': 640, 'param': True}},
        'properties': ['fixture.maxEdge', {'name': 'model', 'type': 'string'}],
    }
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                class IGlobal:
                    def beginGlobal(self):
                        cfg = self.config
                        self.model = cfg.model
                        self.edge = self.config.maxEdge
                        self.other = cfg.get('maxEdge')
            """
        },
        services,
    )
    assert rules(node) == ['param-in-global', 'param-in-global']


def test_caller_writes_are_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IInstance.py': """
                class IInstance:
                    caller = None

                    def run(self):
                        self.caller = 'x'
                        self._caller = 'y'
            """
        },
    )
    assert rules(node) == ['caller-write', 'caller-write', 'caller-write']


def test_a_caller_identity_reaching_what_a_node_keeps_is_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IInstance.py': """
                class IInstance:
                    def keys(self, session):
                        owner = self.caller.userId
                        self.store.put(f'{owner}:{session}', 1)
                        self.cache[self.caller.orgId] = session
                        self.last = owner
                        return getattr(self.caller, 'teamId')

                    def raw(self):
                        return (getattr(self, '_caller', None) or {}).get('userId')
            """
        },
    )
    assert rules(node) == ['identity-persist'] * 5


def test_logging_and_the_doors_are_not_identity_sinks(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IInstance.py': """
                from rocketlib import debug


                class IInstance:
                    def run(self, value):
                        who = self.caller.userId
                        debug(f'call from {who}')
                        self.debug(str(who))
                        if who == 'admin':
                            self.state.put('last', value)
                        with self.state.lock('series'):
                            self.files.write('out.txt', who.encode())
                        level = self.caller.traceLevel
                        return level
            """
        },
    )
    assert LINT.lint_node(node) == []


def test_gc_inspect_stack_and_sys_modules_are_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IInstance.py': """
                import gc
                import inspect
                import sys

                def peek():
                    frames = inspect.stack()
                    other = sys.modules.get('nodes.other')
                    return frames, other, gc
            """
        },
    )
    assert rules(node) == ['introspection', 'introspection', 'introspection']


# =============================================================================
# Edges of each rule (review of PR #3392)
# =============================================================================


def test_jsonc_trailing_commas_go_but_commas_inside_strings_stay(tmp_path):
    node = write_node(tmp_path, {'IGlobal.py': 'X = 1\n'})
    (node / 'services.json').write_text(
        '{\n'
        '  // a comment\n'
        '  "propertyDefinitions": {"fixture.edge,}": {"type": "integer", "param": true,},},\n'
        '  "properties": ["fixture.edge,}",],\n'
        '}\n',
        encoding='utf-8',
    )
    assert LINT.param_names(node) == {'edge,}'}


def test_config_taint_crosses_a_branch_assignment(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                from functools import lru_cache

                @lru_cache(maxsize=8)
                def _client(address):
                    return object()

                class IGlobal:
                    def beginGlobal(self):
                        host = 'localhost'
                        if self.enabled:
                            host = self.config.host
                        address = host
                        self.handle = _client(address)

                    def endGlobal(self):
                        self.handle = None
            """
        },
    )
    assert rules(node) == ['module-cache']


def test_a_resource_built_twice_is_reported_at_its_earliest_line(tmp_path):
    source = """
        class IGlobal:
            def _first(self):
                self.client = connect_client(1)

            def _second(self):
                self.client = connect_client(2)

            def beginGlobal(self):
                self._second()
                self._first()
    """
    node = write_node(tmp_path, {'IGlobal.py': source})
    findings = LINT.lint_node(node)
    lines = (node / 'IGlobal.py').read_text(encoding='utf-8').splitlines()
    first = next(i for i, line in enumerate(lines, 1) if 'connect_client(1)' in line)
    assert [(f.rule, f.line) for f in findings] == [('global-unclosed', first)]


def test_a_chained_module_cache_write_is_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                _CLIENTS = {}

                def remember(host, client):
                    local = {}
                    _CLIENTS[host] = local[host] = client
                    return local
            """
        },
    )
    assert rules(node) == ['module-cache']


def test_a_parameter_or_local_named_like_a_module_container_is_not_the_module(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                _CLIENTS = {}

                def remember(_CLIENTS, key):
                    _CLIENTS[key] = 1

                def outer():
                    _CLIENTS = {}

                    def inner(key):
                        _CLIENTS[key] = 1

                    return inner
            """
        },
    )
    assert rules(node) == []


def test_an_annotated_bag_write_is_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'chat.py': """
                class Chat:
                    def __init__(self, bag):
                        bag['chat']: object = self
            """
        },
    )
    assert rules(node) == ['bag-write']


def test_unpacked_class_level_mutables_are_refused_one_by_one(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IInstance.py': """
                class IInstance:
                    rows, seen, name = [], {}, ''
            """
        },
    )
    findings = LINT.lint_node(node)
    assert [f.rule for f in findings] == ['class-mutable', 'class-mutable']
    assert {f.message.split(' ')[0] for f in findings} == {'IInstance.rows', 'IInstance.seen'}


def test_an_annotated_resource_end_global_never_drops_is_refused(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                class IGlobal:
                    client: object

                    def beginGlobal(self):
                        self.client: Client = Client(self.config.host)
            """
        },
    )
    assert rules(node) == ['global-unclosed']


def test_cleanup_in_an_uncalled_nested_function_does_not_count(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                class IGlobal:
                    def beginGlobal(self):
                        self.client = Client(self.config.host)

                    def endGlobal(self):
                        def later():
                            self.client.close()

                        return later
            """
        },
    )
    assert rules(node) == ['global-unclosed']


def test_a_config_alias_ends_at_its_reassignment(tmp_path):
    services = {
        'title': 'Fixture',
        'protocol': 'fixture://',
        'properties': [{'name': 'maxEdge', 'type': 'integer', 'param': True}],
    }
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                class IGlobal:
                    def beginGlobal(self):
                        cfg = self.config
                        self.a = cfg.maxEdge
                        cfg = {'maxEdge': 640}
                        self.b = cfg.get('maxEdge')
            """
        },
        services,
    )
    findings = LINT.lint_node(node)
    assert [f.rule for f in findings] == ['param-in-global']
    assert 'self.a' in (node / 'IGlobal.py').read_text(encoding='utf-8').splitlines()[findings[0].line - 1]


def test_caller_writes_are_found_inside_unpacking_and_annotations_are_not_writes(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IInstance.py': """
                class IInstance:
                    caller: object

                    def run(self, values):
                        self.caller: object
                        self.caller, self.name = values
            """
        },
    )
    assert rules(node) == ['caller-write']


def test_sys_modules_of_the_module_itself_is_allowed(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IInstance.py': """
                import sys

                def me():
                    return sys.modules[__name__], sys.modules.get(__name__)
            """
        },
    )
    assert rules(node) == []


def test_a_glb_write_is_not_a_read_but_an_augmented_one_is(tmp_path):
    node = write_node(
        tmp_path,
        {
            'helper.py': """
                def stamp(payload, value):
                    payload.glb = value
                    del payload.pipeType
                    payload.glb += 1
            """
        },
    )
    assert rules(node) == ['glb-pipetype']


def test_an_explicit_global_overrides_an_enclosing_binding(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                _CLIENTS = {}

                def outer():
                    _CLIENTS = {}

                    def inner(key, client):
                        global _CLIENTS
                        _CLIENTS[key] = client

                    return _CLIENTS, inner
            """
        },
    )
    assert rules(node) == ['module-cache']


def test_cleanup_in_a_local_function_end_global_calls_counts(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                class IGlobal:
                    def beginGlobal(self):
                        self.client = Client(self.config.host)

                    def endGlobal(self):
                        def close_client():
                            self.client.close()
                            self.client = None

                        close_client()
            """
        },
    )
    assert rules(node) == []


def test_a_config_alias_on_either_branch_survives_the_join(tmp_path):
    services = {
        'title': 'Fixture',
        'protocol': 'fixture://',
        'properties': [{'name': 'maxEdge', 'type': 'integer', 'param': True}],
    }
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                class IGlobal:
                    def beginGlobal(self):
                        if self.enabled:
                            cfg = self.config
                        else:
                            cfg = {}
                        self.edge = cfg.get('maxEdge')
                        cfg = {}
                        self.other = cfg.get('maxEdge')
            """
        },
        services,
    )
    findings = LINT.lint_node(node)
    assert [f.rule for f in findings] == ['param-in-global']
    assert 'self.edge' in (node / 'IGlobal.py').read_text(encoding='utf-8').splitlines()[findings[0].line - 1]


_MAX_EDGE_PARAM = {
    'title': 'Fixture',
    'protocol': 'fixture://',
    'properties': [{'name': 'maxEdge', 'type': 'integer', 'param': True}],
}


def _param_reads(tmp_path, body):
    """Lint a beginGlobal body against a schema whose maxEdge is a param; return the flagged source lines."""
    source = 'class IGlobal:\n    def beginGlobal(self):\n' + ''.join(f'        {line}\n' for line in body)
    node = write_node(tmp_path, {'IGlobal.py': source}, _MAX_EDGE_PARAM)
    lines = (node / 'IGlobal.py').read_text(encoding='utf-8').splitlines()
    return [(f.rule, lines[f.line - 1].strip()) for f in LINT.lint_node(node)]


def test_a_while_condition_sees_the_alias_its_body_carries_back(tmp_path):
    assert _param_reads(
        tmp_path,
        ['cfg = {}', "while cfg.get('maxEdge', 0) == 0:", '    cfg = self.config'],
    ) == [('param-in-global', "while cfg.get('maxEdge', 0) == 0:")]


def test_a_while_condition_on_a_local_dict_stays_clean(tmp_path):
    assert (
        _param_reads(
            tmp_path,
            ['cfg = {}', "while cfg.get('maxEdge', 0) == 0:", "    cfg = {'maxEdge': 1}"],
        )
        == []
    )


def test_an_exception_handler_sees_an_alias_from_inside_the_try(tmp_path):
    assert _param_reads(
        tmp_path,
        [
            'cfg = {}',
            'try:',
            '    cfg = self.config',
            '    self.prepare()',
            '    cfg = {}',
            'except RuntimeError:',
            "    self.edge = cfg.get('maxEdge')",
            "self.after = cfg.get('maxEdge')",
        ],
    ) == [('param-in-global', "self.edge = cfg.get('maxEdge')"), ('param-in-global', "self.after = cfg.get('maxEdge')")]


def test_an_exception_leaving_through_finally_carries_the_state_finally_left(tmp_path):
    # The inner finally rebinds cfg before the exception reaches the outer handler: no alias there
    assert (
        _param_reads(
            tmp_path,
            [
                'cfg = {}',
                'try:',
                '    try:',
                '        cfg = self.config',
                '        self.prepare()',
                '    finally:',
                '        cfg = {}',
                'except RuntimeError:',
                "    self.edge = cfg.get('maxEdge')",
            ],
        )
        == []
    )


def test_an_exception_leaving_through_a_finally_that_keeps_the_alias_still_carries_it(tmp_path):
    assert _param_reads(
        tmp_path,
        [
            'cfg = {}',
            'try:',
            '    try:',
            '        cfg = self.config',
            '        self.prepare()',
            '    finally:',
            '        self.cleanup()',
            'except RuntimeError:',
            "    self.edge = cfg.get('maxEdge')",
        ],
    ) == [('param-in-global', "self.edge = cfg.get('maxEdge')")]


def test_the_successful_path_still_applies_the_final_rebinding(tmp_path):
    assert (
        _param_reads(
            tmp_path,
            [
                'try:',
                '    cfg = self.config',
                '    cfg = {}',
                'except RuntimeError:',
                '    raise',
                'else:',
                "    self.edge = cfg.get('maxEdge')",
            ],
        )
        == []
    )


def test_a_finally_block_sees_an_alias_an_exception_leaves(tmp_path):
    assert _param_reads(
        tmp_path,
        [
            'cfg = {}',
            'try:',
            '    cfg = self.config',
            '    if self.enabled:',
            '        raise RuntimeError()',
            '    cfg = {}',
            'finally:',
            "    self.edge = cfg.get('maxEdge')",
        ],
    ) == [('param-in-global', "self.edge = cfg.get('maxEdge')")]


def test_an_exceptional_state_creates_no_finding_after_the_try(tmp_path):
    # Leaving by exception never reaches the next statement: only the normal exit (cfg = {}) flows on
    assert (
        _param_reads(
            tmp_path,
            [
                'cfg = {}',
                'try:',
                '    cfg = self.config',
                '    if self.enabled:',
                '        raise RuntimeError()',
                '    cfg = {}',
                'finally:',
                '    self.done = True',
                "self.after = cfg.get('maxEdge')",
            ],
        )
        == []
    )


def test_an_annotated_alias_is_an_alias_and_a_bare_annotation_is_not(tmp_path):
    assert _param_reads(
        tmp_path,
        [
            'cfg: object = self.config',
            "self.edge = cfg.get('maxEdge')",
            "other = {'maxEdge': 1}",
            'other: object',
            "self.other = other.get('maxEdge')",
        ],
    ) == [('param-in-global', "self.edge = cfg.get('maxEdge')")]


@pytest.mark.parametrize('argv', [['--all'], ['no-such-node-dir'], ['--all', 'no-such-root']])
def test_the_cli_refuses_what_it_cannot_lint(monkeypatch, argv):
    monkeypatch.setattr(LINT.sys, 'argv', ['lint-node-code.py', *argv])
    with pytest.raises(SystemExit) as stopped:
        LINT.main()
    assert stopped.value.code == 2


# =============================================================================
# What the lint accepts
# =============================================================================


def test_a_conforming_node_is_clean(tmp_path):
    node = write_node(
        tmp_path,
        {
            'IGlobal.py': """
                import threading

                from rocketlib import IGlobalBase, debug

                from ai.common.utils import LoaderCache

                _MODES = {'fast': 1, 'slow': 2}
                _MODELS = LoaderCache()
                _LOCK = threading.Lock()

                class IGlobal(IGlobalBase):
                    provider: str = ''

                    def beginGlobal(self):
                        self.provider = self.config.node.provider
                        self.mode = _MODES[self.config.mode]
                        self.client = Client(self.config.host)
                        self.model = _MODELS.acquire(self.config.model, lambda: object())
                        debug('ready')

                    def endGlobal(self):
                        self.client.close()
                        self.client = None
                        self.model = None
            """,
            'IInstance.py': """
                from rocketlib import IInstanceBase

                class IInstance(IInstanceBase):
                    def beginInstance(self):
                        self.rows = []

                    def writeText(self, text):
                        self.rows.append(text[: self.settings.maxEdge])
            """,
        },
    )
    assert LINT.lint_node(node) == []


# =============================================================================
# The catalog
# =============================================================================


#: Nodes that still key what they keep by the caller's identity, each with the
#: one finding its move to self.state removes (plan 12; the stateful-node PRs
#: after C.26). A node leaves this table in the PR that moves it: the test
#: below fails as soon as the finding is gone and the entry is not.
IDENTITY_PERSISTERS = {
    'memory_persistent': ['memory_persistent/IInstance.py: identity-persist'],
    'tool_laserdata_memory': ['tool_laserdata_memory/IInstance.py: identity-persist'],
}


@pytest.mark.parametrize('node', LINT.node_dirs(NODES_ROOT), ids=lambda p: p.name)
def test_every_catalog_node_is_clean(node):
    findings = LINT.lint_node(node)
    expected = IDENTITY_PERSISTERS.get(node.name, [])
    assert [f'{f.path}: {f.rule}' for f in findings] == expected, '\n'.join(str(f) for f in findings)
