# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

from __future__ import annotations

from typing import Any, Callable, Dict

from rocketlib import IEndpointBase, debug, getObject, monitorCompleted, monitorFailed, monitorStatus

from . import confluence_client
from .converter import convert_storage_html

_DEFAULT_PAGE_LIMIT = 25
_DEFAULT_MAX_PAGES = 1000


class IEndpoint(IEndpointBase):
    """
    IEndpoint for the Confluence source node.

    Pulls every page from a configured Confluence Cloud space via the REST
    API v2 and emits each page as a pipeline entry on the text/table lanes.
    Unlike push-style sources (Telegram, webhooks), this is a finite batch
    pull: scanObjects() walks the whole space once and returns.
    """

    target: IEndpointBase | None = None

    def _get_config(self) -> Dict[str, Any]:
        """Read the Confluence config block from serviceConfig parameters.

        The engine strips the field namespace prefix ('confluence.') before
        storing values, so keys arrive flat: 'baseUrl', 'email', 'apiToken',
        'spaceKey', 'limit'.

        Returns:
            Dict[str, Any]: Flat configuration dictionary. Returns an empty
                dict if the config block is missing or cannot be read.
        """
        try:
            return self.endpoint.serviceConfig['parameters']
        except Exception as e:
            debug(f'Confluence _get_config: EXCEPTION {e}')
            return {}

    def scanObjects(self, _path: str, _scanCallback: Callable[[Dict[str, Any]], None]):
        """Entry point called by the RocketRide engine to start the node.

        Stores the engine-provided target endpoint, then delegates to
        _run(), which performs the whole space pull synchronously and
        returns once every page has been emitted. The ``_path`` and
        ``_scanCallback`` arguments are part of the IEndpointBase interface
        contract but are not used by this source node, which drives the
        pipeline directly via getPipe()/open()/close() (matching the
        telegram/webhook source nodes) rather than through the callback.

        Args:
            _path (str): Unused. Provided by the engine as the scan root path.
            _scanCallback (Callable[[Dict[str, Any]], None]): Unused.

        Returns:
            None
        """
        self.target = self.endpoint.target
        self._run()

    def _run(self):
        """Read config, then paginate through the configured space.

        Validates required configuration up front and bails out (logging via
        monitorStatus) rather than raising, so a misconfigured node fails
        cleanly instead of crashing the engine. A pagination error partway
        through, however, is a genuine incomplete sweep, not a clean stop —
        it's reported via monitorFailed and re-raised (see below) rather than
        being logged as if the run had simply finished, so a half-built
        pull doesn't read as a successful one downstream.

        Returns:
            None
        """
        config = self._get_config()
        base_url = str(config.get('baseUrl') or '').strip().rstrip('/')
        email = str(config.get('email') or '').strip()
        api_token = str(config.get('apiToken') or '').strip()
        space_key = str(config.get('spaceKey') or '').strip()

        try:
            limit = int(config.get('limit') or _DEFAULT_PAGE_LIMIT)
        except (TypeError, ValueError):
            limit = _DEFAULT_PAGE_LIMIT
        limit = max(1, min(250, limit))

        try:
            max_pages = int(config.get('maxPages') or _DEFAULT_MAX_PAGES)
        except (TypeError, ValueError):
            max_pages = _DEFAULT_MAX_PAGES
        max_pages = max(1, max_pages)

        if not base_url or not email or not api_token or not space_key:
            monitorStatus('Confluence: missing required configuration (baseUrl/email/apiToken/spaceKey)')
            return

        session = confluence_client.build_session(email, api_token)

        monitorStatus(f'Confluence: pulling space {space_key!r} from {base_url} (max {max_pages} pages)')
        pulled = 0

        try:
            for page in confluence_client.iter_space_pages(session, base_url, space_key, limit, max_pages):
                self._emit_page(page, space_key)
                pulled += 1
        except Exception as e:
            # Pages already emitted before the failure stay emitted, but the
            # sweep itself is incomplete — surface that as a real failure
            # (not just a status line) so it doesn't look like a clean pull.
            debug(f'Confluence: failed to list pages for space {space_key!r} after {pulled} page(s): {e}')
            monitorFailed(0)
            monitorStatus(
                f'Confluence: INCOMPLETE — pulled {pulled} page(s) from space {space_key!r} before failing: {e}'
            )
            raise

        monitorStatus(f'Confluence: pulled {pulled} page(s) from space {space_key!r}')

    def _emit_page(self, page: Dict[str, Any], space_key: str):
        """Convert one Confluence page and push it through the pipeline.

        Builds a pipeline entry keyed by a ``confluence://<space>/<pageId>``
        URL, writes the converted body text to the text lane and each
        extracted table to the table lane, then closes the entry. Failures
        are logged and skipped per-page (rather than aborting the whole
        space pull), matching the "failure contained by default" behavior
        of the existing document-parser nodes.

        Args:
            page (Dict[str, Any]): Raw Confluence page object.
            space_key (str): The space the page belongs to, used for the
                entry URL.

        Returns:
            None
        """
        page_id = str(page.get('id', ''))
        title = page.get('title') or page_id
        body_html = page.get('body', {}).get('storage', {}).get('value', '')

        try:
            text, tables = convert_storage_html(body_html)
        except Exception as e:
            debug(f'Confluence: failed to convert page {page_id} ({title!r}): {e}')
            return

        entry = getObject(obj={'url': f'confluence://{space_key}/{page_id}', 'name': title})
        pipe = self.target.getPipe()
        pipe_open = False
        try:
            pipe.open(entry)
            pipe_open = True
            if text:
                pipe.writeText(text)
            for table in tables:
                pipe.writeTable(table)
            pipe.close()
            pipe_open = False
            monitorCompleted(len(text.encode('utf-8')) if text else 0)
        except Exception as e:
            debug(f'Confluence: error emitting page {page_id} ({title!r}): {e}')
            monitorFailed(len(body_html.encode('utf-8')) if body_html else 0)
        finally:
            if pipe_open:
                try:
                    pipe.close()
                except Exception as close_error:
                    debug(f'Confluence: failed to close pipe for page {page_id}: {close_error}')
            self.target.putPipe(pipe)
