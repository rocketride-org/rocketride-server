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
Skills tool node instance.

Serves skills to an agent in two steps, so a long skill costs context only
when the agent uses it. The ``load_skill`` description lists every skill's
name and description; calling it returns that skill's instructions. Skills
read from a folder may bundle files, which ``read_skill_file`` returns.

The catalog is built once per call from the call's settings: the skills
entered in the node, then the skills in the configured folder of the call's
file store (``self.files``, the same store the File System node uses). A
skill that cannot be used is reported with ``warning()`` and skipped; the
others still load.
"""

from __future__ import annotations

from rocketlib import IInstanceBase, tool_function, warning

from .IGlobal import IGlobal
from .skill_catalog import MAX_FILE_BYTES, SkillCatalog, SkillError, load_folder, relative_file_path, skills_from_config


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    # This call's skill catalog, built from its settings on first use
    _call_catalog: SkillCatalog | None = None

    @tool_function(
        input_schema=lambda self: {
            'type': 'object',
            'required': ['name'],
            'properties': {
                'name': {
                    'type': 'string',
                    'enum': self._catalog().names(),
                    'description': 'Name of the skill to load.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'name': {'type': 'string'},
                'description': {'type': 'string'},
                'instructions': {'type': 'string', 'description': 'The skill instructions to follow.'},
                'files': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Files bundled with the skill, relative to the skill folder. Read one with read_skill_file.',
                },
            },
        },
        description=lambda self: (
            'Load a skill: instructions written for one kind of task, such as a required format, steps to '
            "follow or reference files. When the request matches a skill's description, call this tool "
            'before you plan or answer, then follow the instructions it returns: the expected result '
            'cannot be produced without them. Available skills:\n' + self._catalog().summary()
        ),
    )
    def load_skill(self, args):
        """Return a skill's instructions and the list of its bundled files."""
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object (dict)')
        try:
            skill = self._catalog().get(args.get('name'))
        except SkillError as e:
            raise ValueError(str(e)) from e
        return {
            'name': skill.name,
            'description': skill.description,
            'instructions': skill.instructions,
            'files': sorted(skill.files),
        }

    @tool_function(
        input_schema=lambda self: {
            'type': 'object',
            'required': ['name', 'path'],
            'properties': {
                'name': {
                    'type': 'string',
                    'enum': self._catalog().names_with_files(),
                    'description': 'Name of the skill the file belongs to.',
                },
                'path': {
                    'type': 'string',
                    'description': 'Path of the file relative to the skill folder, as listed in the load_skill result (example: references/style.md).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'name': {'type': 'string'},
                'path': {'type': 'string'},
                'content': {'type': 'string', 'description': 'The file as UTF-8 text.'},
            },
        },
        description=(
            'Read a file bundled with a skill, such as a reference document, template or script. '
            'Load the skill first: the load_skill result lists its files. Returns the file as text; '
            'this tool does not run scripts.'
        ),
    )
    def read_skill_file(self, args):
        """Return one bundled file of a folder skill as text."""
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object (dict)')
        try:
            skill = self._catalog().get(args.get('name'))
        except SkillError as e:
            raise ValueError(str(e)) from e

        path = relative_file_path(args.get('path'))
        store_path = skill.files.get(path)
        if store_path is None:
            listed = ', '.join(sorted(skill.files)) or 'none'
            raise ValueError(f'skill {skill.name!r} has no file {path!r}; its files: {listed}')

        data = self.files.read(store_path, max_size=MAX_FILE_BYTES)
        try:
            content = data.decode('utf-8')
        except UnicodeDecodeError as e:
            raise ValueError(f'{path!r} is not a text file and cannot be returned: {e}') from e
        return {'name': skill.name, 'path': path, 'content': content}

    def _collect_tool_methods(self):
        """Offer only the tools that have something to serve.

        No skills hides both tools; no skill with bundled files hides
        ``read_skill_file``.
        """
        methods = super()._collect_tool_methods()
        catalog = self._catalog()
        if not len(catalog):
            return {}
        if not catalog.names_with_files():
            methods.pop('read_skill_file', None)
        return methods

    def _catalog(self) -> SkillCatalog:
        """This call's skill catalog, built once per call from its settings."""
        if self._call_catalog is None:
            self._call_catalog = self._build_catalog()
        return self._call_catalog

    def _build_catalog(self) -> SkillCatalog:
        """Build the catalog: the skills entered in the node, then the skills in the folder."""
        settings = self.settings
        catalog = SkillCatalog()
        problems: list[str] = []

        skills, row_problems = skills_from_config(settings.skills or [])
        problems.extend(row_problems)
        for skill in skills:
            problem = catalog.add(skill)
            if problem:
                problems.append(problem)

        folder = str(settings.folder or '').strip()
        if folder:
            try:
                folder_skills, folder_problems = load_folder(self.files, folder)
            except Exception as e:
                folder_skills, folder_problems = [], [f'the skills folder {folder!r} could not be read: {e}']
            problems.extend(folder_problems)
            for skill in folder_skills:
                problem = catalog.add(skill)
                if problem:
                    problems.append(problem)

        for problem in problems:
            warning(f'tool_skills: {problem}')
        if not len(catalog):
            warning(
                'tool_skills: no skills loaded, so the agent is offered no skill tools. Add a skill or set a skills folder.'
            )
        return catalog
