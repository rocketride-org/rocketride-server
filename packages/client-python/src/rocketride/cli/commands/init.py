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

"""
RocketRide Init Command — scaffold agent integration files.

Creates documentation pointers so AI coding agents (Claude Code, Cursor,
Copilot, Codex, Windsurf) can build RocketRide pipelines from natural language.
Does not require a server connection.
"""

import sys
from pathlib import Path
from typing import List

# Resolve the skills directory bundled with the package
SKILLS_DIR = Path(__file__).parent.parent.parent / 'skills' / 'rocketride-pipelines'

AGENT_TARGETS = [
    {
        'key': 'claude',
        'label': 'Claude Code',
        'path': '.claude/rules/rocketride-python.md',
        'mode': 'owned',
        'warning': None,
    },
    {
        'key': 'cursor',
        'label': 'Cursor',
        'path': '.cursor/rules/rocketride-python.mdc',
        'mode': 'owned',
        'warning': None,
    },
    {
        'key': 'codex',
        'label': 'Codex',
        'path': 'AGENTS.md',
        'mode': 'shared',
        'warning': 'Appends to AGENTS.md in your project root',
    },
    {
        'key': 'copilot',
        'label': 'GitHub Copilot',
        'path': '.github/copilot-instructions.md',
        'mode': 'shared',
        'warning': 'Appends to .github/copilot-instructions.md',
    },
    {
        'key': 'windsurf',
        'label': 'Windsurf',
        'path': '.windsurf/rules/rocketride-python.md',
        'mode': 'owned',
        'warning': None,
    },
]


def _build_docs_content(skill_path: Path) -> str:
    """Build the agent instruction content pointing to the bundled docs."""
    return '\n'.join(
        [
            'When the user asks you to build, edit, or debug a RocketRide pipeline,',
            'read the following documentation before generating any pipeline code.',
            '',
            f'1. `{skill_path / "SKILL.md"}` — How to build pipelines programmatically: lane system, config patterns, SDK API, agent wiring',
            f'2. `{skill_path / "examples"}` — Complete working Python examples',
        ]
    )


def _write_owned_file(filepath: Path, content: str, label: str) -> None:
    """Write a file we fully own (create/overwrite)."""
    filepath.parent.mkdir(parents=True, exist_ok=True)
    filepath.write_text(content, encoding='utf-8')
    print(f'  [created] {filepath} ({label})')


def _upsert_shared_file(filepath: Path, docs_content: str, label: str) -> None:
    """Upsert a managed section in a shared file."""
    marker = '## RocketRide (Python SDK)'
    marker_end = '\n## '
    section = f'\n{marker}\n\n{docs_content}\n'

    filepath.parent.mkdir(parents=True, exist_ok=True)

    if filepath.exists():
        existing = filepath.read_text(encoding='utf-8')
        marker_idx = existing.find(marker)
        if marker_idx != -1:
            # Replace existing section
            after_idx = existing.find(marker_end, marker_idx + len(marker))
            before = existing[:marker_idx]
            after = existing[after_idx:] if after_idx != -1 else ''
            filepath.write_text(before + section.lstrip() + after, encoding='utf-8')
            print(f'  [updated] {filepath} ({label})')
        else:
            filepath.write_text(existing + section, encoding='utf-8')
            print(f'  [appended] {filepath} ({label})')
    else:
        filepath.write_text(section.lstrip(), encoding='utf-8')
        print(f'  [created] {filepath} ({label})')


def _remove_owned_file(filepath: Path, label: str) -> None:
    """Remove a file we own."""
    if filepath.exists():
        filepath.unlink()
        print(f'  [removed] {filepath} ({label})')


def _remove_shared_section(filepath: Path, label: str) -> None:
    """Remove our managed section from a shared file."""
    marker = '## RocketRide (Python SDK)'
    marker_end = '\n## '

    if not filepath.exists():
        return

    existing = filepath.read_text(encoding='utf-8')
    marker_idx = existing.find(marker)
    if marker_idx == -1:
        return

    after_idx = existing.find(marker_end, marker_idx + len(marker))
    before = existing[:marker_idx]
    after = existing[after_idx:] if after_idx != -1 else ''
    cleaned = (before + after).strip()

    if cleaned:
        filepath.write_text(cleaned + '\n', encoding='utf-8')
    else:
        filepath.unlink()
    print(f'  [removed] {filepath} ({label})')


