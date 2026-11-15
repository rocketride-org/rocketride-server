# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the tool_skills node.

Covers SKILL.md parsing, the catalog rules (names, descriptions, duplicates),
reading a skills folder from a file store, and the two agent tools. Pure
Python: ``rocketlib``, ``ai.common.config`` and ``ai.account.store`` are
stubbed and the file store is an in-memory fake, so no engine is needed.
"""

from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path
from unittest import mock

import pytest

_NODE_SRC = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_skills'

_WARNINGS: list[str] = []
_CONFIG: dict = {}
_STORE: dict = {'store': None}


def _build_stubs() -> dict:
    """Build stand-ins for the engine modules the node imports."""
    rocketlib = types.ModuleType('rocketlib')

    class _IGlobalBase:
        pass

    class _IInstanceBase:
        # Mirrors rocketlib.filters.IInstanceBase._collect_tool_methods.
        def _collect_tool_methods(self):
            methods = {}
            for name in dir(type(self)):
                attr = getattr(type(self), name, None)
                if attr is not None and hasattr(attr, '__tool_meta__'):
                    methods[name] = getattr(self, name)
            return methods

    def _tool_function(**meta):
        def wrap(fn):
            fn.__tool_meta__ = meta
            return fn

        return wrap

    rocketlib.IGlobalBase = _IGlobalBase
    rocketlib.IInstanceBase = _IInstanceBase
    rocketlib.tool_function = _tool_function
    rocketlib.OPEN_MODE = types.SimpleNamespace(CONFIG='config', RUN='run')
    rocketlib.warning = _WARNINGS.append

    config = types.ModuleType('ai.common.config')
    store = types.ModuleType('ai.account.store')

    class _Config:
        @staticmethod
        def getNodeConfig(*_args, **_kwargs):
            return dict(_CONFIG)

    class _Store:
        @staticmethod
        def engine_file_store():
            return _STORE['store']

    config.Config = _Config
    store.Store = _Store

    # Import the node as a bare package so its __init__ (which loads
    # requirements through the engine's `depends`) does not run.
    package = types.ModuleType('tool_skills')
    package.__path__ = [str(_NODE_SRC)]

    return {
        'rocketlib': rocketlib,
        'ai.common.config': config,
        'ai.account.store': store,
        'tool_skills': package,
    }


_STUBS = _build_stubs()

# The node modules bind rocketlib and Config at import time, so the stubs are
# only needed in sys.modules while importing. ai.account.store is imported
# lazily by IGlobal, so _begin patches it in again for each run.
with mock.patch.dict(sys.modules, _STUBS):
    catalog_mod = importlib.import_module('tool_skills.skill_catalog')
    glb_mod = importlib.import_module('tool_skills.IGlobal')
    inst_mod = importlib.import_module('tool_skills.IInstance')

SkillError = catalog_mod.SkillError


class FakeFileStore:
    """In-memory stand-in for ai.account.file_store.FileStore (list_dir and read only)."""

    def __init__(self, files: dict[str, bytes]):
        self.files = files
        self.reads: list[str] = []

    async def list_dir(self, path: str = '') -> dict:
        prefix = f'{path.strip("/")}/' if path.strip('/') else ''
        children: dict[str, str] = {}
        for full in self.files:
            if not full.startswith(prefix):
                continue
            parts = full[len(prefix) :].split('/')
            children[parts[0]] = 'file' if len(parts) == 1 else 'dir'
        entries = [{'name': name, 'type': kind} for name, kind in sorted(children.items())]
        return {'entries': entries, 'count': len(entries)}

    async def read(self, path: str, max_size: int = 100) -> bytes:
        self.reads.append(path)
        data = self.files[path]
        if len(data) > max_size:
            raise RuntimeError(f'File exceeds max_size ({len(data)} > {max_size})')
        return data


SKILL_MD = b"""---
name: release-notes
description: Write release notes from a list of merged pull requests.
---
# Release notes

Group the changes by area. See references/style.md for the house style.
"""


def _endpoint(mode='run'):
    return types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode=mode))


def _begin(config: dict, store=None):
    """Run IGlobal.beginGlobal against a config and an optional file store."""
    _WARNINGS.clear()
    _CONFIG.clear()
    _CONFIG.update(config)
    _STORE['store'] = store
    glb = glb_mod.IGlobal()
    glb.IEndpoint = _endpoint()
    glb.glb = types.SimpleNamespace(logicalType='tool_skills', connConfig={})
    with mock.patch.dict(sys.modules, {'ai.account.store': _STUBS['ai.account.store']}):
        glb.beginGlobal()
    inst = inst_mod.IInstance()
    inst.IGlobal = glb
    return glb, inst


def _describe(inst, method_name):
    """Resolve a tool's description and input schema the way the engine does at tool.query."""
    meta = getattr(type(inst), method_name).__tool_meta__
    desc = meta['description']
    schema = meta['input_schema']
    return (desc(inst) if callable(desc) else desc), (schema(inst) if callable(schema) else schema)


