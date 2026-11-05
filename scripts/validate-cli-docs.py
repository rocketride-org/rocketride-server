#!/usr/bin/env python3
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
"""Check the CLI docs against the commands both `rocketride` CLIs register.

Reads each CLI's command tree from source, with no client build and no
third-party Python packages:

- Python: `setup_parser()` from packages/client-python/src/rocketride/cli/main.py.
- TypeScript: scripts/cli-command-tree.js (needs node and `pnpm install`).

Checks:

1. docs/agents/context/ROCKETRIDE_CLI.md shows every command in code.
2. Its package table lists exactly the commands and flags that only one
   package has.
3. The Commands table in docs/public/product/connect/cli.mdx lists every
   top-level command.

Exit 0 when the docs match, 1 with one line per problem when they don't,
2 when a command tree can't be read.
"""

from __future__ import annotations

import argparse
import importlib
import json
import re
import subprocess
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI_DOC = ROOT / 'docs' / 'agents' / 'context' / 'ROCKETRIDE_CLI.md'
SITE_DOC = ROOT / 'docs' / 'public' / 'product' / 'connect' / 'cli.mdx'
PY_SRC = ROOT / 'packages' / 'client-python' / 'src'
PY_COMMON_SRC = ROOT / 'packages' / 'client-common' / 'python' / 'src'

# A command tree maps each command path ('app create') to its long options.
# Groups ('app', 'deploy schedule') are left out: their sub-commands cover them.
Tree = dict[str, set[str]]


def python_tree() -> Tree:
    """Return the Python CLI's leaf commands, read from its argparse parser."""
    # Importing rocketride.cli.main runs rocketride/__init__.py and
    # rocketride/core/__init__.py, which load the whole client and its
    # third-party dependencies. The parser needs none of that, so register
    # both packages as bare namespaces first.
    sys.path[:0] = [str(PY_SRC), str(PY_COMMON_SRC)]
    for name in ('rocketride', 'rocketride.core'):
        package = types.ModuleType(name)
        package.__path__ = [str(PY_SRC.joinpath(*name.split('.')))]
        sys.modules[name] = package
    parser = importlib.import_module('rocketride.cli.main').setup_parser()

    tree = {}

    def walk(parser, prefix):
        for action in parser._actions:
            if isinstance(action, argparse._SubParsersAction):
                for name, sub in action.choices.items():
                    path = prefix + [name]
                    if not walk(sub, path):
                        tree[' '.join(path)] = {
                            option
                            for each in sub._actions
                            for option in each.option_strings
                            if option.startswith('--') and option != '--help'
                        }
                return True
        return False

    walk(parser, [])
    return tree


def typescript_tree() -> Tree:
    """Return the TypeScript CLI's leaf commands, read by scripts/cli-command-tree.js."""
    result = subprocess.run(
        ['node', str(ROOT / 'scripts' / 'cli-command-tree.js')],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f'scripts/cli-command-tree.js failed (it needs node and pnpm install):\n{result.stderr.strip()}'
        )
    return {node['path']: set(node['options']) for node in json.loads(result.stdout) if not node['group']}


def one_package_only(ts: Tree, py: Tree) -> dict:
    """Map each command or flag that only one package has to (in TypeScript, in Python)."""
    only = {path: (True, False) for path in ts.keys() - py.keys()}
    only.update({path: (False, True) for path in py.keys() - ts.keys()})
    for path in ts.keys() & py.keys():
        only.update({f'{path} {flag}': (True, False) for flag in ts[path] - py[path]})
        only.update({f'{path} {flag}': (False, True) for flag in py[path] - ts[path]})
    return only


def exists(item: str, tree: Tree) -> bool:
    """Say whether a command ('app dev') or a command's flag ('app deploy --publish') is in the tree."""
    path, _, flag = item.partition(' --')
    return path in tree and (not flag or f'--{flag}' in tree[path])


