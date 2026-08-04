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

from ai.common.schema import Doc, DocMetadata
from rocketlib import IEndpointBase, debug, getObject, monitorCompleted, monitorFailed, monitorStatus

from . import azure_boards_client
from .converter import build_doc_fields

_DEFAULT_MAX_RECORDS = 200


class IEndpoint(IEndpointBase):
    """
    IEndpoint for the Azure Boards source node.

    Runs a WIQL query against an Azure DevOps project and emits each
    matching work item as a pipeline entry on the documents lane. Unlike
    push-style sources (Telegram, webhooks), this is a finite batch pull:
    scanObjects() runs the query once and returns.
    """

    target: IEndpointBase | None = None

    def _get_config(self) -> Dict[str, Any]:
        """Read the Azure Boards config block from serviceConfig parameters.

        The engine strips the field namespace prefix ('azure_boards.')
        before storing values, so keys arrive flat: 'organization',
        'project', 'personalAccessToken', 'wiql', 'maxRecords'.

        Returns:
            Dict[str, Any]: Flat configuration dictionary. Returns an empty
                dict if the config block is missing or cannot be read.
        """
        try:
            return self.endpoint.serviceConfig['parameters']
        except Exception as e:
            debug(f'Azure Boards _get_config: EXCEPTION {e}')
            return {}

    def scanObjects(self, _path: str, _scanCallback: Callable[[Dict[str, Any]], None]):
        """Entry point called by the RocketRide engine to start the node.

        Stores the engine-provided target endpoint, then delegates to
        _run(), which runs the WIQL query and emits every matching work item
        synchronously, returning once done. The ``_path`` and
        ``_scanCallback`` arguments are part of the IEndpointBase interface
        contract but are not used by this source node, which drives the
        pipeline directly via getPipe()/open()/close() (matching the
        confluence/telegram/webhook source nodes) rather than through the
        callback.

        Args:
            _path (str): Unused. Provided by the engine as the scan root path.
            _scanCallback (Callable[[Dict[str, Any]], None]): Unused.

        Returns:
            None
        """
        self.target = self.endpoint.target
        self._run()

    def _run(self):
        """Read config, then run the WIQL query and emit matching work items.

        Validates required configuration up front and bails out (logging via
        monitorStatus) rather than raising, so a misconfigured node fails
        cleanly instead of crashing the engine. A failure partway through
        the pull, however, is a genuine incomplete sweep, not a clean stop —
        it's reported via monitorFailed and re-raised (see below) rather
        than being logged as if the run had simply finished, so a
        half-built pull doesn't read as a successful one downstream.

        Returns:
            None
        """
        config = self._get_config()
        organization = str(config.get('organization') or '').strip()
        project = str(config.get('project') or '').strip()
        pat = str(config.get('personalAccessToken') or '').strip()
        wiql = str(config.get('wiql') or '').strip()

        try:
            max_records = int(config.get('maxRecords') or _DEFAULT_MAX_RECORDS)
        except (TypeError, ValueError):
            max_records = _DEFAULT_MAX_RECORDS
        max_records = max(1, max_records)

        if not organization or not project or not pat or not wiql:
            monitorStatus(
                'Azure Boards: missing required configuration (organization/project/personalAccessToken/wiql)'
            )
            return

        session = azure_boards_client.build_session(pat)

        monitorStatus(f'Azure Boards: querying project {project!r} in org {organization!r} (max {max_records} records)')
        pulled = 0

        try:
            for work_item in azure_boards_client.iter_work_items(session, organization, project, wiql, max_records):
                self._emit_work_item(work_item, organization, project)
                pulled += 1
        except Exception as e:
            # Work items already emitted before the failure stay emitted,
            # but the sweep itself is incomplete — surface that as a real
            # failure (not just a status line) so it doesn't look clean.
            debug(f'Azure Boards: failed to pull work items for project {project!r} after {pulled} record(s): {e}')
            monitorFailed(0)
            monitorStatus(
                f'Azure Boards: INCOMPLETE — pulled {pulled} record(s) from project {project!r} before failing: {e}'
            )
            raise

        monitorStatus(f'Azure Boards: pulled {pulled} record(s) from project {project!r}')

    def _emit_work_item(self, work_item: Dict[str, Any], organization: str, project: str):
        """Convert one work item and push it through the pipeline as a document.

        Builds a pipeline entry keyed by an
        ``azure_boards://<org>/<project>/<id>`` URL, converts the work item
        into a single Doc (readable text summary + structured metadata),
        writes it to the documents lane, then closes the entry. Failures are
        logged and skipped per-item (rather than aborting the whole pull),
        matching the "failure contained by default" behavior of the
        confluence node.

        Args:
            work_item (Dict[str, Any]): Raw Azure DevOps work item object.
            organization (str): Azure DevOps organization, used for the
                entry URL.
            project (str): Azure DevOps project, used for the entry URL.

        Returns:
            None
        """
        work_item_id = work_item.get('id', '')
        title = (work_item.get('fields') or {}).get('System.Title') or str(work_item_id)

        try:
            page_content, extras = build_doc_fields(work_item)
        except Exception as e:
            debug(f'Azure Boards: failed to convert work item {work_item_id} ({title!r}): {e}')
            return

        entry = getObject(obj={'url': f'azure_boards://{organization}/{project}/{work_item_id}', 'name': title})
        pipe = self.target.getPipe()
        pipe_open = False
        try:
            pipe.open(entry)
            pipe_open = True
            metadata = DocMetadata(
                objectId=str(work_item_id),
                chunkId=0,
                parent=f'{organization}/{project}/{work_item_id}',
                isTable=False,
                tableId=0,
                isDeleted=False,
                **extras,
            )
            doc = Doc(page_content=page_content, metadata=metadata)
            pipe.writeDocuments([doc])
            pipe.close()
            pipe_open = False
            monitorCompleted(len(page_content.encode('utf-8')) if page_content else 0)
        except Exception as e:
            debug(f'Azure Boards: error emitting work item {work_item_id} ({title!r}): {e}')
            monitorFailed(len(page_content.encode('utf-8')) if page_content else 0)
        finally:
            if pipe_open:
                try:
                    pipe.close()
                except Exception as close_error:
                    debug(f'Azure Boards: failed to close pipe for work item {work_item_id}: {close_error}')
            self.target.putPipe(pipe)
