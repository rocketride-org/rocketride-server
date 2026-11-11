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
The page data sources: server data a public page binds by name.

A page's ``data`` entries (``contract.DATA_FORMS``) name them. Each entry binds
the template context key of its source name, whatever its argument, with a
documented, append-only shape (fields are only ever added):

    plans           [{id, name, price, currency, period, features[]}]: the
                    declaring app's public plans (``AccountBase.get_public_plans``)
    plans:<appId>   the same, for the named app
    app:<appId>     {name, description, url}: the named app

A named app is checked each time it is bound, the way anonymous store callers
see it: its public binding serves (enabled, approved, built), it requires no
permissions, and neither the binding nor the app's own manifest says
``public: false``. An app that fails the check binds nothing: ``plans`` is
empty and ``app`` is None.

Store text (names, descriptions) is text only. The one URL a source exposes,
``app.url``, is the declaring page's canonical URL, built by the engine from
``RR_APP_URL``, and only when it is ``https://`` (else empty).

``jsonld`` turns a bound context into the page's structured data:
SoftwareApplication for ``app``, a Product with an Offer for each plan whose
price is a plain decimal number and whose currency is an ISO 4217 code.

Freshness: ``invalidate(name)`` tells listeners (the render cache drops every
response bound to that source). The plan layer calls ``invalidate('plans')``
after a price change; a deployment change of an app some page names calls
``invalidate('app')`` (``public_pages.app_changed``), which also covers
``plans`` (a named app's plans depend on its visibility).
Those events are in-process, so bound responses also expire after
``TTL_SECONDS`` on pods that miss one, and shared caches may keep them only
for what is left of that time.
"""

import re
from decimal import Decimal
from typing import Any, Callable, Dict, List, Mapping, Optional

from rocketlib import warning

from ai.account.app_rows import manifest_of, public_winners

from .contract import Page

# How long a response bound to a source may be served from cache.
TTL_SECONDS = 300.0

_listeners: List[Callable[[str], None]] = []

# What an Offer carries: a price schema.org consumers read as a number (ASCII
# digits, optional decimals) and an ISO 4217 currency code.
_PRICE = re.compile(r'[0-9]+(?:\.[0-9]+)?')
_CURRENCY = re.compile(r'[A-Z]{3}')


def source_name(entry: str) -> str:
    """The source a ``data`` entry binds: ``plans:x`` binds ``plans``."""
    return entry.partition(':')[0]


def on_invalidate(callback: Callable[[str], None]) -> None:
    """Register ``callback(source_name)``, run when a source's data changes."""
    _listeners.append(callback)


def invalidate(name: str) -> None:
    """Announce that a source's data changed; ``app`` also announces ``plans``."""
    names = [name]
    if name == 'app':
        # A named app's plans show only while the app is visible.
        names = ['app', 'plans']
    for changed in names:
        for callback in list(_listeners):
            try:
                callback(changed)
            except Exception as exc:
                # The render cache's listener is what drops a now-private app's data.
                warning(f'[public_pages] data-source listener failed on {changed!r}: {exc}')


def _account(acct: Any) -> Any:
    if acct is None:
        from ai.account import account as acct
    return acct


def _https(url: str) -> str:
    return url if url.startswith('https://') else ''


async def app(app_id: str, acct: Any = None) -> Optional[Dict[str, str]]:
    """``{name, description}`` of an app anonymous store callers may see, else None.

    The store walk's rules (``app_deploy.resolve_app_pins``) for one app on
    the public rung: the winning serving binding (``app_rows.public_winners``,
    as the page map reads it), no ``requiredPermissions``, and
    ``public: false`` in neither the binding snapshot nor the artifact's own
    manifest (the DB edition's snapshot columns drop ``public``, so the
    manifest is re-read, as ``public_pages.load_published`` does).

    Raises:
        Exception: the bindings or the winning artifact could not be read (the
            caller serves the page without its data).
    """
    acct = _account(acct)
    org, winners = await public_winners(acct)
    row = winners.get(app_id)
    if row is None:
        return None
    snapshot = row.get('snapshot') or {}
    version = row.get('version')
    if snapshot.get('public', True) is False:
        return None
    if not isinstance(version, int):  # the store walk skips such a row too
        return None
    artifact = await acct.deployments_artifact(str(row.get('orgId') or org), app_id, version)
    if not isinstance(artifact, dict) or artifact.get('kind') != 'app':
        return None
    if manifest_of(artifact).get('public', True) is False:
        return None
    return {
        'name': str(snapshot.get('name') or artifact.get('name') or app_id),
        'description': str(snapshot.get('description') or ''),
    }


def _price(value: Any) -> Optional[str]:
    """A plan price as text: a string as given, an int, or a finite Decimal in plain notation.

    Floats are refused: binary rounding (``0.1 + 0.2``) would publish
    ``0.30000000000000004``.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, Decimal) and value.is_finite():
        return format(value, 'f')
    return None


def _plan(raw: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """One plan in the documented shape, or None when it has no name or usable price."""
    name = raw.get('name')
    price = _price(raw.get('price'))
    if not isinstance(name, str) or not name or price is None:
        return None
    currency = str(raw.get('currency') or '')
    features = raw.get('features')
    if not isinstance(features, list):
        features = []
    return {
        'id': str(raw.get('id') or ''),
        'name': name,
        'price': price,
        # Only ASCII is upper-cased ('u\u017fd'.upper() is 'USD').
        'currency': currency.upper() if currency.isascii() else currency,
        'period': str(raw.get('period') or ''),
        'features': [str(f) for f in features if isinstance(f, (str, int, float))],
    }


async def plans(app_id: str, acct: Any = None) -> List[Dict[str, Any]]:
    """An app's public plans in the documented shape (``AccountBase.get_public_plans``; [] on OSS).

    Raises:
        Exception: the account layer could not list them.
    """
    raw = await _account(acct).get_public_plans(app_id)
    return [p for p in (_plan(r) for r in raw or [] if isinstance(r, Mapping)) if p is not None]


async def bind(page: Page, url: str, acct: Any = None) -> Dict[str, Any]:
    """The template and JSON-LD context of one page: ``{source name: value}``.

    ``url`` is the page's canonical URL, exposed as ``app.url`` when it is
    ``https://``.

    Raises:
        Exception: a source could not be read (the caller serves the page
            without its data).
    """
    acct = _account(acct)
    named: Dict[str, Optional[Dict[str, str]]] = {}

    async def visible(app_id: str) -> Optional[Dict[str, str]]:
        # plans:x and app:x on one page read x's bindings and artifact once.
        if app_id not in named:
            named[app_id] = await app(app_id, acct)
        return named[app_id]

    context: Dict[str, Any] = {}
    for entry in page.data:
        name, _, app_id = entry.partition(':')
        if name == 'plans':
            context['plans'] = []
            if not app_id:
                context['plans'] = await plans(page.app_id, acct)
            elif await visible(app_id) is not None:
                context['plans'] = await plans(app_id, acct)
        elif name == 'app':
            context['app'] = None
            item = await visible(app_id)
            if item is not None:
                context['app'] = {**item, 'url': _https(url)}
    return context


def _product(plan: Mapping[str, Any], url: str) -> Dict[str, Any]:
    offer: Dict[str, Any] = {'@type': 'Offer', 'price': plan['price'], 'priceCurrency': plan['currency']}
    if url:
        offer['url'] = url
    if plan['period']:
        offer['priceSpecification'] = {
            '@type': 'UnitPriceSpecification',
            'price': plan['price'],
            'priceCurrency': plan['currency'],
            'unitText': plan['period'],
        }
    product: Dict[str, Any] = {'@type': 'Product', 'name': plan['name'], 'offers': offer}
    if plan['features']:
        product['description'] = '; '.join(plan['features'])
    return product


def jsonld(context: Mapping[str, Any], url: str) -> List[Dict[str, Any]]:
    """JSON-LD objects for a bound context; ``url`` (the page's canonical URL) is used only when ``https://``."""
    url = _https(url)
    out: List[Dict[str, Any]] = []
    item = context.get('app')
    if item:
        software: Dict[str, Any] = {
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            'name': item['name'],
        }
        if item.get('description'):
            software['description'] = item['description']
        if url:
            software['url'] = url
        out.append(software)
    for plan in context.get('plans') or []:
        if _PRICE.fullmatch(plan['price']) and _CURRENCY.fullmatch(plan['currency']):
            out.append({'@context': 'https://schema.org', **_product(plan, url)})
    return out