class InitCommand:
    """Scaffold agent integration files for coding assistants."""

    def __init__(self, cli, args):
        """Initialize the init command."""
        self.cli = cli
        self.args = args

    async def execute(self) -> int:
        target_dir = Path(self.args.dir).resolve()

        # Verify skills are bundled
        if not SKILLS_DIR.exists() or not (SKILLS_DIR / 'SKILL.md').exists():
            print('Error: Agent documentation not found in the installed package.')
            print(f'Expected at: {SKILLS_DIR}')
            return 1

        # Determine which agents to scaffold
        selected = self._get_selected_agents()
        if selected is None:
            return 0  # User cancelled

        docs_content = _build_docs_content(SKILLS_DIR)

        print()
        print('Scaffolding RocketRide agent documentation...')
        print()

        # Always write .rocketride/rocketride-python.md as universal fallback
        rocketride_dir = target_dir / '.rocketride'
        rocketride_dir.mkdir(parents=True, exist_ok=True)
        rocketride_md = '\n'.join(
            [
                '# RocketRide (Python SDK)',
                '',
                '> This file is auto-generated by `rocketride init`.',
                '> It is safe to add `.rocketride/` to your `.gitignore`.',
                '',
                '## For Coding Agents',
                '',
                docs_content,
                '',
            ]
        )
        _write_owned_file(rocketride_dir / 'rocketride-python.md', rocketride_md, 'universal fallback')

        # Scaffold each selected integration
        for target in AGENT_TARGETS:
            filepath = target_dir / target['path']
            enabled = target['key'] in selected

            if target['mode'] == 'owned':
                if enabled:
                    if target['key'] == 'cursor':
                        # Cursor needs .mdc frontmatter
                        content = '\n'.join(
                            [
                                '---',
                                'description: Build, edit, or debug RocketRide data processing pipelines. Use when the user asks about RocketRide pipelines, nodes, lanes, or agent workflows.',
                                'alwaysApply: false',
                                '---',
                                '',
                                docs_content,
                                '',
                            ]
                        )
                    else:
                        content = docs_content + '\n'
                    _write_owned_file(filepath, content, target['label'])
                else:
                    _remove_owned_file(filepath, target['label'])
            else:
                if enabled:
                    _upsert_shared_file(filepath, docs_content, target['label'])
                else:
                    _remove_shared_section(filepath, target['label'])

        print()
        print('Done! Agents can now build RocketRide pipelines in this project.')
        print()
        print('Tip: Add `rocketride.md` and `.rocketride/` to your .gitignore')
        return 0

    def _get_selected_agents(self) -> 'List[str] | None':
        """Get selected agents from flags or interactive prompt."""
        # Check if any flags are set
        flag_keys = ['claude', 'cursor', 'codex', 'copilot', 'windsurf']
        if self.args.all:
            return flag_keys

        selected = [k for k in flag_keys if getattr(self.args, k, False)]
        if selected:
            return selected

        # Interactive mode — only if TTY
        if not sys.stdin.isatty():
            print('Error: No agents selected. Use --claude, --cursor, --codex, --copilot, --windsurf, or --all')
            return None

        print('Select agent integrations to scaffold:')
        print()
        for i, target in enumerate(AGENT_TARGETS, 1):
            warning = f' \u26a0 {target["warning"]}' if target['warning'] else ''
            print(f'  [{i}] {target["label"]:<20} ({target["path"]}){warning}')
        print()

        try:
            choice = input("Enter numbers separated by commas (or 'all'): ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return None

        if not choice:
            return None
        if choice.lower() == 'all':
            return flag_keys

        try:
            indices = [int(x.strip()) for x in choice.split(',')]
            return [AGENT_TARGETS[i - 1]['key'] for i in indices if 1 <= i <= len(AGENT_TARGETS)]
        except (ValueError, IndexError):
            print('Invalid selection.')
            return None
