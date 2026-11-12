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
home-ui's manifest as the saas emitter publishes it
(``apps/home-ui/public/app-manifest.json``): its 25 pages, seven of them
unlisted, with their titles, descriptions and listed flags, and the site
block with the legacy-URL redirects. Snapshots and data bindings (they need
a build output and plans) and ``site.organization`` are left out. Tests that
need a realistic public site build on it.
"""

from typing import Any, Dict


def home_ui_manifest(*paths: str) -> Dict[str, Any]:
    """A fresh copy of the manifest (callers may edit it).

    With ``paths``, a trimmed view: only the pages at those paths, and only
    the redirects to them.
    """
    manifest = {
        'publicPages': [
            {
                'path': '/',
                'title': 'RocketRide',
                'description': 'Build, run, and harness AI at rocket speed. From prototype to production. Fully '
                'managed, predictable costs, true portability.',
                'listed': True,
            },
            {
                'path': '/pricing',
                'title': 'Pricing | RocketRide',
                'description': 'Predictable pricing that scales with you. Subscription plans and metered billing, '
                'with no hard caps, no surprise bills, and no vendor lock-in.',
                'listed': True,
            },
            {
                'path': '/marketplace',
                'title': 'Marketplace | RocketRide',
                'description': 'Ready-to-run AI apps built on RocketRide. Browse the catalog, try apps instantly, and '
                'deploy them on managed infrastructure.',
                'listed': False,
            },
            {
                'path': '/store',
                'title': 'Marketplace | RocketRide',
                'description': 'Ready-to-run AI apps built on RocketRide. Browse the catalog, try apps instantly, and '
                'deploy them on managed infrastructure.',
                'listed': False,
            },
            {
                'path': '/build-publish-earn',
                'title': 'Build, Publish, Earn | RocketRide',
                'description': 'Publish your pipeline as an app on the RocketRide Marketplace. Two files, no servers, '
                'no payment integration to build. You keep 80% of the revenue.',
                'listed': False,
            },
            {
                'path': '/oss',
                'title': 'Open Source | RocketRide',
                'description': 'Design, run, and deploy AI pipelines visually. Open source, self-hostable, and free '
                'to run anywhere.',
                'listed': False,
            },
            {
                'path': '/cloud',
                'title': 'RocketRide Cloud: Run AI Pipelines on Managed Infrastructure',
                'description': 'Run and scale your AI pipelines on managed cloud infrastructure. No servers to run, '
                'no capacity to plan, no lock-in.',
                'listed': True,
            },
            {
                'path': '/mcp-server',
                'title': 'MCP | RocketRide',
                'description': 'Connect tools and data to your AI with the Model Context Protocol. Bring your own '
                'servers or use the ones RocketRide ships with.',
                'listed': False,
            },
            {
                'path': '/extension',
                'title': 'Extension | RocketRide',
                'description': 'Build, run and debug RocketRide AI pipelines in VS Code or Cursor. Drag nodes on the '
                'canvas or hand the .pipe file to a coding agent. Install in one command.',
                'listed': True,
            },
            {
                'path': '/sdk',
                'title': 'SDK | RocketRide',
                'description': 'Client SDKs for Python and TypeScript. Execute pipelines, move data, and monitor runs '
                'from your own code.',
                'listed': True,
            },
            {
                'path': '/blog',
                'title': 'Blog | RocketRide',
                'description': 'Product updates, engineering deep dives, and stories from the RocketRide team.',
                'listed': False,
            },
            {
                'path': '/events',
                'title': 'Events | RocketRide',
                'description': 'Meet the RocketRide team at conferences, webinars, and community events.',
                'listed': False,
            },
            {
                'path': '/about',
                'title': 'About Us | RocketRide',
                'description': 'Who we are and why we are building RocketRide — AI infrastructure from prototype to '
                'production.',
                'listed': True,
            },
            {
                'path': '/careers',
                'title': 'Careers | RocketRide',
                'description': 'How the RocketRide team works and what we build: a developer-native AI meta-harness '
                'for production AI pipelines. Open roles are listed here when we have them.',
                'listed': True,
            },
            {
                'path': '/legal',
                'title': 'Legal | RocketRide',
                'description': 'The policies and terms that govern RocketRide Cloud - each document with its version, '
                'effective date, and latest change.',
                'listed': True,
            },
            {
                'path': '/contact',
                'title': 'Contact | RocketRide',
                'description': 'Contact the RocketRide team. Report bugs on GitHub, ask setup questions on Discord, '
                'or email sales about custom plans, security reviews and procurement.',
                'listed': True,
            },
            {
                'path': '/superfans',
                'title': 'RocketRide Superfans: Early Builds and a Say in the Roadmap',
                'description': 'The developers who build with RocketRide and tell us the truth. Earn early builds, a '
                'hand on the roadmap, and artifacts you can only be given. Start on Discord.',
                'listed': True,
            },
            {
                'path': '/legal/acceptable-use',
                'title': 'Acceptable Use Policy | RocketRide',
                'description': 'The rules for what may and may not be done with RocketRide Cloud and its services.',
                'listed': True,
            },
            {
                'path': '/legal/cookie-policy',
                'title': 'Cookie Policy | RocketRide',
                'description': 'How RocketRide uses cookies, similar technologies, and website analytics on its '
                'websites and RocketRide Cloud, and the choices you have.',
                'listed': True,
            },
            {
                'path': '/legal/dpa',
                'title': 'Data Processing Agreement | RocketRide',
                'description': 'The data processing terms that apply when RocketRide processes personal data on '
                'behalf of business customers.',
                'listed': True,
            },
            {
                'path': '/legal/marketplace-terms',
                'title': 'Marketplace Publisher Terms | RocketRide',
                'description': 'The terms for publishing apps on the RocketRide Marketplace, including eligibility, '
                'revenue share, payouts, and taxes.',
                'listed': True,
            },
            {
                'path': '/legal/privacy-policy',
                'title': 'Privacy Policy | RocketRide',
                'description': 'How RocketRide collects, uses, and shares personal information across its websites '
                'and RocketRide Cloud.',
                'listed': True,
            },
            {
                'path': '/legal/subprocessors',
                'title': 'RocketRide Cloud Sub-processors | RocketRide',
                'description': 'The third-party sub-processors RocketRide uses to provide RocketRide Cloud, and how '
                'the list changes.',
                'listed': True,
            },
            {
                'path': '/legal/terms',
                'title': 'RocketRide Cloud Terms of Service | RocketRide',
                'description': 'The agreement governing use of RocketRide Cloud, including accounts, payments, and '
                'acceptable service use.',
                'listed': True,
            },
            {
                'path': '/legal/trademark-policy',
                'title': 'Trademark & Brand Usage Policy | RocketRide',
                'description': 'How the RocketRide name, logo, and brand assets may and may not be used.',
                'listed': True,
            },
        ],
        'site': {
            'title': 'RocketRide',
            'blurb': 'Build, run, and harness AI at rocket speed. From prototype to production. Fully managed, '
            'predictable costs, true portability.',
            'docsUrl': 'https://docs.rocketride.org/llms.txt',
            'redirects': [
                {'from': '/terms', 'to': '/legal/terms'},
                {'from': '/terms/', 'to': '/legal/terms'},
                {'from': '/privacy-policy', 'to': '/legal/privacy-policy'},
                {'from': '/privacy-policy/', 'to': '/legal/privacy-policy'},
                {'from': '/privacy', 'to': '/legal/privacy-policy'},
                {'from': '/privacy/', 'to': '/legal/privacy-policy'},
            ],
        },
    }
    if paths:
        manifest['publicPages'] = [p for p in manifest['publicPages'] if p['path'] in paths]
        manifest['site']['redirects'] = [r for r in manifest['site']['redirects'] if r['to'] in paths]
    return manifest