# ---------------------------------------------------------------------------
# SKILL.md parsing and the catalog rules
# ---------------------------------------------------------------------------


def test_parse_skill_md_splits_frontmatter_and_body():
    meta, body = catalog_mod.parse_skill_md(SKILL_MD.decode())
    assert meta == {'name': 'release-notes', 'description': 'Write release notes from a list of merged pull requests.'}
    assert body.startswith('# Release notes')


def test_parse_skill_md_without_frontmatter_is_all_body():
    meta, body = catalog_mod.parse_skill_md('Just do the thing.\n')
    assert meta == {}
    assert body == 'Just do the thing.'


def test_parse_skill_md_reads_folded_yaml_description():
    meta, _ = catalog_mod.parse_skill_md('---\nname: x\ndescription: >\n  first line\n  second line\n---\nbody')
    assert meta['description'].strip() == 'first line second line'


@pytest.mark.parametrize('front', ['name: [unclosed', '- just\n- a list'])
def test_parse_skill_md_rejects_unusable_frontmatter(front):
    with pytest.raises(SkillError):
        catalog_mod.parse_skill_md(f'---\n{front}\n---\nbody')


def test_build_skill_explicit_fields_win_over_frontmatter():
    skill = catalog_mod.build_skill(text=SKILL_MD.decode(), name='Changelog Writer', description='Custom description')
    assert skill.name == 'changelog-writer'
    assert skill.description == 'Custom description'
    assert skill.instructions.startswith('# Release notes')


def test_build_skill_falls_back_to_the_folder_name():
    skill = catalog_mod.build_skill(text='---\ndescription: d\n---\nbody', fallback_name='My_Skill')
    assert skill.name == 'my-skill'


def test_build_skill_requires_a_name_a_description_and_instructions():
    with pytest.raises(SkillError, match='no name'):
        catalog_mod.build_skill(text='---\ndescription: d\n---\nbody')
    with pytest.raises(SkillError, match='no description'):
        catalog_mod.build_skill(text='---\nname: n\n---\nbody')
    with pytest.raises(SkillError, match='no instructions'):
        catalog_mod.build_skill(text='---\nname: n\ndescription: d\n---\n')


def test_build_skill_caps_the_description_length():
    skill = catalog_mod.build_skill(text='body', name='n', description='x' * 5000)
    assert len(skill.description) == catalog_mod.MAX_DESCRIPTION_LENGTH
    assert skill.description.endswith('...')


def test_catalog_keeps_the_first_skill_with_a_name():
    catalog = catalog_mod.SkillCatalog()
    first = catalog_mod.build_skill(text='one', name='dup', description='d', source='config row 1')
    second = catalog_mod.build_skill(text='two', name='dup', description='d', source="folder 'skills/dup'")
    assert catalog.add(first) is None
    problem = catalog.add(second)
    assert "folder 'skills/dup'" in problem and 'config row 1' in problem
    assert catalog.get('dup').instructions == 'one'


def test_catalog_lookup_accepts_a_display_name_and_names_known_skills_on_a_miss():
    catalog = catalog_mod.SkillCatalog()
    catalog.add(catalog_mod.build_skill(text='b', name='release-notes', description='d'))
    assert catalog.get('Release Notes').name == 'release-notes'
    with pytest.raises(SkillError, match='available skills: release-notes'):
        catalog.get('nope')


def test_skills_from_config_skips_empty_rows_and_reports_bad_ones():
    rows = [
        {'skillName': '', 'skillDescription': '', 'skillInstructions': ''},
        {'skillInstructions': SKILL_MD.decode()},
        {'skillName': 'no-description', 'skillInstructions': 'body'},
        'not a row',
    ]
    skills, problems = catalog_mod.skills_from_config(rows)
    assert [s.name for s in skills] == ['release-notes']
    assert len(problems) == 1 and problems[0].startswith('config row 3:')


@pytest.mark.parametrize(
    'raw, expected',
    [
        ('references/style.md', 'references/style.md'),
        ('./references/style.md', 'references/style.md'),
        ('/a\\b.md', 'a/b.md'),
        ('../secret', '../secret'),
    ],
)
def test_relative_file_path(raw, expected):
    assert catalog_mod.relative_file_path(raw) == expected


