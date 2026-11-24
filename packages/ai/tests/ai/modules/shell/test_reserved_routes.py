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

from fastapi.responses import PlainTextResponse

import ai.modules.shell.public_pages as pp

from ai.account import account
from ai.modules.shell.contract import RESERVED_PREFIXES, check_manifest, reserved_error
from ai.modules.shell.pages import FALLBACK_PATH, public_page
from ai.modules.shell.public_pages import Published

from .engine_boot import boot_engine


def _owner(route):
    """The handler's module and name, or the route's type for a mount."""
    endpoint = getattr(route, 'endpoint', None)
    if endpoint is None:
        return type(route).__name__
    return f'{endpoint.__module__}.{getattr(endpoint, "__name__", type(endpoint).__name__)}'


def test_every_root_route_the_engine_serves_is_reserved(monkeypatch, tmp_path):
    # The IndexNow key file's root is the deployment's key, not a fixed path
    # (the publish gate's live-route check keeps pages off it): off here.
    monkeypatch.delenv('RR_INDEXNOW_KEY', raising=False)
    routes = boot_engine(monkeypatch, tmp_path).app.routes
    roots = {}
    for route in routes:
        root = '/' + getattr(route, 'path', '').lstrip('/').split('/', 1)[0]
        roots.setdefault(root, []).append(route)
    # The check must read the real table, not an empty one, the shell module's own routes included.
    assert {'/.well-known', '/status', '/version', '/webhook', '/services', '/shell', '/apps'} <= set(roots)
    # Only the public-page handler is exempt, on '/' and the catch-all, which
    # nothing else serves: it answers the paths pages claim, so reserving
    # them would refuse every page. Every other root route, a shell module
    # one included, is an engine route and must be reserved.
    claims = {root for root, owned in roots.items() if all(getattr(r, 'endpoint', None) is public_page for r in owned)}
    assert claims == {'/', FALLBACK_PATH}
    unreserved = sorted(
        f'{root} {sorted({_owner(r) for r in owned})}'
        for root, owned in roots.items()
        if root not in RESERVED_PREFIXES and root not in claims
    )
    assert not unreserved, f'add these root routes to RESERVED_PREFIXES: {unreserved}'


def test_an_unreserved_account_route_is_still_never_claimable(monkeypatch, tmp_path):
    # The SaaS overlay registers its routes in account.init_account, which the test
    # above cannot boot. One missing from RESERVED_PREFIXES is still never a page:
    # the publish gate and every aggregate build refuse a path a live route matches.
    async def billing(request):
        return PlainTextResponse('billing')

    async def init_account(server):
        server.add_route(path='/billing/{session}', routeHandler=billing, methods=['GET'])

    monkeypatch.setattr(account, 'init_account', init_account)
    manifest = {
        'publicPages': [{'path': '/pricing', 'title': 'Pricing'}, {'path': '/billing/portal', 'title': 'Billing'}]
    }
    boot_engine(monkeypatch, tmp_path, [Published('rocketride.home', manifest)])

    assert reserved_error('/billing/portal') is None
    assert set(pp.current().exact) == {'/pricing'}
    _, _, errors = check_manifest('rocketride.home', manifest, pp.live_conflict())
    assert len(errors) == 1 and 'collides with the live server route GET /billing/{session}' in errors[0], errors
