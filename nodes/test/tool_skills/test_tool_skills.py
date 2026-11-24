# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the tool_skills node.

Covers SKILL.md parsing, the catalog rules (names, descriptions, duplicates),
reading a skills folder from a file store, the catalog each call builds from
its settings, and the two agent tools. Pure Python: ``rocketlib`` and
``depends`` are stubbed, a call's settings are bound the way the engine binds
them, and the call's file store (``self.files``) is an in-memory fake, so no
engine is needed.
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path
from unittest import mock

import pytest

_NODE_SRC = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_skills'

_WARNINGS: list[str] = []


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
    rocketlib.warning = _WARNINGS.append

    # IGlobal installs the node's requirements through the engine's `depends`
    # at import; the test interpreter already has pyyaml.
    depends = types.ModuleType('depends')
    depends.depends = lambda *_args, **_kwargs: None

    # Import the node as a bare package, the way the engine imports its
    # submodules (its __init__ holds only the license header).
    package = types.ModuleType('tool_skills')
    package.__path__ = [str(_NODE_SRC)]

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'tool_skills': package,
    }


_STUBS = _build_stubs()

# The node modules bind rocketlib at import time, so the stubs are only needed
# in sys.modules while importing.
with mock.patch.dict(sys.modules, _STUBS):
    catalog_mod = importlib.import_module('tool_skills.skill_catalog')
    glb_mod = importlib.import_module('tool_skills.IGlobal')
    inst_mod = importlib.import_module('tool_skills.IInstance')

SkillError = catalog_mod.SkillError


class FakeFileStore:
    """In-memory stand-in for the node's ``self.files`` door (list_dir and read only)."""

    def __init__(self, files: dict[str, bytes]):
        self.files = files
        self.reads: list[str] = []
        self.listings = 0

    def list_dir(self, path: str = '') -> dict:
        self.listings += 1
        prefix = f'{path.strip("/")}/' if path.strip('/') else ''
        children: dict[str, str] = {}
        for full in self.files:
            if not full.startswith(prefix):
                continue
            parts = full[len(prefix) :].split('/')
            children[parts[0]] = 'file' if len(parts) == 1 else 'dir'
        entries = [{'name': name, 'type': kind} for name, kind in sorted(children.items())]
        return {'entries': entries, 'count': len(entries)}

    def read(self, path: str, max_size: int = 100) -> bytes:
        self.reads.append(path)
        data = self.files[path]
        if len(data) > max_size:
            raise RuntimeError(f'File exceeds max_size ({len(data)} > {max_size})')
        return data


class RefusingFileStore:
    """A ``self.files`` door the server refuses, as it does a call it cannot tie to a control."""

    def list_dir(self, path: str = '') -> dict:
        raise RuntimeError('this call has no owner to read files for')

    def read(self, path: str, max_size: int = 100) -> bytes:
        raise RuntimeError('this call has no owner to read files for')


SKILL_MD = b"""---
name: release-notes
description: Write release notes from a list of merged pull requests.
---
# Release notes

Group the changes by area. See references/style.md for the house style.
"""


def _call(settings: dict, store=None, glb=None):
    """One call's instance, bound to its settings and its file store as the engine binds them.

    ``settings`` holds the call's values of the node's two keys, ``skills``
    and ``folder``; a key it leaves out takes the schema default. ``glb`` is
    the control's IGlobal, shared by every call of the control.
    """
    _WARNINGS.clear()
    inst = inst_mod.IInstance()
    inst.IGlobal = glb if glb is not None else glb_mod.IGlobal()
    inst.settings = types.SimpleNamespace(skills=settings.get('skills'), folder=settings.get('folder', ''))
    inst.files = store if store is not None else FakeFileStore({})
    return inst


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


@pytest.mark.parametrize('front', ['name: [unclosed', '- just\n- a list', 'updated: 2026-02-30'])
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


# Five levels of nested aliases: 274 bytes that str() would turn into 2.8 MB.
ALIAS_BOMB = """---
name: bomb
a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]
description: *e
---
body"""


def test_frontmatter_with_yaml_aliases_is_refused_before_it_expands():
    with pytest.raises(SkillError, match='may not use aliases'):
        catalog_mod.parse_skill_md(ALIAS_BOMB)