# ---------------------------------------------------------------------------
# Reading a skills folder
# ---------------------------------------------------------------------------


def _run(coro_fn, *args):
    return glb_mod.run_async(coro_fn, *args)


def test_load_folder_reads_one_skill_per_subfolder_with_its_files():
    store = FakeFileStore(
        {
            'skills/release-notes/SKILL.md': SKILL_MD,
            'skills/release-notes/references/style.md': b'Use sentence case.',
            'skills/release-notes/scripts/collect.py': b'print(1)',
            'skills/triage/SKILL.md': b'---\nname: triage\ndescription: Label new issues.\n---\nRead the issue.',
            'skills/notes.txt': b'not a skill',
        }
    )
    skills, problems = _run(catalog_mod.load_folder, store, '/skills/')
    assert problems == []
    by_name = {s.name: s for s in skills}
    assert set(by_name) == {'release-notes', 'triage'}
    assert by_name['release-notes'].files == {
        'references/style.md': 'skills/release-notes/references/style.md',
        'scripts/collect.py': 'skills/release-notes/scripts/collect.py',
    }
    assert by_name['triage'].files == {}


def test_load_folder_accepts_a_folder_that_is_one_skill():
    store = FakeFileStore({'my-skill/SKILL.md': b'---\ndescription: d\n---\nbody', 'my-skill/ref.md': b'r'})
    skills, problems = _run(catalog_mod.load_folder, store, 'my-skill')
    assert problems == []
    assert [(s.name, list(s.files)) for s in skills] == [('my-skill', ['ref.md'])]


def test_load_folder_reports_subfolders_it_cannot_use():
    store = FakeFileStore(
        {
            'skills/good/SKILL.md': b'---\ndescription: d\n---\nbody',
            'skills/no-skill-md/readme.md': b'x',
            'skills/no-description/SKILL.md': b'---\nname: x\n---\nbody',
            'skills/binary/SKILL.md': b'\xff\xfe\x00',
        }
    )
    skills, problems = _run(catalog_mod.load_folder, store, 'skills')
    assert [s.name for s in skills] == ['good']
    joined = '\n'.join(problems)
    assert "'skills/no-skill-md' was skipped" in joined
    assert "'skills/no-description'" in joined and 'no description' in joined
    assert "'skills/binary'" in joined and 'UTF-8' in joined


def test_load_folder_warns_on_an_empty_or_missing_folder():
    skills, problems = _run(catalog_mod.load_folder, FakeFileStore({}), 'skills')
    assert skills == []
    assert problems == ["no skills found: folder 'skills' is empty or does not exist in your files"]


def test_load_folder_warns_when_a_folder_holds_only_loose_files():
    skills, problems = _run(catalog_mod.load_folder, FakeFileStore({'skills/readme.md': b'x'}), 'skills')
    assert skills == []
    assert 'expected a SKILL.md, or subfolders that each hold one' in problems[0]


def test_load_folder_caps_the_files_listed_per_skill(monkeypatch):
    monkeypatch.setattr(catalog_mod, 'MAX_FILES_PER_SKILL', 3)
    files = {'s/SKILL.md': b'---\ndescription: d\n---\nbody'}
    files.update({f's/ref/{i}.md': b'x' for i in range(10)})
    skills, problems = _run(catalog_mod.load_folder, FakeFileStore(files), 's')
    assert len(skills) == 1
    assert len(skills[0].files) == 3
    assert any('more than 3 files' in p for p in problems)


def test_the_file_cap_never_drops_skill_md(monkeypatch):
    # Bundled files that sort before SKILL.md fill the cap first.
    monkeypatch.setattr(catalog_mod, 'MAX_FILES_PER_SKILL', 3)
    files = {'s/SKILL.md': b'---\ndescription: d\n---\nbody'}
    files.update({f's/A{i}.md': b'x' for i in range(5)})
    skills, problems = _run(catalog_mod.load_folder, FakeFileStore(files), 's')
    assert [s.name for s in skills] == ['s']
    assert len(skills[0].files) == 3
    assert not any('has no SKILL.md' in p for p in problems)
    assert any('more than 3 files' in p for p in problems)


# ---------------------------------------------------------------------------
# IGlobal: building the catalog at pipeline start
# ---------------------------------------------------------------------------


def test_begin_global_skips_work_in_config_mode():
    glb = glb_mod.IGlobal()
    glb.IEndpoint = _endpoint('config')
    glb.beginGlobal()
    assert glb.catalog is None


