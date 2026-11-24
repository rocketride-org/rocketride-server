# Copyright 2026 Aparavi Software AG. MIT License.
"""The ChatGPT app package in docs/chatgpt stays inside OpenAI's limits for a public listing."""

import json
import re
import struct
from pathlib import Path
from urllib.parse import urlsplit

import pytest

ROOT = Path(__file__).parents[1]
PACKAGE = ROOT / 'docs' / 'chatgpt'
TOOLS = ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'modules' / 'mcp' / 'tools'
SERVER_URL = 'https://api.rocketride.ai/mcp'
CATEGORIES = set(
    'Productivity|Creativity|Developer Tools|Business & Operations|Data & Analytics|Communication|'
    'Education & Research|Security|Finance|Healthcare|Travel|Entertainment|Other'.split('|')
)
LIMITS = {'displayName': 30, 'shortDescription': 30, 'longDescription': 4000, 'developerName': 80}
LINKS = ('websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL')
FORBIDDEN_KEYS = {'headers', 'clientSecret', 'apps', 'hooks', 'test_credentials', 'reviewer_instructions'}
BANNED = re.compile(r'\b(best|leading|only|official|free|trial|discount|mcp|plugin)\b', re.IGNORECASE)
SEMVER = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$')
UI = ('plugin', 'extensions', 'com.openai', 'interface')
SERVER = ('mcp', 'mcpServers', 'rocketride')
FIRST_CASE = ('plugin', 'extensions', 'com.openai', 'review', 'test_cases', 'positive', 0)


def load():
    return {name: json.loads((PACKAGE / f'{name}.json').read_text(encoding='utf-8')) for name in ('plugin', 'mcp')}


def registered_tools():
    text = ''.join(path.read_text(encoding='utf-8') for path in TOOLS.glob('*.py'))
    return set(re.findall(r"registry\.register\(\s*'(\w+)'", text))


def image_size(path):
    data = path.read_bytes()
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return struct.unpack('>II', data[16:24])
    box = re.search(rb'viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"', data)
    if path.suffix == '.svg' and box:
        return float(box[1]), float(box[2])
    return None


def problems(plugin, mcp, root=PACKAGE):
    openai = plugin.get('extensions', {}).get('com.openai', {})
    ui = openai.get('interface', {})
    found = [f'{key} is missing' for key in ('name', 'version', 'description') if not plugin.get(key)]
    found += [f'{key} is missing' for key in (*LIMITS, 'category', *LINKS, 'logo', 'composerIcon') if not ui.get(key)]
    if not SEMVER.match(plugin.get('version', '')):
        found.append(f'version {plugin.get("version")!r} is not a semantic version')
    if len(plugin.get('description', '')) > 1024:
        found.append('description is over 1024 characters')
    found += [f'{k} is {len(ui[k])} characters, the limit is {n}' for k, n in LIMITS.items() if len(ui.get(k, '')) > n]
    if ui.get('category') not in CATEGORIES:
        found.append(f'category {ui.get("category")!r} is not one of the allowed values')
    prompts, capabilities = ui.get('defaultPrompt', []), ui.get('capabilities', [])
    if len(prompts) > 3 or len(set(prompts)) != len(prompts):
        found.append(f'defaultPrompt has {len(prompts)} prompts, the limit is 3 different ones')
    one_line = [ui.get(k, '') for k in ('displayName', 'shortDescription', 'developerName')] + prompts + capabilities
    found += [f'defaultPrompt {text!r} is over 128 characters' for text in prompts if len(text) > 128]
    for key in LINKS:
        parts = urlsplit(ui.get(key, ''))
        if parts.scheme != 'https' or not parts.hostname or '@' in parts.netloc:
            found.append(f'{key} must be an https URL with a host and no user info, got {ui.get(key)!r}')
    if [server.get('url') for server in mcp.get('mcpServers', {}).values()] != [SERVER_URL]:
        found.append(f'mcp.json must declare exactly one server, at {SERVER_URL}')
    present = set(re.findall(r'"(\w+)":', json.dumps([plugin, mcp])))
    found += [f'{key} must not be in the package' for key in sorted(FORBIDDEN_KEYS & present)]
    for key in [key for key in ('logo', 'logoDark', 'composerIcon', 'composerIconDark') if key in ui]:
        path = (root / ui[key]).resolve()
        if not (ui[key].startswith('./') and path.is_relative_to(root.resolve()) and path.is_file()):
            found.append(f'{key} must be a ./ path to a file inside the package, got {ui[key]!r}')
            continue
        size = image_size(path)
        if size is None or size[0] != size[1] or size[0] < 48:
            found.append(f'{key} must be a square PNG or SVG of at least 48 by 48 pixels, got {size}')
    cases = openai.get('review', {}).get('test_cases', {})
    positive, negative = cases.get('positive', []), cases.get('negative', [])
    if len(positive) != 5 or len(negative) != 3:
        found.append(f'review needs 5 positive and 3 negative test cases, got {len(positive)} and {len(negative)}')
    needs = [(case, 'tools_triggered') for case in positive]
    needs += [(case, field) for case in positive + negative for field in ('description', 'prompt', 'expected_behavior')]
    found += [f'test case {case.get("description")!r} needs {field}' for case, field in needs if not case.get(field)]
    named = {name.strip() for case in positive + negative for name in case.get('tools_triggered', '').split(',')}
    unknown = sorted(named - {''} - registered_tools())
    found += [f'test cases name {name!r}, which is not a registered tool' for name in unknown]
    listing = [plugin.get('description', ''), *plugin.get('keywords', []), *one_line, ui.get('longDescription', '')]
    listing.append(openai.get('publication', {}).get('release_notes', ''))
    found += [f'listing text uses {match[0]!r}' for match in map(BANNED.search, listing) if match]
    return found


def test_the_package_meets_the_listing_limits():
    docs = load()
    assert problems(docs['plugin'], docs['mcp']) == []


@pytest.mark.parametrize(
    ('path', 'value', 'message'),
    [
        ((*UI, 'shortDescription'), 'x' * 31, 'shortDescription is 31 characters, the limit is 30'),
        ((*UI, 'defaultPrompt'), ['One?', 'Two?', 'Three?', 'Four?'], 'defaultPrompt has 4 prompts'),
        ((*UI, 'termsOfServiceURL'), 'http://rocketride.ai/terms', 'termsOfServiceURL must be an https URL'),
        ((*UI, 'longDescription'), 'The best way to run pipelines.', "listing text uses 'best'"),
        ((*SERVER, 'url'), 'https://example.test/mcp', 'exactly one server, at https://api.rocketride.ai/mcp'),
        ((*SERVER, 'headers'), {'Authorization': 'Bearer x'}, 'headers must not be in the package'),
        ((*FIRST_CASE, 'tools_triggered'), 'get_secret', "'get_secret', which is not a registered tool"),
    ],
)
def test_a_broken_package_fails_with_a_clear_message(path, value, message):
    docs = load()
    target = docs
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    found = problems(docs['plugin'], docs['mcp'])
    assert any(message in problem for problem in found), found


def test_a_non_square_icon_fails(tmp_path):
    (tmp_path / 'wide.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 48"/>')
    docs = load()
    docs['plugin']['extensions']['com.openai']['interface']['logo'] = './wide.svg'
    found = problems(docs['plugin'], docs['mcp'], tmp_path)
    assert 'logo must be a square PNG or SVG of at least 48 by 48 pixels, got (96.0, 48.0)' in found
