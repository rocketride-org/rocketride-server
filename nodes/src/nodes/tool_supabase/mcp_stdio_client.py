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
Minimal MCP stdio client (no external SDK dependency).

Implements the MCP JSON-RPC lifecycle and the two server tool methods we need:
- initialize + notifications/initialized
- tools/list
- tools/call

Transport is line-delimited JSON-RPC over stdin/stdout of a child process.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional


class McpProtocolError(RuntimeError):
    pass


@dataclass(frozen=True)
class McpToolDef:
    name: str
    description: str
    inputSchema: Dict[str, Any]


class McpStdioClient:
    def __init__(
        self,
        *,
        command: str,
        args: List[str],
        env: Optional[Dict[str, str]] = None,
        cwd: Optional[str] = None,
        protocol_version: str = '2024-11-05',
        client_name: str = 'RocketRideToolsMcpClient',
        client_version: str = '0.1.0',
        timeout_s: float = 20.0,
    ) -> None:
        """Create an MCP stdio client."""
        self._command = command
        self._args = list(args)
        self._env = env
        self._cwd = cwd
        self._timeout_s = float(timeout_s)
        self._protocol_version = protocol_version
        self._client_info = {'name': client_name, 'version': client_version}

        self._proc: subprocess.Popen[str] | None = None
        self._next_id = 1

    def start(self) -> None:
        if self._proc is not None:
            raise RuntimeError('MCP stdio client already started')

        env = dict(os.environ)
        env['PYTHONUNBUFFERED'] = '1'
        if self._env:
            env.update({k: str(v) for k, v in self._env.items()})

        self._proc = subprocess.Popen(
            [self._command, *self._args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            bufsize=1,
            cwd=self._cwd,
            env=env,
        )

        # MCP lifecycle: initialize then notifications/initialized
        init_result = self._request(
            'initialize',
            {
                'protocolVersion': self._protocol_version,
                'capabilities': {'roots': {'listChanged': False}, 'sampling': {}},
                'clientInfo': self._client_info,
            },
        )
        if not isinstance(init_result, dict):
            raise McpProtocolError(f'initialize result expected object, got {type(init_result)}')

        self._notify('notifications/initialized', None)

    def stop(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is None:
            return

        try:
            if proc.stdin:
                try:
                    proc.stdin.close()
                except Exception:
                    pass

            # Give server a moment to exit gracefully
            try:
                proc.wait(timeout=2.0)
                return
            except Exception:
                pass

            try:
                proc.terminate()
            except Exception:
                pass
            try:
                proc.wait(timeout=2.0)
                return
            except Exception:
                pass

            try:
                proc.kill()
            except Exception:
                pass
        finally:
            try:
                if proc.stdout:
                    proc.stdout.close()
            except Exception:
                pass
            try:
                if proc.stderr:
                    proc.stderr.close()
            except Exception:
                pass

    def list_tools(self) -> List[McpToolDef]:
        result = self._request('tools/list', {})
        if not isinstance(result, dict):
            raise McpProtocolError(f'tools/list result expected object, got {type(result)}')
        tools = result.get('tools', [])
        if not isinstance(tools, list):
            raise McpProtocolError(f'tools/list result.tools expected list, got {type(tools)}')

        out: List[McpToolDef] = []
        for t in tools:
            if not isinstance(t, dict):
                continue
            name = t.get('name')
            if not isinstance(name, str) or not name:
                continue
            desc = t.get('description') if isinstance(t.get('description'), str) else ''
            schema = t.get('inputSchema') if isinstance(t.get('inputSchema'), dict) else {'type': 'object'}
            out.append(McpToolDef(name=name, description=desc, inputSchema=schema))
        return out

    def call_tool(self, *, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        result = self._request('tools/call', {'name': name, 'arguments': arguments or {}})
        if not isinstance(result, dict):
            raise McpProtocolError(f'tools/call result expected object, got {type(result)}')
        return result

    # ------------------------------------------------------------------
    # JSON-RPC internals
    # ------------------------------------------------------------------
    def _notify(self, method: str, params: Any) -> None:  # noqa: ANN401
        msg: Dict[str, Any] = {'jsonrpc': '2.0', 'method': method}
        if params is not None:
            msg['params'] = params
        self._send(msg)

    def _request(self, method: str, params: Any) -> Any:  # noqa: ANN401
        req_id = self._next_id
        self._next_id += 1
        msg: Dict[str, Any] = {'jsonrpc': '2.0', 'id': req_id, 'method': method}
        if params is not None:
            msg['params'] = params
        self._send(msg)
        return self._recv_response(req_id=req_id)

    def _send(self, msg: Dict[str, Any]) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise RuntimeError('MCP stdio client not started')
        line = json.dumps(msg, ensure_ascii=False)
        proc.stdin.write(line + '\n')
        proc.stdin.flush()

    def _recv_response(self, *, req_id: int) -> Any:  # noqa: ANN401
        proc = self._proc
        if proc is None or proc.stdout is None:
            raise RuntimeError('MCP stdio client not started')

        deadline = time.time() + self._timeout_s

        while True:
            if time.time() > deadline:
                raise TimeoutError(f'MCP request {req_id} timed out waiting for response')

            line = proc.stdout.readline()
            if not line:
                # Process ended or stdout closed. Include stderr tail if available.
                err = ''
                try:
                    if proc.stderr:
                        err = proc.stderr.read() or ''
                except Exception:
                    err = ''
                raise RuntimeError(f'MCP server exited while waiting for response (id={req_id}). stderr={err!r}')

            line = line.strip()
            if not line:
                continue

            try:
                msg = json.loads(line)
            except Exception:
                # Ignore non-JSON output.
                continue

            # Ignore notifications / unrelated responses.
            if not isinstance(msg, dict):
                continue
            if msg.get('id') != req_id:
                continue

            if 'error' in msg and isinstance(msg['error'], dict):
                code = msg['error'].get('code')
                message = msg['error'].get('message')
                raise McpProtocolError(f'MCP error (id={req_id}) code={code} message={message}')
            return msg.get('result')
