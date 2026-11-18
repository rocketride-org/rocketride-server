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

"""
The e2e server: the engine's Python web stack, a fixture app, and test routes.

Runs ``ai.eaas`` (the EaaS server: the shell, the app host, the DAP task
service, the OSS account and its file store) in a plain interpreter, with the
engine's native modules stubbed (``native_stubs``). It is what the Playwright
suite drives; it is not a mock of the isolation code, which is the real code.

What it adds, for tests only:
  - the fixture app, written into the account's registry and store the way the
    seeder does it, but as a third-party app (``platform: False``) from a
    prebuilt dist, and bound to an audience (public or the local team);
  - named users: ``E2E_USERS`` maps an API key to a user id, so two users can
    sign in (OSS has one);
  - ``/__e2e/*`` routes on the shell origin: ``info``, ``commands`` (every DAP
    request the engine received), ``evil`` and ``hits`` (a navigation target the
    exploits aim at) and ``seed`` (another version of the fixture).

Environment (all read once at start):
  E2E_PORT, E2E_FIXTURE_DIST (the built fixture), E2E_STORE (store directory),
  E2E_USERS (JSON ``{"<key>": {"userId": "...", "displayName": "..."}}``),
  E2E_AUDIENCE (``public`` or ``team``), E2E_ENGINE_DIR (the ``dist/server``
  tree holding ``static/shell`` and ``static/shell-guest``), E2E_RUN_DIR (scratch),
  E2E_HOME_DIST (the built home app), plus the engine's
  own RR_APP_* isolation variables and ROCKETRIDE_APIKEY.
"""

import asyncio
import json
import os
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import native_stubs  # noqa: E402

native_stubs.install()

REPO = HERE.parents[3]
SOURCE_DIR = Path(os.environ.get('E2E_ENGINE_DIR') or (REPO / 'dist' / 'server'))
RUN_DIR = Path(os.environ.get('E2E_RUN_DIR') or (HERE.parent / '.run'))


def _assemble_engine_dir() -> Path:
    """
    A private engine directory: the built shell and guest, plus a home app.

    The engine finds its static tree next to its executable. The run directory
    links the real ``static/shell`` and ``static/shell-guest`` (read only) and
    adds ``apps.json`` with a platform home app (``rocketride.hello``, built from
    the fixture source with ``E2E_BUILD=home``), so the shell opens with its own
    chrome and the suite can log out through it.
    """
    engine = RUN_DIR / f'engine-{os.getpid()}'
    static = engine / 'static'
    static.mkdir(parents=True, exist_ok=True)
    for name in ('shell', 'shell-guest'):
        link = static / name
        if not link.exists():
            link.symlink_to(SOURCE_DIR / 'static' / name)
    home = Path(os.environ.get('E2E_HOME_DIST') or (HERE.parent / '.build' / 'home-app'))
    if home.is_dir():
        bundle = static / 'apps' / 'rocketride.hello'
        if not bundle.exists():
            shutil.copytree(home, bundle)
        (static / 'apps.json').write_text(
            json.dumps(
                {
                    'apps': [
                        {
                            'id': 'rocketride.hello',
                            'moduleId': 'e2e_home',
                            'name': 'RocketRide',
                            'version': '1.0.0',
                            'publisher': 'RocketRide',
                            'description': 'The home app of the e2e server',
                            'mode': 'free',
                            'authenticated': False,
                            'shells': ['oss'],
                        }
                    ]
                }
            )
        )
    return engine


ENGINE_DIR = _assemble_engine_dir()
# The engine finds its static tree next to its executable.
sys.executable = str(ENGINE_DIR / 'python')

if os.environ.get('E2E_STORE'):
    os.environ['RR_STORE_URL'] = 'filesystem://' + os.environ['E2E_STORE']

COMMANDS: list = []
HITS: list = []
FIXTURE_ID = 'e2e.fixture'
ACTOR = {'userId': None, 'display': 'E2E', 'email': ''}


def _audience(name: str) -> dict:
    return {'type': 'public', 'id': ''} if name == 'public' else {'type': 'team', 'id': 'local'}


async def seed_version(dist: Path, audience: str, stamp: int, app_id: str = FIXTURE_ID) -> int:
    """Register one more version of the fixture (a third-party app) and bind ``audience`` to it."""
    from ai.account import account
    from ai.account.app_deploy import manifest_snapshot
    from ai.account.deployment_backend import artifact_content_dir
    from ai.account.store import Store

    manifest = {
        'id': app_id,
        'moduleId': 'e2e_fixture',
        'name': 'E2E Fixture',
        'publisher': 'E2E',
        'description': 'The hostile app of the isolation e2e suite',
        'mode': 'free',
        'authenticated': audience != 'public',
        'version': f'1.0.{stamp}',
    }
    artifact = {
        'kind': 'app',
        'appId': app_id,
        'moduleId': 'e2e_fixture',
        'name': 'E2E Fixture',
        'appVersion': manifest['version'],
    }
    build = {'status': 'ok', 'endedAt': time.time()}
    registered = await account.deployments_publish(
        'local',
        app_id,
        artifact,
        ACTOR,
        comment='e2e fixture',
        metadata={'manifest': manifest, 'build': build, 'platform': False},
        state='ready',
    )
    version = int(registered['version'])
    store = Store.instance()._store
    dest = f'{artifact_content_dir(str(registered["artifactPath"]))}/dist'
    for path in sorted(dist.rglob('*')):
        if path.is_file():
            await store.write_bytes(f'{dest}/{path.relative_to(dist).as_posix()}', path.read_bytes())
    # Each version says which build it is: the version-change spec reads it.
    await store.write_bytes(f'{dest}/version.json', json.dumps({'stamp': stamp, 'version': version}).encode())
    # What an admin approves for a store app: files in its own folder and running pipelines.
    await account.set_approved_capabilities('local', app_id, version, ['pipelines.run', 'fs.app'], ACTOR)
    await account.publish_set(
        'local', 'app', app_id, _audience(audience), version, manifest_snapshot(registered, artifact), ACTOR
    )
    # What every deploy event does: drop the serving verdicts cached for the app.
    from ai.modules.shell.shell import invalidate_app_serving

    invalidate_app_serving(app_id)
    return version


