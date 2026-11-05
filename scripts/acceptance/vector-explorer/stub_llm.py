# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""LOCAL TEST STUB of an OpenAI-compatible chat server, for the Vector Explorer lanes. Not a model.

It answers ``POST /v1/chat/completions`` deterministically, in both the plain and
the ``stream: true`` (SSE) forms the LLM nodes use: the answer starts with
``[STUB-LLM]`` and quotes the first lines of the prompt, so a test can prove the
retrieved chunks reached the LLM node. ``GET /v1/models`` lists one model.

With ``--tool-call NAME`` (and optional ``--tool-args JSON``), a request that
offers tools and carries no tool result yet is answered with one call of that
tool instead of text; the next request (with the tool result) gets text. That
lets a test drive an agent through one tool call without a real model.

Listens on 127.0.0.1 only. Every request body is appended to ``--log`` (default
``out/stub_llm_requests.jsonl`` next to this file; ``out/`` is git-ignored).
The log holds prompt text, so keep it local.

Usage: python stub_llm.py [--port 18901] [--log PATH] [--tool-call NAME [--tool-args JSON]]
"""

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PREFIX = '[STUB-LLM]'
DEFAULT_PORT = 18901
DEFAULT_LOG = Path(__file__).resolve().parent / 'out' / 'stub_llm_requests.jsonl'


def answer_for(messages) -> str:
    """Return the deterministic answer for a message list."""
    text = '\n'.join(str(m.get('content', '')) for m in messages if isinstance(m, dict))
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    quoted = ' | '.join(lines[:12])[:900]
    return f'{PREFIX} deterministic answer. prompt_chars={len(text)} context_quote="{quoted}"'


def wants_tool_call(req, tool_name) -> bool:
    """Whether this request should be answered with a call of ``tool_name``."""
    if not tool_name or not req.get('tools'):
        return False
    messages = req.get('messages') or []
    return not any(isinstance(m, dict) and m.get('role') == 'tool' for m in messages)


class StubHandler(BaseHTTPRequestHandler):
    """Request handler; the server object carries the options."""

    def log_message(self, *args):  # silence the default access log
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sse(self, events):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for event in events:
            self.wfile.write(b'data: ' + json.dumps(event).encode() + b'\n\n')
            self.wfile.flush()
        self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()

    def do_GET(self):  # noqa: N802 - http.server API
        if self.path.rstrip('/').endswith('/models'):
            return self._json(200, {'object': 'list', 'data': [{'id': 'stub-model', 'object': 'model'}]})
        return self._json(404, {'error': {'message': 'not found'}})

    def do_POST(self):  # noqa: N802 - http.server API
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw or b'{}')
        except ValueError:
            req = {'_raw': raw.decode(errors='replace')}
        self.server.log_request_body(self.path, req)
        if not self.path.rstrip('/').endswith('/chat/completions'):
            return self._json(404, {'error': {'message': f'unsupported path {self.path}'}})

        model = req.get('model', 'stub-model')
        created = int(time.time())
        base = {'id': 'chatcmpl-stub', 'created': created, 'model': model}
        tool_name = self.server.tool_call
        if wants_tool_call(req, tool_name):
            call = {
                'id': 'call_stub_1',
                'type': 'function',
                'function': {'name': tool_name, 'arguments': self.server.tool_args},
            }
            if req.get('stream'):
                return self._sse(
                    [
                        {
                            **base,
                            'object': 'chat.completion.chunk',
                            'choices': [
                                {
                                    'index': 0,
                                    'delta': {'role': 'assistant', 'tool_calls': [{'index': 0, **call}]},
                                    'finish_reason': None,
                                }
                            ],
                        },
                        {
                            **base,
                            'object': 'chat.completion.chunk',
                            'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}],
                        },
                    ]
                )
            return self._json(
                200,
                {
                    **base,
                    'object': 'chat.completion',
                    'choices': [
                        {
                            'index': 0,
                            'message': {'role': 'assistant', 'content': None, 'tool_calls': [call]},
                            'finish_reason': 'tool_calls',
                        }
                    ],
                    'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2},
                },
            )

        content = answer_for(req.get('messages') or [])
        if req.get('stream'):
            chunk = {**base, 'object': 'chat.completion.chunk'}
            events = [
                {
                    **chunk,
                    'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': ''}, 'finish_reason': None}],
                }
            ]
            for i in range(0, len(content), 64):
                events.append(
                    {
                        **chunk,
                        'choices': [{'index': 0, 'delta': {'content': content[i : i + 64]}, 'finish_reason': None}],
                    }
                )
            events.append({**chunk, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})
            return self._sse(events)
        return self._json(
            200,
            {
                **base,
                'object': 'chat.completion',
                'choices': [
                    {'index': 0, 'message': {'role': 'assistant', 'content': content}, 'finish_reason': 'stop'}
                ],
                'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2},
            },
        )


class StubServer(ThreadingHTTPServer):
    """The HTTP server plus the stub's options and request log."""

    daemon_threads = True

    def __init__(self, port, log_path, tool_call, tool_args):
        """Bind 127.0.0.1:port and remember the options."""
        super().__init__(('127.0.0.1', port), StubHandler)
        self.log_path = log_path
        self.tool_call = tool_call
        self.tool_args = tool_args
        self._lock = threading.Lock()
        log_path.parent.mkdir(parents=True, exist_ok=True)

    def log_request_body(self, path, req):
        """Append one request to the log (one JSON object per line)."""
        with self._lock, self.log_path.open('a', encoding='utf-8') as f:
            f.write(json.dumps({'t': time.time(), 'path': path, 'req': req}) + '\n')


def main():
    """Parse the options and serve until interrupted."""
    parser = argparse.ArgumentParser(description='Local test stub of an OpenAI-compatible chat server (not a model).')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--log', type=Path, default=DEFAULT_LOG)
    parser.add_argument('--tool-call', default='', help='answer requests that offer tools with one call of this tool')
    parser.add_argument('--tool-args', default='{}', help='JSON arguments of that tool call')
    args = parser.parse_args()
    json.loads(args.tool_args)  # fail early on malformed JSON
    server = StubServer(args.port, args.log, args.tool_call, args.tool_args)
    print(f'stub LLM (local test stub, not a model) on http://127.0.0.1:{args.port}/v1', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
