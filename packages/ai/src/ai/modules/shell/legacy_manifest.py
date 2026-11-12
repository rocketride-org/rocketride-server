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
The legacy public-page list in the publicPages + site contract shape.

The page aggregate holds it while no published platform app contributes a
valid page (see ``public_pages.legacy_aggregate``): the pages the shell
served before home-ui declared its own, and the old URLs that 301 to them,
filtered against the live route table like any claim.
"""

from typing import Any, Dict

# (path, title, description). Titles and descriptions mirror the client route
# manifest in apps/home-ui/src/routes.ts (rocketride-saas) and the legal
# documents' front matter (apps/home-ui/content/legal/<slug>.md).
_LEGACY_ROUTES = [
    (
        '/',
        'Home',
        'Build, run, and harness AI at rocket speed. From prototype to production. '
        'Fully managed, predictable costs, true portability.',
    ),
    (
        '/pricing',
        'Pricing',
        'Predictable pricing that scales with you. Subscription plans and '
        'metered billing, with no hard caps, no surprise bills, and no vendor '
        'lock-in.',
    ),
    (
        '/marketplace',
        'Marketplace',
        'Ready-to-run AI apps built on RocketRide. Browse the catalog, try apps '
        'instantly, and deploy them on managed infrastructure.',
    ),
    (
        # Legacy alias for /marketplace (the pre-rename App Store URL): old
        # links and bookmarks keep working, and the client route manifest
        # (routes.ts) canonicalizes the address bar to /marketplace.
        '/store',
        'Marketplace',
        'Ready-to-run AI apps built on RocketRide. Browse the catalog, try apps '
        'instantly, and deploy them on managed infrastructure.',
    ),
    (
        '/build-publish-earn',
        'Build, Publish, Earn',
        'Build AI apps on RocketRide, publish them to the Marketplace, and earn '
        'from every run. Bring your own pipeline, reach customers, get paid.',
    ),
    (
        '/oss',
        'Open Source',
        'Design, run, and deploy AI pipelines visually. Open source, self-hostable, and free to run anywhere.',
    ),
    (
        '/cloud',
        'Cloud',
        'Run and scale your AI pipelines on managed cloud infrastructure. No servers '
        'to run, no capacity to plan, no lock-in.',
    ),
    (
        # NOT /mcp: /mcp and /mcp/* are the MCP API (see ai.modules.mcp).
        '/mcp-server',
        'MCP',
        'Connect tools and data to your AI with the Model Context Protocol. Bring '
        'your own servers or use the ones RocketRide ships with.',
    ),
    (
        '/extension',
        'Extension',
        'Build and run RocketRide pipelines inside your editor with the IDE extension.',
    ),
    (
        '/sdk',
        'SDK',
        'Client SDKs for Python and TypeScript. Execute pipelines, move data, and monitor runs from your own code.',
    ),
    (
        '/blog',
        'Blog',
        'Product updates, engineering deep dives, and stories from the RocketRide team.',
    ),
    (
        '/events',
        'Events',
        'Meet the RocketRide team at conferences, webinars, and community events.',
    ),
    (
        '/about',
        'About Us',
        'Who we are and why we are building RocketRide — AI infrastructure from prototype to production.',
    ),
    (
        '/careers',
        'Careers',
        'How the RocketRide team works and what we build: the leading AI meta-harness for agents that '
        'scale in production. Open roles are listed here when we have them.',
    ),
    (
        '/contact',
        'Contact',
        'Get in touch with the RocketRide team — sales, support, and partnership inquiries.',
    ),
    (
        '/superfans',
        'Superfans',
        'The developers who build with RocketRide and tell us the truth. Earn early builds, a hand on the '
        'roadmap, and artifacts you can only be given.',
    ),
    # The legal pages: the index (routes.ts) and one entry per published
    # document. Exact paths only: a slug that is not a document is a 404.
    (
        '/legal',
        'Legal',
        'The policies and terms that govern RocketRide Cloud - each document with its version, '
        'effective date, and latest change.',
    ),
    (
        '/legal/terms',
        'RocketRide Cloud Terms of Service',
        'The agreement governing use of RocketRide Cloud, including accounts, payments, and acceptable service use.',
    ),
    (
        '/legal/privacy-policy',
        'Privacy Policy',
        'How RocketRide collects, uses, and shares personal information across its websites and RocketRide Cloud.',
    ),
    (
        '/legal/dpa',
        'Data Processing Agreement',
        'The data processing terms that apply when RocketRide processes personal data on behalf of business customers.',
    ),
    (
        '/legal/acceptable-use',
        'Acceptable Use Policy',
        'The rules for what may and may not be done with RocketRide Cloud and its services.',
    ),
    (
        '/legal/subprocessors',
        'RocketRide Cloud Sub-processors',
        'The third-party sub-processors RocketRide uses to provide RocketRide Cloud, and how the list changes.',
    ),
    (
        '/legal/trademark-policy',
        'Trademark & Brand Usage Policy',
        'How the RocketRide name, logo, and brand assets may and may not be used.',
    ),
    (
        '/legal/cookie-policy',
        'Cookie Policy',
        'How RocketRide uses cookies, similar technologies, and website analytics on its websites and '
        'RocketRide Cloud, and the choices you have.',
    ),
    (
        '/legal/marketplace-terms',
        'Marketplace Publisher Terms',
        'The terms for publishing apps on the RocketRide Marketplace, including eligibility, revenue share, '
        'payouts, and taxes.',
    ),
]

# Served but not advertised (``listed: false``): absent from /sitemap.xml and
# /llms.txt, and served with noindex. /oss and /mcp-server are `unlisted` in
# the client route manifest; /store is the legacy alias the client
# canonicalizes to /marketplace; /marketplace and /build-publish-earn are
# `unlisted` in routes.ts until the Marketplace relaunches.
_LEGACY_UNLISTED = frozenset({'/oss', '/mcp-server', '/store', '/marketplace', '/build-publish-earn'})

# Old URLs answered with a 301 to a legacy page: home-ui's src/redirects.ts
# (rocketride-saas) entries, in its order, except the agreement URLs
# (/master-saas-agreement, /end-user-license-agreement), which 404 until legal
# confirms their target: browsers cache a wrong 301. A source matches exactly,
# so each is listed with and without its trailing slash.
_LEGACY_REDIRECTS = [
    ('/terms', '/legal/terms'),
    ('/terms/', '/legal/terms'),
    ('/privacy-policy', '/legal/privacy-policy'),
    ('/privacy-policy/', '/legal/privacy-policy'),
    ('/privacy', '/legal/privacy-policy'),
    ('/privacy/', '/legal/privacy-policy'),
]

# The routes.ts document-title convention, applied to the head <title> only
# (the page title stays bare).
_LEGACY_SITE_TITLE = 'RocketRide'


def legacy_page_manifest() -> Dict[str, Any]:
    """The legacy page list in the publicPages + site contract shape."""
    return {
        'publicPages': [
            {'path': path, 'title': title, 'description': description, 'listed': path not in _LEGACY_UNLISTED}
            for path, title, description in _LEGACY_ROUTES
        ],
        'site': {
            'title': _LEGACY_SITE_TITLE,
            'blurb': (
                'Build, run, and harness AI at rocket speed. From prototype to production. '
                'Fully managed, predictable costs, true portability.'
            ),
            'docsUrl': 'https://docs.rocketride.org/llms.txt',
            'redirects': [{'from': source, 'to': target} for source, target in _LEGACY_REDIRECTS],
        },
    }


def legacy_head_title(path: str, title: str) -> str:
    """The client's document title for a legacy page ('Pricing | RocketRide'; '/' is the site title)."""
    return _LEGACY_SITE_TITLE if path == '/' else f'{title} | {_LEGACY_SITE_TITLE}'
