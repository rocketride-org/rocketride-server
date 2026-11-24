# Copyright 2026 Aparavi Software AG. MIT License.
"""The Cursor plugin staged in docs/cursor/plugin has the files and fields Cursor's Marketplace reads."""

import base64
import json
import re
import shutil
import struct
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[1]
PLUGIN = ROOT / 'docs' / 'cursor' / 'plugin'
SERVER = {'type': 'http', 'url': 'https://api.rocketride.ai/mcp'}
BASE = 'Build, check and run RocketRide data and AI pipelines'
FIELDS = 'name displayName version description author.name homepage repository license logo keywords category'.split()
NAME = re.compile(r'^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$')
SEMVER = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$')
BANNED = re.compile(r'\b(best|leading|only|official|free|trial|meta-harness|enterprise-grade)\b', re.IGNORECASE)
LINK = re.compile(r'https://cursor\.com/install-mcp\?name=rocketride&config=([A-Za-z0-9+/=]+)')


def problems(root=PLUGIN):
    manifest = json.loads((root / '.cursor-plugin' / 'plugin.json').read_text(encoding='utf-8'))
    fields = {**manifest, 'author.name': manifest.get('author', {}).get('name')}
    found = [f'plugin.json is missing {key}' for key in FIELDS if not fields.get(key)]
    if not NAME.match(manifest.get('name', '')):
        found.append(f'name {manifest.get("name")!r} must be lowercase kebab-case')
    if not SEMVER.match(manifest.get('version', '')):
        found.append(f'version {manifest.get("version")!r} is not a semantic version')
    description = manifest.get('description', '')
    if not description.startswith(BASE):
        found.append(f'description must start with {BASE!r}')
    found += [f'description uses {match[0]!r}' for match in BANNED.finditer(description)]
    logo = manifest.get('logo', '')
    data = b''
    if logo and not Path(logo).is_absolute() and '..' not in Path(logo).parts and (root / logo).is_file():
        data = (root / logo).read_bytes()
    if not data.startswith(b'\x89PNG\r\n\x1a\n') or len(set(struct.unpack('>II', data[16:24]))) != 1:
        found.append(f'logo {logo!r} must be a relative path to a square PNG in the plugin')
    if (root / 'mcp.json').read_bytes() != (root / '.mcp.json').read_bytes():
        found.append('.mcp.json must have the same bytes as mcp.json')
    if json.loads((root / 'mcp.json').read_text(encoding='utf-8')) != {'mcpServers': {'rocketride': SERVER}}:
        found.append(f'mcp.json must hold one server, rocketride, with exactly {SERVER}')
    if (root / 'LICENSE').read_bytes() != (ROOT / 'LICENSE').read_bytes():
        found.append('LICENSE must be a copy of the root LICENSE')
    links = LINK.findall((root / 'README.md').read_text(encoding='utf-8'))
    if not links or any(json.loads(base64.b64decode(link)).get('url') != SERVER['url'] for link in links):
        found.append(f'README.md must have the Cursor install link for {SERVER["url"]}')
    return found


def test_the_staged_plugin_has_what_cursor_reads():
    assert problems() == []


def edit_manifest(root, key, value):
    path = root / '.cursor-plugin' / 'plugin.json'
    manifest = json.loads(path.read_text(encoding='utf-8'))
    manifest[key] = value
    path.write_text(json.dumps(manifest), encoding='utf-8')


@pytest.mark.parametrize(
    ('change', 'message'),
    [
        (lambda root: edit_manifest(root, 'name', 'RocketRide'), "name 'RocketRide' must be lowercase kebab-case"),
        (lambda root: (root / 'assets' / 'logo.png').unlink(), "logo 'assets/logo.png' must be a relative path"),
        (lambda root: (root / '.mcp.json').write_text('{}\n'), '.mcp.json must have the same bytes as mcp.json'),
        (lambda root: edit_manifest(root, 'description', 'The best way to run pipelines.'), 'description must start'),
        (lambda root: edit_manifest(root, 'description', f'{BASE}, the official way.'), "description uses 'official'"),
    ],
)
def test_a_broken_plugin_fails_with_a_clear_message(tmp_path, change, message):
    shutil.copytree(PLUGIN, tmp_path / 'plugin')
    change(tmp_path / 'plugin')
    found = problems(tmp_path / 'plugin')
    assert any(message in problem for problem in found), found
