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
RocketRide CLI Init Command.

Scaffolds a RocketRide workspace in the current directory: copies the agent
docs into `.rocketride/docs/`, installs agent stub files (CLAUDE.md, cursor
rules, etc.) for any detected coding agents, and adds `.rocketride/` to
`.gitignore`. Mirrors what the VS Code extension does on project open
(see `apps/vscode/src/agents/agent-manager.ts`) so workspaces created from
the terminal and from the IDE are interchangeable.

Does NOT require a running server, an API key, or the VS Code extension.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from .base import BaseCommand

if TYPE_CHECKING:
    from rocketride import RocketRideClient


# Markers used to delimit RocketRide content inside agent stub files. Matches
# apps/vscode/src/agents/base-installer.ts so files written by the CLI can be
# updated by the VS Code extension and vice-versa.
_MARKER_BEGIN = '<!-- ROCKETRIDE:BEGIN -->'
_MARKER_END = '<!-- ROCKETRIDE:END -->'

_GITIGNORE_ENTRY = '.rocketride/'

# Doc files copied verbatim into .rocketride/docs/ — same list as
# apps/vscode/src/agents/agent-manager.ts:DOC_FILES.
_DOC_FILES = (
    'ROCKETRIDE_README.md',
    'ROCKETRIDE_QUICKSTART.md',
    'ROCKETRIDE_PIPELINE_RULES.md',
    'ROCKETRIDE_COMPONENT_REFERENCE.md',
    'ROCKETRIDE_COMMON_MISTAKES.md',
    'ROCKETRIDE_python_API.md',
    'ROCKETRIDE_typescript_API.md',
)

# Map of CLI-facing agent keys -> (stub source filename, target path relative
# to workspace root). Mirrors the per-agent installers under
# apps/vscode/src/agents/.
_AGENTS: dict[str, tuple[str, str]] = {
    'cursor': ('cursor.mdc', '.cursor/rules/rocketride.mdc'),
    'claude-code': ('claude-code.md', '.claude/rules/rocketride.md'),
    'windsurf': ('windsurf.md', '.windsurf/rules/rocketride.md'),
    'copilot': ('copilot-instructions.md', '.github/copilot-instructions.md'),
    'claude-md': ('CLAUDE.md', 'CLAUDE.md'),
    'agents-md': ('AGENTS.md', 'AGENTS.md'),
}

# Order matters: stubs are installed in this order so logs read top-down the
# same way regardless of detection path.
_AGENT_ORDER = ('cursor', 'claude-code', 'windsurf', 'copilot', 'claude-md', 'agents-md')

# Used when no agent is detected. CLAUDE.md / AGENTS.md are universal —
# installing them is a safe default for "user ran init in a vanilla terminal".
_FALLBACK_AGENTS = ('claude-md', 'agents-md')