@pytest.mark.parametrize(
    'front, message',
    [
        ('name: yes\ndescription: d', r'the name must be text, not true .*put the value in quotes'),
        ('name: n\ndescription: no', r'the description must be text, not false .*put the value in quotes'),
        ('name: 42\ndescription: d', 'the name must be text, not a number'),
        ('name: n\ndescription: [a, b]', 'the description must be text, not a list'),
        ('name: n\ndescription: {k: v}', 'the description must be text, not a set of keys'),
    ],
)
def test_build_skill_refuses_frontmatter_values_that_are_not_text(front, message):
    with pytest.raises(SkillError, match=message):
        catalog_mod.build_skill(text=f'---\n{front}\n---\nbody')


def test_build_skill_reads_quoted_yes_and_no_as_text():
    skill = catalog_mod.build_skill(text='---\nname: "yes"\ndescription: "no"\n---\nbody')
    assert (skill.name, skill.description) == ('yes', 'no')


def test_build_skill_refuses_an_oversized_frontmatter_value():
    too_long = 'x' * (catalog_mod.MAX_FIELD_CHARS + 1)
    with pytest.raises(SkillError, match=f'the limit is {catalog_mod.MAX_FIELD_CHARS}'):
        catalog_mod.build_skill(text=f'---\nname: n\ndescription: {too_long}\n---\nbody')


def test_a_value_set_in_the_node_wins_over_an_unusable_frontmatter_value():
    skill = catalog_mod.build_skill(text='---\nname: yes\ndescription: d\n---\nbody', name='Release Notes')
    assert skill.name == 'release-notes'


def test_skills_with_unusable_frontmatter_are_skipped_and_the_rest_still_load():
    rows = [
        {'skillInstructions': SKILL_MD.decode()},
        {'skillInstructions': ALIAS_BOMB},
        {'skillInstructions': '---\nname: yes\ndescription: d\n---\nbody'},
        {'skillInstructions': '---\nname: n\ndescription: no\n---\nbody'},
        {'skillInstructions': '---\nname: 7\ndescription: d\n---\nbody'},
        {'skillInstructions': '---\nname: n\ndescription: [a]\n---\nbody'},
    ]
    skills, problems = catalog_mod.skills_from_config(rows)
    assert [s.name for s in skills] == ['release-notes']
    assert [p.split(':')[0] for p in problems] == [f'config row {i}' for i in range(2, 7)]
    assert 'may not use aliases' in problems[0]


def test_load_folder_skips_folders_with_unusable_frontmatter():
    store = FakeFileStore(
        {
            'skills/good/SKILL.md': b'---\ndescription: d\n---\nbody',
            'skills/bomb/SKILL.md': ALIAS_BOMB.encode(),
            'skills/yes/SKILL.md': b'---\nname: yes\ndescription: d\n---\nbody',
        }
    )
    skills, problems = catalog_mod.load_folder(store, 'skills')
    assert [s.name for s in skills] == ['good']
    joined = '\n'.join(problems)
    assert "'skills/bomb'" in joined and 'may not use aliases' in joined
    assert "'skills/yes'" in joined and 'must be text' in joined


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
        {'skillInstructions': '---\nname: bad-date\ndescription: d\nupdated: 2026-02-30\n---\nbody'},
    ]
    skills, problems = catalog_mod.skills_from_config(rows)
    assert [s.name for s in skills] == ['release-notes']
    assert len(problems) == 2 and problems[0].startswith('config row 3:')
    assert problems[1].startswith('config row 5:') and 'not valid YAML' in problems[1]


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
    skills, problems = catalog_mod.load_folder(store, '/skills/')
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
    skills, problems = catalog_mod.load_folder(store, 'my-skill')
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
    skills, problems = catalog_mod.load_folder(store, 'skills')
    assert [s.name for s in skills] == ['good']
    joined = '\n'.join(problems)
    assert "'skills/no-skill-md' was skipped" in joined
    assert "'skills/no-description'" in joined and 'no description' in joined
    assert "'skills/binary'" in joined and 'UTF-8' in joined


def test_load_folder_warns_on_an_empty_or_missing_folder():
    skills, problems = catalog_mod.load_folder(FakeFileStore({}), 'skills')
    assert skills == []
    assert problems == ["no skills found: folder 'skills' is empty or does not exist in your files"]


def test_load_folder_warns_when_a_folder_holds_only_loose_files():
    skills, problems = catalog_mod.load_folder(FakeFileStore({'skills/readme.md': b'x'}), 'skills')
    assert skills == []
    assert 'expected a SKILL.md, or subfolders that each hold one' in problems[0]


