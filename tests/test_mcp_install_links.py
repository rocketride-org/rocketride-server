# Copyright 2026 Aparavi Software AG. MIT License.
"""The Cursor install links in the MCP docs name the same server URL as the agent plugin."""

import base64
import json
import re
from pathlib import Path

ROOT = Path(__file__).parents[1]
FORMS = {'https://cursor.com/install-mcp', 'cursor://anysphere.cursor-deeplink/mcp/install'}
LINK = re.compile('(' + '|'.join(map(re.escape, sorted(FORMS))) + r')([^\s)"\'<>]*)')


def test_cursor_install_links_match_the_plugin_server():
    servers = json.loads((ROOT / 'docs' / 'agents' / '.mcp.json').read_text(encoding='utf-8'))['mcpServers']
    links = LINK.findall((ROOT / 'docs' / 'public' / 'mcp' / 'http' / 'connect.md').read_text(encoding='utf-8'))
    assert {form for form, _ in links} == FORMS
    for _, rest in links:
        params = dict(part.partition('=')[::2] for part in rest.partition('?')[2].split('&'))
        server = json.loads(base64.b64decode(params.get('config', ''), validate=True))
        assert params.get('name') in servers and isinstance(server, dict), (params, server)
        assert server.get('url') == servers[params['name']]['url'], (params, server)