def _install_users() -> None:
    """Named users: an API key in ``E2E_USERS`` signs in as that user (everything else is the OSS rule)."""
    users = json.loads(os.environ.get('E2E_USERS') or '{}')
    if not users:
        return
    from ai.account import account

    original = account.authenticate

    async def authenticate(credential: str):
        user = users.get(credential)
        if user is None:
            return await original(credential)
        info = await original(os.environ.get('ROCKETRIDE_APIKEY', '') or credential)
        if isinstance(info, tuple):
            return info
        data = info.model_dump() if hasattr(info, 'model_dump') else dict(info)
        data.update(
            auth=credential,
            userToken=credential,
            userId=user['userId'],
            displayName=user.get('displayName', user['userId']),
        )
        return type(info)(**data)

    account.authenticate = authenticate


def _install_recorder() -> None:
    """Record every DAP request an authenticated connection sends (``/__e2e/commands``)."""
    from ai.modules.task.task_conn import TaskConn

    original = TaskConn.on_receive

    async def on_receive(self, message=None):
        try:
            if isinstance(message, dict) and message.get('type') == 'request':
                arguments = message.get('arguments') if isinstance(message.get('arguments'), dict) else {}
                info = getattr(self, '_account_info', None)
                COMMANDS.append(
                    {
                        't': time.time(),
                        'command': message.get('command'),
                        'subcommand': arguments.get('subcommand'),
                        'user': getattr(info, 'userId', None),
                        'credential': bool(arguments.get('auth')),
                        'authenticated': bool(getattr(self, '_authenticated', False)),
                    }
                )
        except Exception:
            pass
        return await original(self, message)

    TaskConn.on_receive = on_receive


def _install_routes(server, dist: Path, audience: str) -> None:
    from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse

    from ai.web import Request

    from ai.modules.shell.app_origin import current_config, label_of

    async def info(request: Request):
        config = current_config()
        return JSONResponse(
            {
                'mode': config.mode,
                'template': config.origin_template,
                'fixtureId': FIXTURE_ID,
                'label': label_of(FIXTURE_ID),
                'audience': audience,
            }
        )

    async def commands(request: Request):
        return JSONResponse(COMMANDS)

    async def clear(request: Request):
        COMMANDS.clear()
        HITS.clear()
        return JSONResponse({'ok': True})

    async def evil(request: Request):
        HITS.append({'t': time.time(), 'path': str(request.url.path), 'host': request.headers.get('host')})
        return PlainTextResponse('evil')

    async def hits(request: Request):
        return JSONResponse(HITS)

    async def blank(request: Request):
        return HTMLResponse('<!doctype html><title>e2e</title>')

    async def opener_nav(request: Request):
        # The X8 popup: a page on the shell origin that tries to steer the opener's top window.
        return HTMLResponse(
            '<!doctype html><title>x8</title><script>'
            'try{opener.top.location.href=new URLSearchParams(location.search).get("to")||"/__e2e/evil"}'
            'catch(e){document.title="blocked"}</script>'
        )

    def _task():
        return server.app.state.task

    async def seed(request: Request):
        body = await request.json()
        version = await seed_version(
            dist, str(body.get('audience') or audience), int(body.get('stamp') or int(time.time()))
        )
        from ai.account.manifest_push import push_refresh

        users = {
            getattr(getattr(c, '_account_info', None), 'userId', None) for c in list(_task()._connections.values())
        }
        for user in [u for u in users if u]:
            await push_refresh(_task(), user, 'e2e-seed')
        return JSONResponse({'version': version})

    async def org_change(request: Request):
        # The server tells every connection the user's default org changed (what the rescope listens for).
        sent = 0
        for conn in list(_task()._connections.values()):
            if getattr(conn, '_account_info', None) is not None:
                await conn.send_event('apaext_org_changed', body={'orgId': 'e2e-other-org'})
                sent += 1
        return JSONResponse({'sent': sent, 't': time.time()})

    for path, handler, methods in (
        ('/__e2e/info', info, ['GET']),
        ('/__e2e/commands', commands, ['GET']),
        ('/__e2e/clear', clear, ['POST']),
        ('/__e2e/evil', evil, ['GET']),
        ('/__e2e/hits', hits, ['GET']),
        ('/__e2e/seed', seed, ['POST']),
        ('/__e2e/blank', blank, ['GET']),
        ('/__e2e/opener-nav', opener_nav, ['GET']),
        ('/__e2e/org-change', org_change, ['POST']),
    ):
        server.add_route(path=path, routeHandler=handler, methods=methods, public=True)


async def run() -> None:
    from ai.web import WebServer

    port = int(os.environ['E2E_PORT'])
    dist = Path(os.environ['E2E_FIXTURE_DIST'])
    audience = os.environ.get('E2E_AUDIENCE') or 'team'

    server = WebServer(config={'host': 'localhost', 'port': port}, standardEndpoints=False)
    for name in ('services', 'chat', 'dropper', 'clients', 'task', 'task_http', 'shell', 'mcp'):
        server.use(name)

    from ai.account import account

    await account.init_account(server)
    _install_users()
    _install_recorder()
    await seed_version(dist, audience, 1)
    _install_routes(server, dist, audience)
    await server.serve()


if __name__ == '__main__':
    sys.argv = ['serve']
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
