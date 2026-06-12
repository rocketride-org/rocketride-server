# =============================================================================
# RocketRide Engine
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

"""
n8n tool node instance (dual: agent tool + pipeline filter).

Tool face: ``@tool_function`` methods let an agent trigger workflows and inspect
workflows/executions. Pipeline face: lane handlers POST accumulated input to a
configured workflow's webhook and emit the result downstream.

SSRF posture: the host is never agent-supplied — every request goes to the
instance's configured ``base_url``; ``workflow`` arguments are sanitised to a
plain webhook path so they can't smuggle a scheme or host.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict

from rocketlib import AVI_ACTION, Entry, IInstanceBase, tool_function

from ai.common.schema import Answer, Doc
from ai.common.utils import normalize_tool_input, require_str

from . import n8n_client
from .IGlobal import IGlobal

# n8n's default webhook payload limit (N8N_PAYLOAD_SIZE_MAX). Guard binary input
# against it with a clear error rather than a confusing 413 from n8n.
_MAX_BINARY_BYTES = 16 * 1024 * 1024


def _doc_metadata(doc) -> Dict[str, Any]:
    """Best-effort, JSON-safe metadata dict from a Doc (drops private attrs)."""
    meta = getattr(doc, 'metadata', None)
    if meta is None:
        return {}
    if not isinstance(meta, dict):
        if hasattr(meta, 'model_dump'):
            meta = meta.model_dump()
        elif hasattr(meta, '__dict__'):
            meta = {k: v for k, v in vars(meta).items() if not k.startswith('_')}
        else:
            return {}
    try:
        return json.loads(json.dumps(meta, default=str))
    except (TypeError, ValueError):
        return {}


class IInstance(IInstanceBase):
    """Dual node: exposes n8n as an agent tool and as a pipeline step."""

    IGlobal: IGlobal

    def beginInstance(self) -> None:
        self._preflight_done = False
        self._text_parts: list = []
        self._documents: list = []
        self._binary: list = []
        self._avi_buffers: dict = {}

    # =======================================================================
    # Shared helpers
    # =======================================================================

    def _preflight_once(self) -> None:
        """Probe reachability once per instance (deploy-aware error on failure)."""
        if not self._preflight_done:
            n8n_client.preflight(self.IGlobal.base_url, verify=self.IGlobal.verify_tls)
            self._preflight_done = True

    def _require_write(self) -> None:
        if self.IGlobal.read_only:
            raise ValueError('This operation is blocked: the node is in read-only mode.')

    @staticmethod
    def _safe_path(workflow: str) -> str:
        """Sanitise an agent-supplied workflow webhook path.

        Rejects anything that could redirect off the configured instance or
        smuggle extra request syntax — a URL scheme, an explicit host, whitespace,
        path traversal (``.``/``..`` segments), or query/fragment/backslash
        characters — so the agent can only choose a plain path on the configured
        ``base_url``.
        """
        path = (workflow or '').strip()
        if not path:
            raise ValueError('workflow (webhook path) is required')
        candidate = path.lstrip('/')
        if (
            not candidate
            or '://' in path
            or any(c.isspace() for c in path)
            or any(ch in candidate for ch in ('?', '#', '\\'))
            or candidate in ('.', '..')
            or '/./' in f'/{candidate}/'
            or '/../' in f'/{candidate}/'
        ):
            raise ValueError(f'Invalid workflow path "{path}": provide a plain webhook path, not a URL.')
        return candidate

    @staticmethod
    def _jsonsafe_tool_result(value: Any) -> Any:
        """Coerce a webhook result to the tool's advertised ``result`` schema
        (object/array/string/null).

        ``parse_response`` can hand back a binary dict carrying raw ``bytes`` or a
        bare JSON scalar (``true``/``42``); neither matches the declared schema and
        the bytes aren't even JSON-serialisable. Binary becomes a JSON-safe
        descriptor (an agent can't consume raw bytes anyway); scalars are
        stringified. Objects/arrays/strings/None pass through untouched.
        """
        if isinstance(value, dict) and value.get('__rr_binary__'):
            data = value.get('data') or b''
            return {'binary': True, 'mime': value.get('mime') or 'application/octet-stream', 'bytes': len(data)}
        if isinstance(value, bool) or isinstance(value, (int, float)):
            return json.dumps(value)
        return value

    def _run_webhook(self, workflow: str, payload: Dict[str, Any], *, test_mode: bool, files=None) -> Dict[str, Any]:
        """Trigger a webhook and shape the result (shared by tool + pipeline faces)."""
        g = self.IGlobal
        path = self._safe_path(workflow)
        self._preflight_once()

        is_async = g.mode == 'async'
        correlation_id = ''
        started_after = ''
        if is_async:
            if not g.api_key:
                raise ValueError(
                    'Async mode polls executions via the n8n public API — set the API key in the '
                    'node config or the ROCKETRIDE_N8N_KEY env var (or switch Result mode to sync).'
                )
            # The correlation id rides in the payload, so the webhook node's recorded
            # input contains it — that's how we find OUR execution when polling.
            correlation_id = uuid.uuid4().hex
            payload = {**payload, '_rr_correlation_id': correlation_id}
            # Small grace for clock skew between this host and the n8n instance.
            started_after = (datetime.now(timezone.utc) - timedelta(seconds=10)).isoformat()

        body = n8n_client.trigger_webhook(
            g.base_url,
            path,
            payload,
            files=files,
            auth=g.webhook_auth,
            test_mode=test_mode,
            verify=g.verify_tls,
            timeout=g.sync_timeout,
        )

        if not n8n_client.is_started_ack(body):
            # Real data came back synchronously (Respond-to-Webhook) — done either way.
            return {'success': True, 'started': True, 'result': body}

        if is_async:
            workflow_id = n8n_client.find_workflow_id_by_path(g.base_url, g.api_key, path, verify=g.verify_tls)
            execution = n8n_client.wait_for_execution(
                g.base_url,
                g.api_key,
                workflow_id,
                correlation_id=correlation_id,
                started_after=started_after,
                timeout=g.async_timeout,
                verify=g.verify_tls,
            )
            return {'success': True, 'started': True, 'result': execution}

        return {
            'success': True,
            'started': True,
            'result': None,
            'note': 'Workflow started but returned no data. Add a "Respond to Webhook" node '
            'to the workflow (or set the Webhook node to respond when the last node finishes) '
            'to return a result.',
        }

    # =======================================================================
    # Tool face
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'workflow': {
                    'type': 'string',
                    'description': 'Webhook path of the workflow to trigger (the path set on its Webhook node). '
                    'Omit to use the workflow configured on the node.',
                },
                'payload': {
                    'type': 'object',
                    'description': 'JSON body sent to the webhook (available to the workflow).',
                },
                'test_mode': {
                    'type': 'boolean',
                    'description': 'Target the /webhook-test/ route (editor one-shot listener) instead of production.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'started': {'type': 'boolean'},
                'result': {'type': ['object', 'array', 'string', 'null']},
                'note': {'type': 'string'},
                'error': {'type': 'string'},
            },
        },
        description='Trigger an n8n workflow by its webhook path and return its response. The workflow must be '
        'active (or use test_mode) and should end in a "Respond to Webhook" node to return data.',
    )
    def trigger_workflow(self, args):
        """Trigger an n8n workflow via its webhook."""
        args = normalize_tool_input(args, tool_name='tool_n8n')
        workflow = (args.get('workflow') or self.IGlobal.default_workflow or '').strip()
        payload = args.get('payload') if isinstance(args.get('payload'), dict) else {}
        try:
            out = self._run_webhook(workflow, payload, test_mode=bool(args.get('test_mode')))
            out['result'] = self._jsonsafe_tool_result(out.get('result'))
            return out
        except ValueError as exc:
            return {'success': False, 'started': False, 'result': None, 'error': str(exc)}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'active': {'type': 'boolean', 'description': 'Filter to active (true) or inactive (false) workflows.'},
                'name': {'type': 'string', 'description': 'Filter by workflow name.'},
                'limit': {'type': 'integer', 'description': 'Max workflows to return (default 50).'},
            },
        },
        description='List workflows on the configured n8n instance (id, name, active state, and webhook paths). '
        'Requires the n8n API key.',
    )
    def list_workflows(self, args):
        """List workflows via the n8n public API."""
        args = normalize_tool_input(args, tool_name='tool_n8n')
        g = self.IGlobal
        params = {
            'active': args.get('active'),
            'name': args.get('name'),
            'limit': max(1, min(int(args.get('limit') or 50), 250)),
        }
        try:
            data = n8n_client.call(g.base_url, g.api_key, 'GET', '/workflows', params=params, verify=g.verify_tls)
        except ValueError as exc:
            return {'success': False, 'workflows': [], 'error': str(exc)}
        items = data.get('data', []) if isinstance(data, dict) else (data or [])
        return {'success': True, 'workflows': [n8n_client.clean_workflow(w) for w in items]}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Workflow id.'}},
        },
        description='Get a single workflow by id, including its webhook paths. Requires the n8n API key.',
    )
    def get_workflow(self, args):
        """Get one workflow by id."""
        args = normalize_tool_input(args, tool_name='tool_n8n')
        g = self.IGlobal
        try:
            wid = require_str(args, 'id', tool_name='get_workflow')
            data = n8n_client.call(g.base_url, g.api_key, 'GET', f'/workflows/{wid}', verify=g.verify_tls)
        except ValueError as exc:
            return {'success': False, 'workflow': None, 'error': str(exc)}
        return {'success': True, 'workflow': n8n_client.clean_workflow(data)}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'workflowId': {'type': 'string', 'description': 'Filter by workflow id.'},
                'status': {
                    'type': 'string',
                    'enum': ['success', 'error', 'waiting'],
                    'description': 'Filter by execution status.',
                },
                'limit': {'type': 'integer', 'description': 'Max executions to return (default 20).'},
            },
        },
        description='List recent workflow executions (id, status, timestamps). Useful for checking async runs. '
        'Requires the n8n API key.',
    )
    def list_executions(self, args):
        """List recent executions via the n8n public API."""
        args = normalize_tool_input(args, tool_name='tool_n8n')
        g = self.IGlobal
        params = {
            'workflowId': args.get('workflowId'),
            'status': args.get('status'),
            'limit': max(1, min(int(args.get('limit') or 20), 250)),
        }
        try:
            data = n8n_client.call(g.base_url, g.api_key, 'GET', '/executions', params=params, verify=g.verify_tls)
        except ValueError as exc:
            return {'success': False, 'executions': [], 'error': str(exc)}
        items = data.get('data', []) if isinstance(data, dict) else (data or [])
        return {'success': True, 'executions': [n8n_client.clean_execution(e, base_url=g.base_url) for e in items]}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {
                'id': {'type': 'string', 'description': 'Execution id.'},
                'include_data': {'type': 'boolean', 'description': 'Include the full execution data (default true).'},
            },
        },
        description="Get a single execution by id, including its output data. Use to fetch an async run's result. "
        'Requires the n8n API key.',
    )
    def get_execution(self, args):
        """Get one execution by id (with data)."""
        args = normalize_tool_input(args, tool_name='tool_n8n')
        g = self.IGlobal
        include = args.get('include_data')
        include_data = 'true' if (include is None or include) else 'false'
        try:
            eid = require_str(args, 'id', tool_name='get_execution')
            data = n8n_client.call(
                g.base_url,
                g.api_key,
                'GET',
                f'/executions/{eid}',
                params={'includeData': include_data},
                verify=g.verify_tls,
            )
        except ValueError as exc:
            return {'success': False, 'execution': None, 'error': str(exc)}
        return {'success': True, 'execution': n8n_client.clean_execution(data, base_url=g.base_url)}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Workflow id to activate.'}},
        },
        description='Activate a workflow so its production webhook is live. Blocked in read-only mode; requires the API key.',
    )
    def activate_workflow(self, args):
        """Activate a workflow (write op)."""
        return self._set_active(args, active=True, tool_name='activate_workflow')

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Workflow id to deactivate.'}},
        },
        description='Deactivate a workflow. Blocked in read-only mode; requires the API key.',
    )
    def deactivate_workflow(self, args):
        """Deactivate a workflow (write op)."""
        return self._set_active(args, active=False, tool_name='deactivate_workflow')

    def _set_active(self, args, *, active: bool, tool_name: str) -> Dict[str, Any]:
        args = normalize_tool_input(args, tool_name='tool_n8n')
        g = self.IGlobal
        verb = 'activate' if active else 'deactivate'
        try:
            self._require_write()
            wid = require_str(args, 'id', tool_name=tool_name)
            n8n_client.call(g.base_url, g.api_key, 'POST', f'/workflows/{wid}/{verb}', verify=g.verify_tls)
        except ValueError as exc:
            return {'success': False, 'error': str(exc)}
        return {'success': True, 'id': wid, 'active': active}

    # =======================================================================
    # Pipeline face — accumulate input, trigger the configured workflow, emit
    # =======================================================================

    def open(self, object: Entry):
        """Reset the per-object input accumulators."""
        self._text_parts = []
        self._documents = []
        self._binary = []
        self._avi_buffers = {}

    def writeText(self, text: str):
        """Accumulate inbound text (overriding suppresses raw passthrough)."""
        if text:
            self._text_parts.append(text)

    def writeDocuments(self, documents):
        """Accumulate inbound documents as structured items (content + metadata)."""
        for doc in documents or []:
            self._documents.append({'content': getattr(doc, 'page_content', '') or '', 'metadata': _doc_metadata(doc)})

    def writeQuestions(self, question):
        """Accumulate inbound question text (best-effort)."""
        getter = getattr(question, 'getPrompt', None)
        value = (getter() if callable(getter) else str(question)) or ''
        if value:
            self._text_parts.append(value)

    def writeImage(self, action, mimeType, buffer=b''):
        """Reassemble an inbound image stream (AVI BEGIN/WRITE/END)."""
        self._avi('image', action, mimeType, buffer)

    def writeAudio(self, action, mimeType, buffer=b''):
        """Reassemble an inbound audio stream (AVI BEGIN/WRITE/END)."""
        self._avi('audio', action, mimeType, buffer)

    def writeVideo(self, action, mimeType, buffer=b''):
        """Reassemble an inbound video stream (AVI BEGIN/WRITE/END)."""
        self._avi('video', action, mimeType, buffer)

    def _avi(self, kind: str, action, mimeType: str, buffer: bytes) -> None:
        """Reassemble a chunked binary lane into one complete (mime, bytes) item."""
        if action == AVI_ACTION.BEGIN:
            self._avi_buffers[kind] = {'mime': mimeType or 'application/octet-stream', 'buf': bytearray()}
        elif action == AVI_ACTION.WRITE:
            slot = self._avi_buffers.setdefault(
                kind, {'mime': mimeType or 'application/octet-stream', 'buf': bytearray()}
            )
            if buffer:
                slot['buf'] += buffer
                if len(slot['buf']) > _MAX_BINARY_BYTES:
                    raise ValueError(
                        f'tool_n8n: {kind} input exceeds {_MAX_BINARY_BYTES // (1024 * 1024)} MB (n8n default '
                        'payload limit). Raise N8N_PAYLOAD_SIZE_MAX on n8n, or send smaller files.'
                    )
        elif action == AVI_ACTION.END:
            slot = self._avi_buffers.pop(kind, None)
            if slot is not None:
                self._binary.append({'kind': kind, 'mime': slot['mime'], 'data': bytes(slot['buf'])})

    def _build_payload(self) -> Dict[str, Any]:
        """Assemble the n8n request body from accumulated lane input.

        ``structured`` mode preserves document boundaries + metadata as
        ``{text, documents:[{content, metadata}]}``; ``simple`` (default)
        flattens everything to ``{"data": "<text>"}`` for back-compat.
        """
        text = ''.join(self._text_parts)
        if self.IGlobal.payload_mode == 'structured':
            return {'text': text, 'documents': self._documents}
        return {'data': text + ''.join(d.get('content', '') for d in self._documents)}

    def _build_multipart(self):
        """Build (text fields, files) for a multipart POST when binary input is present."""
        fields: Dict[str, Any] = {}
        text = ''.join(self._text_parts)
        if text:
            fields['text'] = text
        if self._documents:
            fields['documents'] = json.dumps(self._documents, default=str)
        files: Dict[str, Any] = {}
        counters: Dict[str, int] = {}
        for item in self._binary:
            kind = item['kind']
            idx = counters.get(kind, 0)
            counters[kind] = idx + 1
            ext = item['mime'].split('/')[-1] if '/' in item['mime'] else 'bin'
            files[f'{kind}_{idx}'] = (f'{kind}_{idx}.{ext}', item['data'], item['mime'])
        return fields, files

    def _emit_binary(self, mime: str, data: bytes) -> None:
        """Emit binary returned by n8n onto the matching lane (or note it as text)."""
        lane = None
        for prefix, name in (('image/', 'image'), ('audio/', 'audio'), ('video/', 'video')):
            if mime.startswith(prefix):
                lane = name
                break
        if lane and self.instance.hasListener(lane):
            writer = getattr(self.instance, 'write' + lane.capitalize())
            writer(AVI_ACTION.BEGIN, mime)
            writer(AVI_ACTION.WRITE, mime, data)
            writer(AVI_ACTION.END, mime)
        elif self.instance.hasListener('text'):
            self.instance.writeText(f'[binary {mime or "application/octet-stream"}, {len(data)} bytes]')

    def closing(self):
        """Trigger the configured workflow with the accumulated input and emit the result."""
        g = self.IGlobal
        workflow = g.default_workflow
        if not workflow:
            raise ValueError('tool_n8n pipeline step: no workflow configured — set the Workflow (webhook path) field.')

        if self._binary:
            fields, files = self._build_multipart()
            result = self._run_webhook(workflow, fields, test_mode=False, files=files)
        else:
            result = self._run_webhook(workflow, self._build_payload(), test_mode=False)

        # `result['result']` is the workflow's response (sync) or the polled
        # execution (async); None when n8n only acked (no Respond-to-Webhook node).
        value = result.get('result')

        # Binary response → reassemble onto the matching image/audio/video lane.
        if isinstance(value, dict) and value.get('__rr_binary__'):
            self._emit_binary(value.get('mime') or '', value.get('data') or b'')
            return
        text = (
            value if isinstance(value, str) else json.dumps(value if value is not None else result, ensure_ascii=False)
        )

        if self.instance.hasListener('text'):
            self.instance.writeText(text)
        if self.instance.hasListener('answers'):
            answer = Answer()
            answer.setAnswer(text)
            self.instance.writeAnswers(answer)
        if self.instance.hasListener('documents'):
            self.instance.writeDocuments([Doc(page_content=text)])
        # A structured (dict/list) result also flows to a `table` lane for
        # downstream DB/ETL nodes, when one is connected.
        if isinstance(value, (dict, list)) and self.instance.hasListener('table'):
            self.instance.writeTable(json.dumps(value, ensure_ascii=False))