class InitCommand(BaseCommand):
    """Scaffold a RocketRide workspace from the terminal."""

    def __init__(self, cli, args):
        """Initialize InitCommand with CLI context and parsed arguments."""
        super().__init__(cli, args)

    async def execute(self, client: 'RocketRideClient') -> int:
        """Scaffold the .rocketride workspace and any agent stub files."""
        target_root = Path(self.args.path).resolve() if self.args.path else Path.cwd()

        if not target_root.exists():
            print(f'Error: target directory does not exist: {target_root}')
            return 1
        if not target_root.is_dir():
            print(f'Error: target is not a directory: {target_root}')
            return 1

        try:
            templates = _resolve_templates_dir()
        except FileNotFoundError as e:
            print(f'Error: {e}')
            return 1

        force = bool(getattr(self.args, 'force', False))
        no_overwrite = bool(getattr(self.args, 'no_overwrite', False))
        if force and no_overwrite:
            print('Error: --force and --no-overwrite are mutually exclusive')
            return 1

        agents = self._select_agents(target_root)

        # Fail-fast: every required template must exist before we touch the
        # target directory. Otherwise a broken install/checkout could produce a
        # half-scaffolded workspace.
        missing = _missing_templates(templates, agents)
        if missing:
            print('Error: required RocketRide templates are missing:')
            for rel in missing:
                print(f'  - {rel}')
            print('Reinstall the rocketride package, or check that docs/agents/ and docs/stubs/ are present in your checkout.')
            return 1

        print(f'Initializing RocketRide workspace in {target_root}')

        # Docs: prompt on conflict (or honor --force / --no-overwrite).
        try:
            self._install_docs(templates / 'docs', target_root, force=force, no_overwrite=no_overwrite)
        except _Aborted as e:
            print(f'Aborted: {e}')
            return 1

        # Stubs: marker-based merge — already idempotent, no prompt needed.
        for agent in agents:
            stub_src, stub_target_rel = _AGENTS[agent]
            self._install_stub(
                stub_path=templates / 'stubs' / stub_src,
                target_path=target_root / stub_target_rel,
                target_root=target_root,
                agent=agent,
            )

        self._ensure_gitignore(target_root)

        print('Done. See .rocketride/docs/ROCKETRIDE_README.md to get started.')
        return 0

    # ------------------------------------------------------------------
    # Agent selection
    # ------------------------------------------------------------------

    def _select_agents(self, target_root: Path) -> tuple[str, ...]:
        """Return the ordered list of agent keys to install stubs for."""
        if getattr(self.args, 'no_agents', False):
            return ()

        chosen = getattr(self.args, 'agent', None)
        if chosen:
            if 'all' in chosen:
                return _AGENT_ORDER
            unknown = [a for a in chosen if a not in _AGENTS]
            if unknown:
                raise SystemExit(f'Unknown agent(s): {", ".join(unknown)}. Valid: {", ".join(_AGENTS)} or "all".')
            # Preserve canonical order for deterministic output.
            return tuple(a for a in _AGENT_ORDER if a in chosen)

        detected = _detect_agents(target_root)
        if detected:
            return detected
        return _FALLBACK_AGENTS

    # ------------------------------------------------------------------
    # Docs
    # ------------------------------------------------------------------

    def _install_docs(self, source_dir: Path, target_root: Path, *, force: bool, no_overwrite: bool) -> None:
        target_dir = target_root / '.rocketride' / 'docs'
        target_dir.mkdir(parents=True, exist_ok=True)

        for name in _DOC_FILES:
            src = source_dir / name
            dest = target_dir / name
            new_content = src.read_bytes()

            if dest.exists():
                existing = dest.read_bytes()
                if _normalized(existing) == _normalized(new_content):
                    continue  # already up to date
                if no_overwrite:
                    print(f'  - kept   .rocketride/docs/{name} (--no-overwrite)')
                    continue
                if not force and not _confirm_overwrite(f'.rocketride/docs/{name}'):
                    raise _Aborted('user declined to overwrite')

            dest.write_bytes(new_content)
            print(f'  + wrote  .rocketride/docs/{name}')

    # ------------------------------------------------------------------
    # Stubs (marker-merged)
    # ------------------------------------------------------------------

    def _install_stub(self, *, stub_path: Path, target_path: Path, target_root: Path, agent: str) -> None:
        """Merge the stub template into target_path using the marker protocol."""
        stub_content = stub_path.read_text(encoding='utf-8')
        target_path.parent.mkdir(parents=True, exist_ok=True)

        existing = ''
        if target_path.exists():
            existing = target_path.read_text(encoding='utf-8')

        merged = _merge_marked_content(existing, stub_content)
        if _normalize_text(merged) == _normalize_text(existing):
            return  # nothing to do

        target_path.write_text(merged, encoding='utf-8')
        try:
            rel = target_path.relative_to(target_root).as_posix()
        except ValueError:
            rel = str(target_path)
        print(f'  + wrote  {rel} ({agent})')

    # ------------------------------------------------------------------
    # .gitignore
    # ------------------------------------------------------------------

    def _ensure_gitignore(self, target_root: Path) -> None:
        path = target_root / '.gitignore'
        existing = ''
        if path.exists():
            existing = path.read_text(encoding='utf-8')

        for line in existing.splitlines():
            if line.strip() == _GITIGNORE_ENTRY:
                return

        new_content = existing.rstrip('\n')
        if new_content:
            new_content += '\n'
        new_content += _GITIGNORE_ENTRY + '\n'
        path.write_text(new_content, encoding='utf-8')
        print('  + updated .gitignore')


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


class _Aborted(RuntimeError):
    pass


def _missing_templates(templates, agents: tuple[str, ...]) -> list[str]:
    """Return relative paths of any required template files absent from the install.

    Checks every doc in `_DOC_FILES` plus the stub source for each requested
    agent. The returned list is empty when the install is complete.
    """
    missing: list[str] = []
    docs_dir = templates / 'docs'
    for name in _DOC_FILES:
        if not (docs_dir / name).is_file():
            missing.append(f'docs/{name}')
    stubs_dir = templates / 'stubs'
    for agent in agents:
        stub_name = _AGENTS[agent][0]
        if not (stubs_dir / stub_name).is_file():
            missing.append(f'stubs/{stub_name}')
    return missing


def _normalized(b: bytes) -> bytes:
    r"""Strip CR so \r\n vs \n doesn't trigger a false rewrite."""
    return b.replace(b'\r\n', b'\n')


def _normalize_text(s: str) -> str:
    return s.replace('\r\n', '\n')