def test_load_folder_caps_the_files_listed_per_skill(monkeypatch):
    monkeypatch.setattr(catalog_mod, 'MAX_FILES_PER_SKILL', 3)
    files = {'s/SKILL.md': b'---\ndescription: d\n---\nbody'}
    files.update({f's/ref/{i}.md': b'x' for i in range(10)})
    skills, problems = catalog_mod.load_folder(FakeFileStore(files), 's')
    assert len(skills) == 1
    assert len(skills[0].files) == 3
    assert any('more than 3 files' in p for p in problems)


def test_the_file_cap_never_drops_skill_md(monkeypatch):
    # Bundled files that sort before SKILL.md fill the cap first.
    monkeypatch.setattr(catalog_mod, 'MAX_FILES_PER_SKILL', 3)
    files = {'s/SKILL.md': b'---\ndescription: d\n---\nbody'}
    files.update({f's/A{i}.md': b'x' for i in range(5)})
    skills, problems = catalog_mod.load_folder(FakeFileStore(files), 's')
    assert [s.name for s in skills] == ['s']
    assert len(skills[0].files) == 3
    assert not any('has no SKILL.md' in p for p in problems)
    assert any('more than 3 files' in p for p in problems)


def test_load_folder_reads_files_five_folder_levels_deep():
    files = {'s/SKILL.md': b'---\ndescription: d\n---\nbody', 's/a/b/c/d/e/ref.md': b'fifth level'}
    skills, problems = catalog_mod.load_folder(FakeFileStore(files), 's')
    assert problems == []
    assert skills[0].files == {'a/b/c/d/e/ref.md': 's/a/b/c/d/e/ref.md'}


def test_load_folder_leaves_out_files_below_the_fifth_folder_level():
    files = {
        's/SKILL.md': b'---\ndescription: d\n---\nbody',
        's/a/b/c/d/e/ref.md': b'fifth level',
        's/a/b/c/d/e/f/deep.md': b'sixth level',
    }
    store = FakeFileStore(files)
    skills, _ = catalog_mod.load_folder(store, 's')
    assert list(skills[0].files) == ['a/b/c/d/e/ref.md']
    # The sixth level is not even listed
    assert store.listings == 7


# ---------------------------------------------------------------------------
# The catalog a call builds from its settings
# ---------------------------------------------------------------------------


def test_a_call_loads_config_skills_then_folder_skills():
    store = FakeFileStore(
        {
            'skills/release-notes/SKILL.md': b'---\ndescription: folder copy\n---\nfolder body',
            'skills/triage/SKILL.md': b'---\ndescription: Label new issues.\n---\nRead the issue.',
        }
    )
    inst = _call(
        {'skills': [{'skillInstructions': SKILL_MD.decode()}], 'folder': 'skills'},
        store=store,
    )
    catalog = inst._catalog()
    assert catalog.names() == ['release-notes', 'triage']
    # The config panel's skill keeps its name; the folder copy is reported.
    assert catalog.get('release-notes').instructions.startswith('# Release notes')
    assert any('was skipped' in w and 'release-notes' in w for w in _WARNINGS)


def test_a_call_builds_its_catalog_once():
    store = FakeFileStore({'skills/triage/SKILL.md': b'---\ndescription: Label new issues.\n---\nRead the issue.'})
    inst = _call({'folder': 'skills'}, store=store)
    inst._collect_tool_methods()
    listings, reads = store.listings, len(store.reads)
    _describe(inst, 'load_skill')
    inst.load_skill({'name': 'triage'})
    inst._collect_tool_methods()
    assert (store.listings, len(store.reads)) == (listings, reads)


def test_each_call_of_one_control_builds_its_own_catalog_from_its_settings():
    glb = glb_mod.IGlobal()
    first = _call({'skills': [{'skillInstructions': SKILL_MD.decode()}]}, glb=glb)
    second = _call({'skills': [{'skillName': 'triage', 'skillDescription': 'd', 'skillInstructions': 'b'}]}, glb=glb)
    assert first._catalog().names() == ['release-notes']
    assert second._catalog().names() == ['triage']


def test_a_call_warns_when_the_folder_cannot_be_read():
    inst = _call({'folder': 'skills'}, store=RefusingFileStore())
    assert len(inst._catalog()) == 0
    assert any("the skills folder 'skills' could not be read" in w for w in _WARNINGS)
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
    inst = _call({'folder': 'skills'}, store=store)
    # The agent discovers the tools first, which builds the call's catalog.
    inst._catalog()
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

    inline_inst = _call({'skills': [{'skillInstructions': SKILL_MD.decode()}]})
    assert set(inline_inst._collect_tool_methods()) == {'load_skill'}

    empty_inst = _call({})
    assert empty_inst._collect_tool_methods() == {}