def test_begin_global_loads_config_skills_then_folder_skills():
    store = FakeFileStore(
        {
            'skills/release-notes/SKILL.md': b'---\ndescription: folder copy\n---\nfolder body',
            'skills/triage/SKILL.md': b'---\ndescription: Label new issues.\n---\nRead the issue.',
        }
    )
    glb, _ = _begin(
        {'skills': [{'skillInstructions': SKILL_MD.decode()}], 'folder': 'skills'},
        store=store,
    )
    assert glb.catalog.names() == ['release-notes', 'triage']
    # The config panel's skill keeps its name; the folder copy is reported.
    assert glb.catalog.get('release-notes').instructions.startswith('# Release notes')
    assert any('was skipped' in w and 'release-notes' in w for w in _WARNINGS)


def test_begin_global_accepts_skill_rows_as_json_text():
    glb, _ = _begin({'skills': json.dumps([{'skillInstructions': SKILL_MD.decode()}])})
    assert glb.catalog.names() == ['release-notes']


def test_begin_global_warns_when_the_folder_cannot_be_read():
    glb, _ = _begin({'folder': 'skills'}, store=None)
    assert len(glb.catalog) == 0
    assert any('no running task with an identity' in w for w in _WARNINGS)
    assert any('no skills loaded' in w for w in _WARNINGS)


# ---------------------------------------------------------------------------
# IInstance: the agent tools
# ---------------------------------------------------------------------------


def _folder_instance():
    store = FakeFileStore(
        {
            'skills/release-notes/SKILL.md': SKILL_MD,
            'skills/release-notes/references/style.md': b'Use sentence case.',
            'skills/release-notes/assets/logo.png': b'\x89PNG\r\n\x1a\n\xff\xfe',
            'skills/triage/SKILL.md': b'---\ndescription: Label new issues.\n---\nRead the issue.',
        }
    )
    glb, inst = _begin({'folder': 'skills'}, store=store)
    return store, inst


def test_load_skill_description_lists_every_skill():
    _, inst = _folder_instance()
    description, schema = _describe(inst, 'load_skill')
    assert '- release-notes: Write release notes from a list of merged pull requests.' in description
    assert '- triage: Label new issues.' in description
    assert schema['properties']['name']['enum'] == ['release-notes', 'triage']


def test_load_skill_returns_instructions_and_files():
    _, inst = _folder_instance()
    result = inst.load_skill({'name': 'release-notes'})
    assert result['instructions'].startswith('# Release notes')
    assert result['files'] == ['assets/logo.png', 'references/style.md']


def test_load_skill_rejects_an_unknown_name():
    _, inst = _folder_instance()
    with pytest.raises(ValueError, match='available skills: release-notes, triage'):
        inst.load_skill({'name': 'deploy'})
    with pytest.raises(ValueError, match='JSON object'):
        inst.load_skill('release-notes')


def test_read_skill_file_returns_a_listed_file():
    store, inst = _folder_instance()
    result = inst.read_skill_file({'name': 'release-notes', 'path': './references/style.md'})
    assert result == {'name': 'release-notes', 'path': 'references/style.md', 'content': 'Use sentence case.'}
    assert store.reads[-1] == 'skills/release-notes/references/style.md'


@pytest.mark.parametrize('path', ['../triage/SKILL.md', 'SKILL.md', 'references/missing.md', '/etc/passwd'])
def test_read_skill_file_only_reads_listed_files(path):
    store, inst = _folder_instance()
    reads_before = len(store.reads)
    with pytest.raises(ValueError, match='has no file'):
        inst.read_skill_file({'name': 'release-notes', 'path': path})
    assert len(store.reads) == reads_before


def test_read_skill_file_refuses_binary_files():
    _, inst = _folder_instance()
    with pytest.raises(ValueError, match='not a text file'):
        inst.read_skill_file({'name': 'release-notes', 'path': 'assets/logo.png'})


def test_read_skill_file_schema_offers_only_skills_with_files():
    _, inst = _folder_instance()
    _, schema = _describe(inst, 'read_skill_file')
    assert schema['properties']['name']['enum'] == ['release-notes']


def test_tools_offered_follow_the_catalog():
    _, folder_inst = _folder_instance()
    assert set(folder_inst._collect_tool_methods()) == {'load_skill', 'read_skill_file'}

    _, inline_inst = _begin({'skills': [{'skillInstructions': SKILL_MD.decode()}]})
    assert set(inline_inst._collect_tool_methods()) == {'load_skill'}

    _, empty_inst = _begin({})
    assert empty_inst._collect_tool_methods() == {}
