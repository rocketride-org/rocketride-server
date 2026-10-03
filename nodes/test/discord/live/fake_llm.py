# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""A scripted OpenAI-compatible chat endpoint for the engine tests.

The engine's ``llm_openai_api`` node accepts any ``base_url``, so pointing it
here turns "the model" into a fixed script: the answer depends only on a
directive in the question, which makes the node's answer-handling paths
(sanitizing, retries, errors, slow pipelines) repeatable without a real model.

Directives (anywhere in the request's message text):

=========================  =====================================================
``[fake:scratchpad]``      ReAct scratchpad with no final answer
``[fake:final]``           ``{"type": "final", "content": "..."}`` envelope
``[fake:errtext]``         a provider 429 error *as the answer text*
``[fake:empty]``           an empty answer
``[fake:retry]``           scratchpad on the first call, a real answer after
``[fake:http429]``         HTTP 429 on every call (the pipeline raises)
``[fake:slow:N]``          answer after N seconds
``[fake:hang:N]``          answer after N seconds (alias, used for timeouts)
(none)                     ``Fake answer: <first line of the question>``
=========================  =====================================================

Every request is recorded in ``FakeLLM.calls`` so a test can count retries.
"""

import json
import re
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

SCRATCHPAD = 'Thought: I should look this up in the docs first.\nAction: search_docs\nAction Input: "pipelines"'
FINAL_CONTENT = 'The final answer is 42.'
ERROR_TEXT = (
    "Error code: 429 - {'error': {'message': 'You exceeded your current quota, please check your plan "
    "and billing details.', 'type': 'insufficient_quota', 'code': 'insufficient_quota'}}"
)
RETRY_ANSWER = 'Recovered answer after a retry.'
LATEST = "User's latest message: "

_DIRECTIVE = re.compile(r'\[fake:([a-z0-9]+)(?::(\d+))?\]')


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def _message_text(body: Dict[str, Any]) -> str:
    """The current question: the text from the last ``[e2e`` tag onwards.

    The prompt node can carry earlier turns in the request, so only the newest
    tagged question decides the directive and is matched by ``calls_matching``.
    """
    parts: List[str] = []
    for message in body.get('messages') or []:
        content = message.get('content')
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            parts.extend(str(part.get('text', '')) for part in content if isinstance(part, dict))
    text = '\n'.join(parts)
    # In a thread the node frames the question as "User's latest message: ..."
    # followed by the transcript; the question is what sits before it.
    framed = text.rfind(LATEST)
    if framed >= 0:
        return text[framed + len(LATEST) :].split('\n\nEarlier in this thread', 1)[0]
    start = text.rfind('[e2e ')
    return text[start:] if start >= 0 else text


def _full_text(body: Dict[str, Any]) -> str:
    parts: List[str] = []
    for message in body.get('messages') or []:
        content = message.get('content')
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            parts.extend(str(part.get('text', '')) for part in content if isinstance(part, dict))
    return '\n'.join(parts)


class FakeLLM:
    """The server plus its call log; one per test session."""

    def __init__(self, port: Optional[int] = None):
        self.port = port or _free_port()
        self.calls: List[Dict[str, Any]] = []
        self._seen: Dict[str, int] = {}
        self._lock = threading.Lock()
        self._server: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None

    @property
    def base_url(self) -> str:
        return f'http://127.0.0.1:{self.port}/v1'

    # -- script -------------------------------------------------------------
    def answer_for(self, text: str) -> Tuple[int, str, float]:
        """Return ``(http_status, content, delay_seconds)`` for one request."""
        matches = list(_DIRECTIVE.finditer(text))
        match = matches[-1] if matches else None
        directive = match.group(1) if match else ''
        number = int(match.group(2)) if match and match.group(2) else 0
        if directive == 'scratchpad':
            return 200, SCRATCHPAD, 0.0
        if directive == 'final':
            return 200, json.dumps({'type': 'final', 'content': FINAL_CONTENT}), 0.0
        if directive == 'errtext':
            return 200, ERROR_TEXT, 0.0
        if directive == 'empty':
            return 200, '', 0.0
        if directive == 'retry':
            key = text[-400:]
            with self._lock:
                seen = self._seen.get(key, 0)
                self._seen[key] = seen + 1
            return 200, (SCRATCHPAD if seen == 0 else RETRY_ANSWER), 0.0
        if directive == 'http429':
            return 429, '', 0.0
        if directive in ('slow', 'hang'):
            return 200, f'Fake answer after {number}s.', float(number)
        first = [line for line in text.strip().splitlines() if line.strip()]
        return 200, f'Fake answer: {first[0][:120] if first else ""}', 0.0

    def calls_matching(self, needle: str) -> List[Dict[str, Any]]:
        return [call for call in list(self.calls) if needle in call['text']]

    # -- lifecycle ----------------------------------------------------------
    def start(self) -> 'FakeLLM':
        fake = self

        class _Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # keep pytest output clean
                return

            def _send_json(self, status: int, payload: Dict[str, Any]):
                body = json.dumps(payload).encode('utf-8')
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # noqa: N802 — http.server API name
                self._send_json(200, {'object': 'list', 'data': [{'id': 'fake-e2e', 'object': 'model'}]})

            def do_POST(self):  # noqa: N802 — http.server API name
                length = int(self.headers.get('Content-Length') or 0)
                try:
                    body = json.loads(self.rfile.read(length) or b'{}')
                except ValueError:
                    body = {}
                text = _message_text(body)
                status, content, delay = fake.answer_for(text)
                fake.calls.append(
                    {
                        'at': time.time(),
                        'text': text,
                        'full': _full_text(body),
                        'status': status,
                        'stream': bool(body.get('stream')),
                    }
                )
                if delay:
                    time.sleep(delay)
                if status != 200:
                    self._send_json(
                        status,
                        {'error': {'message': 'Rate limit reached (fake)', 'type': 'rate_limit', 'code': 'rate_limit'}},
                    )
                    return
                created = int(time.time())
                if body.get('stream'):
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.end_headers()
                    for delta in ({'role': 'assistant', 'content': content}, {}):
                        chunk = {
                            'id': 'chatcmpl-fake',
                            'object': 'chat.completion.chunk',
                            'created': created,
                            'model': body.get('model', 'fake-e2e'),
                            'choices': [{'index': 0, 'delta': delta, 'finish_reason': None if delta else 'stop'}],
                        }
                        self.wfile.write(f'data: {json.dumps(chunk)}\n\n'.encode('utf-8'))
                    self.wfile.write(b'data: [DONE]\n\n')
                    return
                self._send_json(
                    200,
                    {
                        'id': 'chatcmpl-fake',
                        'object': 'chat.completion',
                        'created': created,
                        'model': body.get('model', 'fake-e2e'),
                        'choices': [
                            {'index': 0, 'message': {'role': 'assistant', 'content': content}, 'finish_reason': 'stop'}
                        ],
                        'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2},
                    },
                )

        self._server = ThreadingHTTPServer(('127.0.0.1', self.port), _Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, name='fake-llm', daemon=True)
        self._thread.start()
        return self

    def close(self):
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