def code_text(markdown: str) -> str:
    """Return the text of every fenced code block and inline code span."""
    fenced = re.findall(r'^```[^\n]*\n(.*?)^```', markdown, re.M | re.S)
    prose = re.sub(r'^```[^\n]*\n.*?^```', '', markdown, flags=re.M | re.S)
    return '\n'.join(fenced + re.findall(r'`([^`]+)`', prose))


def mentioned(path: str, code: str) -> bool:
    """Say whether code shows the command, allowing `deploy enable|disable|remove` style lists."""
    words = [r'(?:[\w-]+\|)*' + re.escape(word) + r'(?:\|[\w-]+)*' for word in path.split()]
    # A top-level command must follow 'rocketride ', or `list` would match `deploy list`.
    prefix = r'rocketride\s+' if len(words) == 1 else r'(?<![\w-])'
    return re.search(prefix + r'\s+'.join(words) + r'(?![\w-])', code) is not None


def package_table(markdown: str) -> dict | None:
    """Parse ROCKETRIDE_CLI.md's 'Command or flag | TypeScript | Python' table."""
    lines = markdown.splitlines()
    start = next((i for i, line in enumerate(lines) if re.match(r'\|\s*Command or flag\s*\|', line)), None)
    if start is None:
        return None
    table = {}
    for line in lines[start + 2 :]:
        if not line.startswith('|'):
            break
        cells = [cell.strip() for cell in line.strip('|').split('|')]
        for item in re.findall(r'`([^`]+)`', cells[0]):
            table[item] = (cells[1].startswith('Yes'), cells[2].startswith('Yes'))
    return table


def commands_table(markdown: str) -> set:
    """Return the commands named in cli.mdx's '## Commands' table."""
    section = markdown.split('\n## Commands\n', 1)[-1].split('\n#', 1)[0]
    return set(re.findall(r'^\|\s*`([\w-]+)`\s*\|', section, re.M))


def main() -> int:
    try:
        ts, py = typescript_tree(), python_tree()
    except Exception as error:  # noqa: BLE001 - report any loader failure the same way
        print(f'error: could not read the CLI commands: {error}', file=sys.stderr)
        return 2

    problems = []
    cli_doc = CLI_DOC.read_text(encoding='utf-8')
    rel = CLI_DOC.relative_to(ROOT)

    code = code_text(cli_doc)
    for path in sorted(ts.keys() | py.keys()):
        if not mentioned(path, code):
            problems.append(f'{rel}: `rocketride {path}` is not documented')

    table = package_table(cli_doc)
    if table is None:
        problems.append(f"{rel}: no 'Command or flag | TypeScript | Python' table")
    else:
        actual = one_package_only(ts, py)
        where = {
            (True, False): 'only the TypeScript CLI has it',
            (False, True): 'only the Python CLI has it',
            (True, True): 'both CLIs have it',
        }
        for item in sorted(actual.keys() | table.keys()):
            truth = actual.get(item, (True, True))
            if not exists(item, ts) and not exists(item, py):
                problems.append(f'{rel}: package table lists `{item}`, which neither CLI has')
            elif table.get(item, (True, True)) != truth:
                problems.append(f'{rel}: package table is wrong about `{item}`: {where[truth]}')

    site_doc = SITE_DOC.read_text(encoding='utf-8')
    top_level = {path.split()[0] for path in ts.keys() | py.keys()}
    listed = commands_table(site_doc)
    for name in sorted(top_level - listed):
        problems.append(f'{SITE_DOC.relative_to(ROOT)}: `{name}` is missing from the Commands table')
    for name in sorted(listed - top_level):
        problems.append(f'{SITE_DOC.relative_to(ROOT)}: Commands table lists `{name}`, which neither CLI has')

    if problems:
        print('\n'.join(problems))
        print(f'{len(problems)} problem(s). The docs must match the commands both CLIs register.')
        return 1
    print(f'ok: CLI docs match both CLIs ({len(ts)} TypeScript and {len(py)} Python commands)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
