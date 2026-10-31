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

"""Start and drive a real HOSTED engine (``--saas``) for the acceptance tests.

TEST ONLY. The engine is the one the test run is executing under
(``sys.executable``), started with ``launcher.py`` so the stand-in
``extension.saas`` account is importable. It is configured like a deployment: the
broker URL and token in the operator-only ``RR_DB_BROKER_*`` names, the database
CA in ``RR_DB_TLS_ROOT_CERT``, and nothing else that could help (no
``ROCKETRIDE_MOCK``, no API key, no ambient proxy, no ``SSL_CERT_FILE``).

Everything the engine prints is captured, so tests can assert on what a
deployment's logs would contain.
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Mapping, Optional

HARNESS = Path(__file__).resolve().parent
LAUNCHER = HARNESS / 'launcher.py'
REPO = HARNESS.parents[2]
EAAS = REPO / 'packages' / 'ai' / 'src' / 'ai' / 'eaas.py'

# Variables that would make the engine or its children behave differently from a deployment.
_STRIPPED = (
    'ROCKETRIDE_MOCK',
    'ROCKETRIDE_APIKEY',
    'ROCKETRIDE_URI',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
)


class EngineUnavailable(RuntimeError):
    """This run cannot launch a real engine (not running under one, or no built ``dist/server``)."""


def check_available() -> None:
    """Raise :class:`EngineUnavailable` unless a real hosted engine can be started from here."""
    executable = Path(sys.executable)
    if executable.stem != 'engine':
        raise EngineUnavailable(f'not running under the RocketRide engine (interpreter: {executable.name})')
    if not (executable.parent / 'ai' / 'node.py').is_file():
        raise EngineUnavailable(f'{executable.parent}/ai/node.py is missing: build the engine (./builder build)')
    if not EAAS.is_file():
        raise EngineUnavailable(f'{EAAS} is missing')


def free_port_block() -> int:
    """A base port for the engine's task data ports (it allocates upward from it)."""
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class HostedEngine:
    """A running hosted engine plus its captured output."""

    def __init__(
        self,
        workdir: Path,
        *,
        broker_url: str,
        broker_token: str,
        db_ca: Path,
        broker_ca: Path,
        standin: str = 'own-org',
        extra_env: Optional[Mapping[str, str]] = None,
        extra_args: tuple = (),
    ):
        self.workdir = Path(workdir)
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.auth_log = self.workdir / 'authorize.jsonl'
        self.auth_log.write_text('')
        self.control = self.workdir / 'control.json'
        self.control.write_text('{}')
        self.lines: list[str] = []
        self._mark = 0
        self.port: Optional[int] = None
        self._process: Optional[subprocess.Popen] = None
        self._env = {k: v for k, v in os.environ.items() if k not in _STRIPPED}
        self._env.update(
            {
                'RR_DB_BROKER_URL': broker_url,
                'RR_DB_BROKER_TOKEN': broker_token,
                'RR_DB_TLS_ROOT_CERT': str(db_ca),
                'RR2203_EAAS': str(EAAS),
                'RR2203_EXTRA_CA': str(broker_ca),
                'RR2203_STANDIN_MODE': standin,
                'RR2203_AUTH_LOG': str(self.auth_log),
                'RR2203_CONTROL': str(self.control),
                'PYTHONIOENCODING': 'utf-8',
            }
        )
        for legacy in (
            'ROCKETRIDE_DB_BROKER_URL',
            'ROCKETRIDE_DB_BROKER_TOKEN',
            'ROCKETRIDE_DB_DSNS',
            'ROCKETRIDE_DB_DSN',
        ):
            self._env.pop(legacy, None)
        if os.environ.get('RR_TEST_BROKER_ENV_NAMES') == 'legacy':
            # To compare against an engine from before the operator-only names existed: hand the broker
            # settings over under the old ROCKETRIDE_DB_BROKER_* names. Not used by a normal run.
            self._env['ROCKETRIDE_DB_BROKER_URL'] = self._env.pop('RR_DB_BROKER_URL')
            self._env['ROCKETRIDE_DB_BROKER_TOKEN'] = self._env.pop('RR_DB_BROKER_TOKEN')
        self._env.update(extra_env or {})
        self._args = extra_args

    # -- lifecycle ---------------------------------------------------------

    def start(self, timeout: float = 120.0) -> 'HostedEngine':
        check_available()
        command = [
            sys.executable,
            str(LAUNCHER),
            '--saas',
            '--host=127.0.0.1',
            '--port=0',
            f'--base_port={free_port_block()}',
            *self._args,
        ]
        self._process = subprocess.Popen(
            command,
            cwd=Path(sys.executable).parent,
            env=self._env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding='utf-8',
            errors='replace',
        )
        ready = threading.Event()

        def pump():
            assert self._process is not None and self._process.stdout is not None
            for line in self._process.stdout:
                self.lines.append(line.rstrip('\n'))
                match = re.search(r'Uvicorn running on http://127\.0\.0\.1:(\d+)', line)
                if match:
                    self.port = int(match.group(1))
                if 'Application startup complete' in line:
                    ready.set()

        threading.Thread(target=pump, daemon=True).start()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not ready.is_set():
            if self._process.poll() is not None:
                break
            time.sleep(0.1)
        if not ready.is_set() or not self.port:
            tail = '\n'.join(self.lines[-30:])
            self.stop()
            raise EngineUnavailable(f'the hosted engine did not start:\n{tail}')
        return self

    def stop(self) -> None:
        process, self._process = self._process, None
        if process is None:
            return
        process.terminate()
        try:
            process.wait(20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(10)

    def __enter__(self) -> 'HostedEngine':
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()

    # -- observation ---------------------------------------------------------

    @property
    def uri(self) -> str:
        return f'ws://127.0.0.1:{self.port}'

    def output(self) -> str:
        """Everything the engine (and the task output it relays) has printed so far."""
        return '\n'.join(self.lines)

    def authorizations(self) -> list[dict]:
        """What the stand-in authorizer was asked, in order."""
        text = self.auth_log.read_text(encoding='utf-8')
        return [json.loads(line) for line in text.splitlines() if line.strip()]

    def reset_authorizations(self) -> None:
        """Start a test from a clean slate: empty authorization log, no stand-in quirk, new log mark."""
        self.auth_log.write_text('')
        self.set_quirk('')
        self._mark = len(self.lines)

    def set_quirk(self, quirk: str) -> None:
        """Make the stand-in authorizer answer wrongly (see ``extension.saas``) until reset."""
        self.control.write_text(json.dumps({'quirk': quirk}))

    def db_access_records(self, wait: float = 5.0, at_least: int = 0) -> list[dict]:
        """The ``RocketRide DB access {...}`` log lines printed since the last reset, parsed (polls: output is asynchronous)."""
        deadline = time.monotonic() + wait
        while True:
            records = []
            for line in list(self.lines)[self._mark :]:
                marker = line.find('RocketRide DB access ')
                if marker >= 0:
                    try:
                        records.append(json.loads(line[marker + len('RocketRide DB access ') :]))
                    except ValueError:
                        pass
            if len(records) >= at_least or time.monotonic() >= deadline:
                return records
            time.sleep(0.1)
