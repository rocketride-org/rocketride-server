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

"""No public page can claim a path the engine itself serves.

The route table is read from the app ``eaas.run`` builds, so a module that
adds a root route without reserving it fails here, before a page could
shadow the route or be shadowed by it.
"""

from __future__ import annotations

from ai.modules.shell.contract import RESERVED_PREFIXES

from .engine_boot import boot_engine


def test_every_root_route_the_engine_serves_is_reserved(monkeypatch, tmp_path):
    routes = boot_engine(monkeypatch, tmp_path).app.routes
    roots = {}
    for route in routes:
        root = '/' + getattr(route, 'path', '').lstrip('/').split('/', 1)[0]
        roots.setdefault(root, set()).add(getattr(getattr(route, 'endpoint', None), '__module__', type(route).__name__))
    # The check must read the real table, not an empty one.
    assert {'/.well-known', '/status', '/version', '/webhook', '/services'} <= set(roots)
    unreserved = sorted(
        f'{root} {sorted(owners)}'
        for root, owners in roots.items()
        if root != '/' and root not in RESERVED_PREFIXES and not all(o.startswith('ai.modules.shell') for o in owners)
    )
    assert not unreserved, f'add these root routes to RESERVED_PREFIXES: {unreserved}'
