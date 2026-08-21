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
Workspace ``.env`` handling shared by RocketRide client front-ends.

The reader loads the workspace ``.env`` into ``os.environ`` without
overriding the real environment (real environment wins). The writer is
line-preserving: credential updates rewrite only the keys they own and
leave every other line of the user's ``.env`` (comments, unrelated
variables, ordering) untouched.

Behavioral twin of ``client-common/typescript``'s ``env.ts`` — changes
here must be mirrored there.
"""

import os
from typing import Dict, Optional, Tuple

# The two connection pairs the clients read and write
ENV_DEV_URI = 'ROCKETRIDE_URI'
ENV_DEV_APIKEY = 'ROCKETRIDE_APIKEY'
ENV_DEPLOY_URI = 'ROCKETRIDE_DEPLOY_URI'
ENV_DEPLOY_APIKEY = 'ROCKETRIDE_DEPLOY_APIKEY'

# The standard hard-stop message for a missing deploy pair
NO_DEPLOY_TARGET_MESSAGE = 'No deployment target configured. Set ROCKETRIDE_DEPLOY_URI / ROCKETRIDE_DEPLOY_APIKEY (or pass --uri/--apikey) - the development connection is never a deploy fallback.'


def parse_env_line(line: str) -> Optional[Tuple[str, str]]:
    """
    Parse one ``.env`` line into a key/value pair.

    Supports ``KEY=VALUE``, an optional ``export `` prefix, single or
    double quotes around the value, and ``#`` comment lines.

    Args:
        line: Raw line from the file.

    Returns:
        The parsed (key, value) pair, or None for non-assignment lines.
    """
    stripped = line.strip()
    if not stripped or stripped.startswith('#'):
        return None
    if stripped.startswith('export '):
        stripped = stripped[7:].strip()
    eq = stripped.find('=')
    if eq <= 0:
        return None
    key = stripped[:eq].strip()
    value = stripped[eq + 1 :].strip()
    # Strip one matching pair of surrounding quotes
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        value = value[1:-1]
    return key, value


def load_dot_env(cwd: Optional[str] = None) -> None:
    """
    Load ``<cwd>/.env`` into ``os.environ`` without overriding variables
    the real environment already defines (real environment wins).

    Args:
        cwd: Directory holding the ``.env`` file (default: os.getcwd()).
    """
    env_path = os.path.join(cwd or os.getcwd(), '.env')
    if not os.path.isfile(env_path):
        return
    # step: parse every assignment line and setdefault it into os.environ
    with open(env_path, 'r', encoding='utf-8') as f:
        for line in f:
            pair = parse_env_line(line)
            if pair:
                os.environ.setdefault(pair[0], pair[1])


def write_dot_env(updates: Dict[str, str], cwd: Optional[str] = None) -> str:
    """
    Update keys in ``<cwd>/.env``, preserving every other line verbatim.

    Existing assignments to the given keys are rewritten in place; keys
    with no existing assignment are appended at the end. Creates the file
    when absent.

    Args:
        updates: Key/value pairs to persist.
        cwd: Directory holding the ``.env`` file (default: os.getcwd()).

    Returns:
        The path of the file written.
    """
    env_path = os.path.join(cwd or os.getcwd(), '.env')
    pending = dict(updates)
    lines = []
    if os.path.isfile(env_path):
        with open(env_path, 'r', encoding='utf-8') as f:
            lines = f.read().splitlines()

    # step: rewrite lines that assign one of the updated keys
    output = []
    for line in lines:
        pair = parse_env_line(line)
        if pair and pair[0] in pending:
            output.append(f'{pair[0]}={pending.pop(pair[0])}')
        else:
            output.append(line)

    # step: append keys that had no existing assignment
    if pending:
        while output and not output[-1].strip():
            output.pop()
        for key, value in pending.items():
            output.append(f'{key}={value}')

    with open(env_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(output) + '\n')
    return env_path
