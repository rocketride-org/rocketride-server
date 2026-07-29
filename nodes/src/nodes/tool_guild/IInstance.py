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
Guild.ai tool node - per-instance logic.

Dual node with two faces over one shared ``_run_agent`` helper:

- **Tool face** — ``run_agent`` / ``get_session`` / ``get_session_events``, which
  an agent invokes as ``guild.<name>``.
- **Pipeline face** — lane input is accumulated, sent to the configured agent as
  a Guild session, and the answer is emitted downstream.

Error handling is left to the framework on both faces: ``_dispatch_tool`` calls
tool methods with no try/except and ``run_agent`` converts any raised exception
into a structured error payload, so the agent already sees a clean, actionable
error without this node catching anything. ``{'success': False, ...}`` dicts are
the obsolete style (see ``tool_v0/IInstance.py`` for the same rationale).
"""

from __future__ import annotations

import json
from typing import Any, Dict

from rocketlib import Entry, IInstanceBase, tool_function

from ai.common.schema import Answer, Doc
from ai.common.utils import normalize_tool_input, optional_int, require_str

from . import guild_client
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Dual node: exposes Guild.ai as an agent tool and as a pipeline step."""

    IGlobal: IGlobal

    def beginInstance(self) -> None:
        self._text_parts: list = []
        self._documents: list = []

    # =======================================================================
    # Shared helpers
    # =======================================================================

    def _require_workspace(self) -> None:
        """Fail early, and specifically, on the misconfigurations users hit first."""
        g = self.IGlobal
        if not g.owner or not g.workspace:
            raise ValueError(
                'Guild workspace is not configured — set the Workspace owner and Workspace fields '
                '(they are the two path segments in the Guild app URL, app.guild.ai/<owner>/<workspace>).'
            )

    def _run_agent(self, text: str, agent: str, *, wait: bool) -> Dict[str, Any]:
        """Start a Guild session and optionally wait for its answer.

        Shared by both faces. ``text`` is the caller's content and is passed
        through byte-exact.
        """
        g = self.IGlobal
        self._require_workspace()

        # Reserve budget BEFORE the POST — the cap exists to stop a runaway loop
        # from billing automations, so it has to gate the billable call itself.
        g.claim_session_slot()

        session = guild_client.start_session(
            g.base_url,
            g.key_id,
            g.key_secret,
            g.owner,
            g.workspace,
            text,
            agent=agent,
            verify=g.verify_tls,
        )
        session_id = guild_client.session_id_of(session)
        if not session_id:
            raise ValueError('Guild did not return a session id for the started session.')

        if not wait:
            return {'success': True, 'session_id': session_id, 'status': guild_client.RUNNING, 'output': None}

        guild_client.wait_for_session(
            g.base_url, g.key_id, g.key_secret, session_id, timeout=g.timeout, verify=g.verify_tls
        )
        events = guild_client.get_session_events(g.base_url, g.key_id, g.key_secret, session_id, verify=g.verify_tls)
        return {
            'success': True,
            'session_id': session_id,
            'status': guild_client.COMPLETED,
            'output': guild_client.extract_output(events),
        }

    # =======================================================================
    # Tool face
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['input'],
            'properties': {
                'input': {
                    'type': 'string',
                    'description': 'The text to send to the Guild agent as its input.',
                },
                'agent': {
                    'type': 'string',
                    'description': 'Name of the Guild agent to run. Omit to use the agent configured on the node.',
                },
                'wait': {
                    'type': 'boolean',
                    'description': 'Wait for the agent to finish and return its answer (default). '
                    'Set false to start the session and return only its id.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'session_id': {'type': 'string'},
                'status': {'type': 'string'},
                'output': {'type': ['string', 'null']},
            },
        },
        description='Run a Guild.ai agent on some input and return its answer. Use this to delegate an action '
        'to a governed agent on Guild — for example filing a ticket, updating a CRM, or posting a message — '
        'when the work belongs to a system Guild controls rather than to this pipeline. Guild runs agents '
        'asynchronously; by default this waits for the answer and returns it as `output`. Each call starts a '
        'billed Guild session, so do not retry a successful call.',
    )
    def run_agent(self, args):
        """Start a Guild agent session and return its answer."""
        args = normalize_tool_input(args, tool_name='tool_guild')
        text = require_str(args, 'input', tool_name='run_agent')
        agent = str(args.get('agent') or self.IGlobal.default_agent or '').strip()
        wait = args.get('wait')
        wait = self.IGlobal.result_mode == 'wait' if wait is None else bool(wait)
        return self._run_agent(text, agent, wait=wait)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['session_id'],
            'properties': {
                'session_id': {'type': 'string', 'description': 'Id of the Guild session to inspect.'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'session_id': {'type': 'string'},
                'status': {'type': 'string'},
            },
        },
        description='Check the status of a Guild session — whether the agent is still running, completed, or '
        'failed. Use this after starting a session without waiting, or to follow up on a run that timed out.',
    )
    def get_session(self, args):
        """Get one Guild session's status."""
        args = normalize_tool_input(args, tool_name='tool_guild')
        g = self.IGlobal
        session_id = require_str(args, 'session_id', tool_name='get_session')
        # No workspace check: GET /api/sessions/{id} is addressed by session id alone,
        # so an agent can follow up with only the id from an earlier run_agent.
        session = guild_client.get_session(g.base_url, g.key_id, g.key_secret, session_id, verify=g.verify_tls)
        return {
            'success': True,
            'session_id': session_id,
            'status': guild_client.session_status(session),
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['session_id'],
            'properties': {
                'session_id': {'type': 'string', 'description': 'Id of the Guild session to read.'},
                'limit': {
                    'type': 'integer',
                    'description': 'Max events to return (default 100, capped at 1000). Events are oldest-first, '
                    'so when the transcript is longer than this the most recent events (including the '
                    'answer) are returned.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'events': {'type': 'array'},
                'output': {'type': ['string', 'null']},
            },
        },
        description="Read a Guild session's event log — the agent's transcript, including its final answer. "
        'Use this to see what a Guild agent actually did, or to retrieve the answer from a session that was '
        'started without waiting.',
    )
    def get_session_events(self, args):
        """Get one Guild session's transcript."""
        args = normalize_tool_input(args, tool_name='tool_guild')
        g = self.IGlobal
        session_id = require_str(args, 'session_id', tool_name='get_session_events')
        # No workspace check: the events endpoint is addressed by session id alone.
        events = guild_client.get_session_events(
            g.base_url,
            g.key_id,
            g.key_secret,
            session_id,
            limit=optional_int(
                args,
                'limit',
                default=guild_client.DEFAULT_EVENT_LIMIT,
                lo=1,
                hi=guild_client.MAX_EVENT_LIMIT,
                tool_name='get_session_events',
            ),
            verify=g.verify_tls,
        )
        return {'success': True, 'events': events, 'output': guild_client.extract_output(events)}

    # =======================================================================
    # Pipeline face — accumulate input, run the configured agent, emit
    # =======================================================================

    def open(self, obj: Entry):
        """Reset the per-object input accumulators."""
        self._text_parts = []
        self._documents = []

    def writeText(self, text: str):
        """Accumulate inbound text (overriding suppresses raw passthrough)."""
        if text:
            self._text_parts.append(text)

    def writeQuestions(self, question):
        """Accumulate inbound question text (best-effort)."""
        getter = getattr(question, 'getPrompt', None)
        value = (getter() if callable(getter) else str(question)) or ''
        if value:
            self._text_parts.append(value)

    def writeDocuments(self, documents):
        """Accumulate inbound document text."""
        for doc in documents or []:
            content = getattr(doc, 'page_content', '') or ''
            if content:
                self._documents.append(content)

    def _build_input(self) -> str:
        """Flatten accumulated lane input into the agent's input text.

        Parts are joined with a newline so adjacent chunks and documents keep a
        boundary instead of running together; each part is passed through
        byte-exact (never trimmed or case-folded).
        """
        return '\n'.join(self._text_parts + self._documents)

    def closing(self):
        """Run the configured Guild agent with the accumulated input and emit its answer."""
        g = self.IGlobal
        agent = g.default_agent
        if not agent:
            raise ValueError('tool_guild pipeline step: no agent configured — set the Agent field.')

        text = self._build_input()
        if not text:
            # Nothing arrived on any lane; starting a billed session with empty
            # input helps nobody.
            return

        # The pipeline face always waits: a session id on a downstream lane is
        # of no use to the nodes that follow.
        result = self._run_agent(text, agent, wait=True)
        output = result.get('output') or ''

        if self.instance.hasListener('text'):
            self.instance.writeText(output)
        if self.instance.hasListener('answers'):
            answer = Answer()
            answer.setAnswer(output)
            self.instance.writeAnswers(answer)
        if self.instance.hasListener('documents'):
            self.instance.writeDocuments([Doc(page_content=output)])
        # A `table` lane gets the run's metadata, for downstream DB/ETL nodes
        # that want to record which Guild session produced this row.
        if self.instance.hasListener('table'):
            self.instance.writeTable(
                json.dumps(
                    {'session_id': result.get('session_id', ''), 'status': result.get('status', ''), 'output': output},
                    ensure_ascii=False,
                )
            )