def _confirm_overwrite(label: str) -> bool:
    """Prompt y/N. In non-TTY contexts, refuse — caller should pass --force or --no-overwrite."""
    if not sys.stdin.isatty():
        print(f'  ? {label} exists and differs from template. Re-run with --force or --no-overwrite.')
        return False
    try:
        answer = input(f'  ? {label} exists and differs. Overwrite? [y/N] ').strip().lower()
    except EOFError:
        return False
    return answer in ('y', 'yes')


def _merge_marked_content(existing: str, stub_content: str) -> str:
    """Port of base-installer.ts mergeContent — marker-aware merge.

    - Empty target: write stub as-is
    - Markers present in target: replace marked block with stub's marked block
    - Otherwise: append stub with a blank-line separator
    """
    if existing == '':
        return stub_content

    begin = existing.find(_MARKER_BEGIN)
    end = existing.find(_MARKER_END)
    if begin != -1 and end != -1 and end > begin:
        before = existing[:begin]
        after = existing[end + len(_MARKER_END) :]
        return before + _extract_marked(stub_content) + after

    return existing.rstrip() + '\n\n' + stub_content


def _extract_marked(stub_content: str) -> str:
    """Pull out the BEGIN..END block from stub content, wrapping if absent."""
    begin = stub_content.find(_MARKER_BEGIN)
    end = stub_content.find(_MARKER_END)
    if begin != -1 and end != -1 and end > begin:
        return stub_content[begin : end + len(_MARKER_END)]
    return f'{_MARKER_BEGIN}\n{stub_content}\n{_MARKER_END}'


def _detect_agents(project_root: Path) -> tuple[str, ...]:
    """Pick agents based on env vars, project markers, and home-dir markers."""
    found: set[str] = set()

    # Project-level markers — strongest signal.
    if (project_root / '.cursor').is_dir():
        found.add('cursor')
    if (project_root / '.claude').is_dir():
        found.add('claude-code')
    if (project_root / '.windsurf').is_dir():
        found.add('windsurf')
    if (project_root / '.github' / 'copilot-instructions.md').exists():
        found.add('copilot')
    if (project_root / 'CLAUDE.md').exists():
        found.add('claude-md')
    if (project_root / 'AGENTS.md').exists():
        found.add('agents-md')

    # Env vars set by IDE-launched terminals.
    if os.environ.get('CURSOR_TRACE_ID'):
        found.add('cursor')
    if os.environ.get('CLAUDECODE') or os.environ.get('CLAUDE_CODE'):
        found.add('claude-code')
    if os.environ.get('TERM_PROGRAM', '').lower() == 'vscode' and not found.intersection({'cursor'}):
        # Plain VS Code → Copilot is the built-in agent.
        found.add('copilot')

    # Home-directory installs.
    home_raw = os.environ.get('USERPROFILE') or os.environ.get('HOME')
    home = Path(home_raw) if home_raw else None
    if home and (home / '.claude').is_dir():
        found.add('claude-code')
    if home and (home / '.cursor').is_dir():
        found.add('cursor')

    return tuple(a for a in _AGENT_ORDER if a in found)


def _resolve_templates_dir() -> Path:
    """Locate the bundled templates directory.

    Production wheel: lives at `rocketride/cli/templates/` (package data).
    Dev checkout: walk up from this file looking for a sibling `docs/` with
    `agents/` and `stubs/` subdirs (matches the repo layout).
    """
    # Bundled location next to this file (installed via package_data).
    here = Path(__file__).resolve()
    bundled = here.parent.parent / 'templates'
    if (bundled / 'docs').is_dir() and (bundled / 'stubs').is_dir():
        return bundled

    # Dev fallback: walk up to find the repo's docs/ folder.
    for ancestor in here.parents:
        candidate_docs = ancestor / 'docs' / 'agents'
        candidate_stubs = ancestor / 'docs' / 'stubs'
        if candidate_docs.is_dir() and candidate_stubs.is_dir():
            return _ViewDir(candidate_docs.parent)  # type: ignore[return-value]

    raise FileNotFoundError('RocketRide templates not found. Reinstall the rocketride package, or run from a checkout that contains docs/agents/ and docs/stubs/.')


class _ViewDir:
    """Lightweight Path-like that maps `docs` -> docs/agents and `stubs` -> docs/stubs.

    Used only by the dev fallback so the InitCommand can use the same
    `templates/docs` and `templates/stubs` paths regardless of source.
    """

    def __init__(self, repo_docs: Path) -> None:
        self._repo_docs = repo_docs

    def __truediv__(self, name: str) -> Path:
        if name == 'docs':
            return self._repo_docs / 'agents'
        if name == 'stubs':
            return self._repo_docs / 'stubs'
        return self._repo_docs / name
