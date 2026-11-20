# =============================================================================
# RocketRide Engine
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
Skill parsing and the skill catalog served by the Skills tool node.

A skill is a ``SKILL.md`` file: YAML frontmatter carrying ``name`` and
``description``, then markdown instructions (the Agent Skills format). A skill
read from a folder may also bundle other files (references, templates,
scripts) that an agent reads on demand.

Pure Python apart from the async file store calls in ``load_folder``, so the
parsing rules can be tested without an engine.
"""

from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple

import yaml

SKILL_FILE = 'SKILL.md'

# Limits from the Agent Skills format.
MAX_NAME_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 1024

# Longest name or description accepted before it is normalized or cut.
MAX_FIELD_CHARS = 8 * 1024

# Limits on what one folder may make the node read at startup.
MAX_SKILL_MD_BYTES = 256 * 1024
MAX_FILES_PER_SKILL = 200
MAX_FOLDER_DEPTH = 5

# Largest bundled file ``read_skill_file`` returns.
MAX_FILE_BYTES = 256 * 1024

_FRONTMATTER = re.compile(r'\A﻿?---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)', re.DOTALL)


class SkillError(ValueError):
    """A skill definition the node cannot use."""


class _NoAliasLoader(yaml.SafeLoader):
    """SafeLoader that refuses YAML aliases.

    Frontmatter never needs them, and nested aliases (a "billion laughs"
    block) make a few hundred bytes stand for gigabytes of text.
    """

    def compose_node(self, parent, index):
        if self.check_event(yaml.AliasEvent):
            event = self.peek_event()
            raise yaml.composer.ComposerError(
                None,
                None,
                f'found the alias *{event.anchor}, and SKILL.md frontmatter may not use aliases',
                event.start_mark,
            )
        return super().compose_node(parent, index)


@dataclass(frozen=True)
class Skill:
    """One loaded skill."""

    name: str
    description: str
    instructions: str
    # Bundled files: path relative to the skill folder -> path in the file store.
    files: Dict[str, str] = field(default_factory=dict, compare=False)
    # Where the skill came from, for warnings: 'config' or the folder path.
    source: str = 'config'


def parse_skill_md(text: str) -> Tuple[Dict[str, Any], str]:
    """Split SKILL.md text into ``(frontmatter, body)``.

    Text without a leading ``---`` frontmatter block is all body.
    """
    match = _FRONTMATTER.match(text or '')
    if not match:
        return {}, (text or '').strip()
    try:
        # _NoAliasLoader is a SafeLoader: it builds plain values only.
        meta = yaml.load(match.group(1), Loader=_NoAliasLoader)
    except Exception as e:
        # Besides YAMLError, building a value can raise: `updated: 2026-02-30`
        # raises ValueError from datetime.
        raise SkillError(f'the SKILL.md frontmatter is not valid YAML: {e}') from e
    if meta is None:
        meta = {}
    if not isinstance(meta, dict):
        raise SkillError('the SKILL.md frontmatter must be a set of "key: value" lines')
    return meta, text[match.end() :].strip()


def normalize_name(raw: Any) -> str:
    """Turn a display name into a skill name: lowercase letters, digits and hyphens.

    ``'Release Notes'`` becomes ``'release-notes'``.
    """
    name = re.sub(r'[^a-z0-9]+', '-', str(raw or '').strip().lower()).strip('-')
    return name[:MAX_NAME_LENGTH].rstrip('-')


def _text(value: Any, field_name: str) -> str:
    """A name or description as stripped text; '' when unset."""
    if value is None:
        return ''
    if not isinstance(value, str):
        hint = (
            ': YAML reads yes, no, on, off, true and false as true or false, so put the value in quotes'
            if isinstance(value, bool)
            else ': put the value in quotes'
        )
        raise SkillError(f'the {field_name} must be text, not {_kind(value)}{hint}')
    if len(value) > MAX_FIELD_CHARS:
        raise SkillError(f'the {field_name} is {len(value)} characters long; the limit is {MAX_FIELD_CHARS}')
    return value.strip()


def _kind(value: Any) -> str:
    if isinstance(value, bool):
        return f'{str(value).lower()} (a yes/no value)'
    if isinstance(value, (int, float)):
        return 'a number'
    if isinstance(value, list):
        return 'a list'
    if isinstance(value, dict):
        return 'a set of keys'
    return f'a {type(value).__name__}'


def build_skill(
    *,
    text: str,
    name: Any = None,
    description: Any = None,
    files: Optional[Dict[str, str]] = None,
    source: str = 'config',
    fallback_name: str = '',
) -> Skill:
    """Build a skill from SKILL.md text plus optional explicit name and description.

    An explicit ``name`` or ``description`` wins over the frontmatter, so a
    skill entered in the config panel can paste a SKILL.md and still rename
    it. ``fallback_name`` (a folder name) is used when neither gives a name.
    """
    meta, body = parse_skill_md(text)

    # A value set in the node wins, and only the value used is checked.
    raw_name = _text(name, 'name') or _text(meta.get('name'), 'name') or fallback_name
    skill_name = normalize_name(raw_name)
    if not skill_name:
        raise SkillError('the skill has no name: set one in the config or in the SKILL.md frontmatter')

    skill_description = ' '.join(
        (_text(description, 'description') or _text(meta.get('description'), 'description')).split()
    )
    if not skill_description:
        raise SkillError(
            f'skill {skill_name!r} has no description: the agent reads the description to decide '
            'when to load the skill, so set one in the config or in the SKILL.md frontmatter'
        )
    if len(skill_description) > MAX_DESCRIPTION_LENGTH:
        skill_description = skill_description[: MAX_DESCRIPTION_LENGTH - 3].rstrip() + '...'

    if not body:
        raise SkillError(f'skill {skill_name!r} has no instructions')

    return Skill(
        name=skill_name,
        description=skill_description,
        instructions=body,
        files=dict(files or {}),
        source=source,
    )


class SkillCatalog:
    """The skills one node serves, keyed by name. The first skill with a name wins."""

    def __init__(self) -> None:
        self._skills: Dict[str, Skill] = {}

    def add(self, skill: Skill) -> Optional[str]:
        """Add a skill. Returns a warning when the name is already taken (the skill is dropped)."""
        existing = self._skills.get(skill.name)
        if existing is not None:
            return (
                f'skill {skill.name!r} from {skill.source} was skipped: a skill with that name '
                f'was already loaded from {existing.source}'
            )
        self._skills[skill.name] = skill
        return None

    def __len__(self) -> int:
        return len(self._skills)

    def names(self) -> List[str]:
        return list(self._skills)

    def names_with_files(self) -> List[str]:
        return [name for name, skill in self._skills.items() if skill.files]

    def get(self, name: Any) -> Skill:
        """Look a skill up by name. Raises ``SkillError`` naming the known skills on a miss."""
        key = str(name or '').strip()
        skill = self._skills.get(key) or self._skills.get(normalize_name(key))
        if skill is None:
            raise SkillError(f'no skill named {key!r}; available skills: {", ".join(self._skills) or "none"}')
        return skill

    def summary(self) -> str:
        """One ``- name: description`` line per skill, for the tool description."""
        return '\n'.join(f'- {skill.name}: {skill.description}' for skill in self._skills.values())


def skills_from_config(rows: Iterable[Any]) -> Tuple[List[Skill], List[str]]:
    """Build skills from the config panel's skill rows.

    Returns ``(skills, warnings)``. A row that cannot be used is reported and
    skipped; an empty row is ignored.
    """
    skills: List[Skill] = []
    warnings: List[str] = []
    for index, row in enumerate(rows or [], start=1):
        if not hasattr(row, 'get'):
            continue
        text = str(row.get('skillInstructions') or '')
        name = row.get('skillName')
        description = row.get('skillDescription')
        if not (text.strip() or str(name or '').strip() or str(description or '').strip()):
            continue
        try:
            skills.append(build_skill(text=text, name=name, description=description, source=f'config row {index}'))
        except SkillError as e:
            warnings.append(f'config row {index}: {e}')
    return skills, warnings


def relative_file_path(raw: Any) -> str:
    """Normalize a bundled-file path an agent sends: posix separators, no leading ``./`` or ``/``."""
    path = posixpath.normpath(str(raw or '').strip().replace('\\', '/'))
    while path.startswith('./'):
        path = path[2:]
    return path.lstrip('/')


async def load_folder(store: Any, folder: str) -> Tuple[List[Skill], List[str]]:
    """Read the skills in ``folder`` of a file store.

    ``folder`` is either one skill (it holds a SKILL.md) or a folder of skills
    (each subfolder holding a SKILL.md). Returns ``(skills, warnings)``; a
    subfolder that cannot be read or parsed is reported and skipped.
    """
    folder = folder.strip().strip('/')
    listing = await store.list_dir(folder)
    entries = listing.get('entries') or []

    if any(e.get('type') == 'file' and e.get('name') == SKILL_FILE for e in entries):
        skill_dirs = [folder]
    else:
        skill_dirs = [_join(folder, e['name']) for e in entries if e.get('type') == 'dir']

    skills: List[Skill] = []
    warnings: List[str] = []
    if not entries:
        warnings.append(f'no skills found: folder {folder!r} is empty or does not exist in your files')
        return skills, warnings
    if not skill_dirs:
        warnings.append(f'no skills found in folder {folder!r}: expected a SKILL.md, or subfolders that each hold one')
        return skills, warnings

    for skill_dir in skill_dirs:
        try:
            skill = await _load_skill_dir(store, skill_dir, warnings)
        except SkillError as e:
            warnings.append(f'folder {skill_dir!r}: {e}')
            continue
        except Exception as e:
            warnings.append(f'folder {skill_dir!r} could not be read: {e}')
            continue
        if skill is not None:
            skills.append(skill)
    return skills, warnings


async def _load_skill_dir(store: Any, skill_dir: str, warnings: List[str]) -> Optional[Skill]:
    """Read one skill folder: its SKILL.md and the list of its other files."""
    paths = await _walk(store, skill_dir, warnings)
    if SKILL_FILE not in paths:
        warnings.append(f'folder {skill_dir!r} was skipped: it has no {SKILL_FILE}')
        return None

    raw = await store.read(paths.pop(SKILL_FILE), max_size=MAX_SKILL_MD_BYTES)
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError as e:
        raise SkillError(f'{SKILL_FILE} is not UTF-8 text: {e}') from e

    return build_skill(
        text=text,
        files=paths,
        source=f'folder {skill_dir!r}',
        fallback_name=posixpath.basename(skill_dir),
    )


async def _walk(store: Any, root: str, warnings: List[str]) -> Dict[str, str]:
    """Map every file under ``root`` (path relative to root) to its store path, within the limits.

    SKILL.md is always kept; the file cap applies only to the bundled files.
    """
    found: Dict[str, str] = {}
    capped = False
    pending: List[Tuple[str, int]] = [('', 0)]
    while pending and not capped:
        rel_dir, depth = pending.pop(0)
        listing = await store.list_dir(_join(root, rel_dir))
        for entry in listing.get('entries') or []:
            rel = _join(rel_dir, entry['name'])
            if entry.get('type') == 'dir':
                if depth + 1 < MAX_FOLDER_DEPTH:
                    pending.append((rel, depth + 1))
                continue
            if rel != SKILL_FILE and len(found) - (SKILL_FILE in found) >= MAX_FILES_PER_SKILL:
                # Finish this listing so a SKILL.md later in it is still found.
                capped = True
                continue
            found[rel] = _join(root, rel)
    if capped:
        warnings.append(f'folder {root!r} holds more than {MAX_FILES_PER_SKILL} files; the rest are not readable')
    return found


def _join(base: str, name: str) -> str:
    return f'{base}/{name}' if base else name
