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

"""Boot the app ``ai.eaas.run`` builds, with only ``serve`` stubbed, for tests."""

import asyncio
from typing import Any, Iterable

SHELL_BODY = '<div id="root">shell</div>'


def close_bounded(loop: asyncio.AbstractEventLoop) -> None:
    """Close the loop ``eaas.run`` ran on without waiting on its service loops for ever.

    ``eaas.run`` starts the task module's service loops (scheduler, TTL monitor,
    cleanup, app builds), which only a process exit stops. ``asyncio.run`` would
    cancel them and wait with no limit, and on Windows CI that wait once never
    returned. These tests need only the built app.
    """
    pending = asyncio.all_tasks(loop)
    for task in pending:
        task.cancel()
    if pending:
        loop.run_until_complete(asyncio.wait(pending, timeout=5))
    loop.close()


def boot_engine(monkeypatch: Any, tmp_path: Any, published: Iterable[Any] = ()) -> Any:
    """The ``WebServer`` ``eaas.run`` builds (every module, the account layer, the auth middleware), over ``published``."""
    import ai.modules.shell.public_pages as pp
    import ai.modules.shell.shell as shell_mod
    from ai import eaas
    from ai.web import WebServer

    (tmp_path / 'index.html').write_text(f'<html><head><title>shell</title></head><body>{SHELL_BODY}</body></html>')
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path))
    monkeypatch.setattr(eaas, '_require_writable_task_data', lambda *a, **k: None)
    manifests = list(published)

    async def load(acct: Any = None, strict: bool = False, exclude: str = '', unreadable: Any = None) -> list:
        return manifests

    monkeypatch.setattr(pp, 'load_published', load)
    built = {}

    async def capture(self: Any) -> None:
        built['server'] = self

    monkeypatch.setattr(WebServer, 'serve', capture)
    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(eaas.run({'port': 0, 'host': '127.0.0.1'}))
    finally:
        close_bounded(loop)
    return built['server']
