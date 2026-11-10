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
valid page (see ``public_pages.legacy_aggregate``). The pages are the shell's
own served route list, ``shell.PUBLIC_ROUTE_MANIFEST``; the paths in
``shell.UNLISTED_ROUTES`` are served but not advertised (``listed: false``).
"""

from typing import Any, Dict

# The routes.ts document-title convention, applied to the head <title> only
# (the page title stays bare).
_LEGACY_SITE_TITLE = 'RocketRide'


def legacy_page_manifest() -> Dict[str, Any]:
    """The shell's route list in the publicPages + site contract shape."""
    from .shell import PUBLIC_ROUTE_MANIFEST, UNLISTED_ROUTES

    return {
        'publicPages': [
            {'path': path, 'title': title, 'description': description, 'listed': path not in UNLISTED_ROUTES}
            for path, title, description in PUBLIC_ROUTE_MANIFEST
        ],
        'site': {
            'title': _LEGACY_SITE_TITLE,
            'blurb': (
                'Build, run, and harness AI at rocket speed. From prototype to production. '
                'Fully managed, predictable costs, true portability.'
            ),
            'docsUrl': 'https://docs.rocketride.org/llms.txt',
        },
    }


def legacy_head_title(path: str, title: str) -> str:
    """The client's document title for a legacy page ('Pricing | RocketRide'; '/' is the site title)."""
    return _LEGACY_SITE_TITLE if path == '/' else f'{title} | {_LEGACY_SITE_TITLE}'
