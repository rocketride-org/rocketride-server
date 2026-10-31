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
"""In-process fake System One backend for real-engine Gate tests.

Answers come from ``<question>:<value>`` markers in the item text, so every routing
outcome is known in advance:

- yes/no (``noul``): ``is_spam:yes`` -> 0.95, otherwise 0.05.
- pick-one (``choice``): ``department:sales`` picks ``sales``; no marker picks the last option.
- rubric (``score``): ``urgency:2`` picks level 2; no marker picks level 0.

A dict state (documents with ``state_metadata``) is searched as sorted JSON, so markers in
metadata values count too.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _text(state) -> str:
    return json.dumps(state, sort_keys=True) if isinstance(state, dict) else str(state)


def answer_for(name: str, question: dict, text: str) -> dict:
    """Return the wire answer for one question about ``text``."""
    kind = question['type']
    if kind == 'noul':
        return {'type': 'noul', 'noul': 0.95 if f'{name}:yes' in text else 0.05}
    if kind == 'choice':
        options = list(question['criteria'])
        pick = next((option for option in options if f'{name}:{option}' in text), options[-1])
        return {
            'type': 'choice',
            'choice': pick,
            'probabilities': {option: (1.0 if option == pick else 0.0) for option in options},
        }
    levels = list(question['criteria'])
    index = next((i for i in range(len(levels)) if f'{name}:{i}' in text), 0)
    return {
        'type': 'score',
        'score': float(index),
        'legend': {str(i): level for i, level in enumerate(levels)},
        'probabilities': {str(i): (1.0 if i == index else 0.0) for i in range(len(levels))},
    }


class FakeSystemOne:
    """A ``POST /v1/systemone`` server on an ephemeral 127.0.0.1 port (safe under xdist)."""

    def __init__(self):
        self.requests: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - http.server naming
                if self.path.rstrip('/') != '/v1/systemone':
                    self.send_error(404)
                    return
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                outer.requests.append(body)
                text = _text(body['state'])
                reply = {
                    'model': body.get('model'),
                    'answers': {name: answer_for(name, q, text) for name, q in body['questions'].items()},
                    'usage': {'input_tokens': len(text) // 4, 'output_tokens': len(body['questions'])},
                }
                data = json.dumps(reply).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args):
                pass

        self._server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self._server.server_address[1]}'
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> 'FakeSystemOne':
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self._server.shutdown()
        self._server.server_close()
