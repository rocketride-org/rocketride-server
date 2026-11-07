"""The request log must not carry credentials from the request target."""

import base64
import copy
import importlib.util
import logging
import logging.config
import os
import pathlib
import socket
import threading
import time

import pytest

from ai.web.access_log import (
    HTTP_ACCESS_TEMPLATE,
    REDACTED,
    SENSITIVE_QUERY_PARAMS,
    UVICORN_LOGGERS,
    WEBSOCKET_TEMPLATE_PREFIX,
    RequestTargetRedactor,
    install_access_log_redaction,
    redact_request_target,
    request_target_index,
)

# uvicorn's LOGGING_CONFIG configures these three loggers (handlers, levels, propagate).
_LOGGERS_TOUCHED_BY_UVICORN = ('uvicorn', *UVICORN_LOGGERS)


@pytest.fixture(autouse=True)
def restore_uvicorn_logging():
    """Snapshot and restore the uvicorn loggers around every test.

    The tests below install a process-global filter and some run uvicorn's dictConfig; without this,
    handlers and filters would leak into neighbouring tests and make them order-dependent.
    """
    saved = {}
    for name in _LOGGERS_TOUCHED_BY_UVICORN:
        logger = logging.getLogger(name)
        saved[name] = (list(logger.handlers), list(logger.filters), logger.level, logger.propagate, logger.disabled)
    yield
    for name, (handlers, filters, level, propagate, disabled) in saved.items():
        logger = logging.getLogger(name)
        logger.handlers[:] = handlers
        logger.filters[:] = filters
        logger.setLevel(level)
        logger.propagate = propagate
        logger.disabled = disabled


def _remove_redactors():
    for name in UVICORN_LOGGERS:
        logger = logging.getLogger(name)
        for f in list(logger.filters):
            if isinstance(f, RequestTargetRedactor):
                logger.removeFilter(f)


def _record(name, msg, args):
    return logging.LogRecord(name, logging.INFO, 'x', 1, msg, args, None)


ORIGIN_FORM_ARGS = ('127.0.0.1:1', 'GET', '/oauth/callback?code=SECRET&state=ST', '1.1', 302)
ABSOLUTE_FORM_ARGS = ('127.0.0.1:1', 'GET', 'http%3A//localhost/oauth/callback?code=SECRET&state=ST', '1.1', 200)
PATH_TOKEN_ARGS = ('127.0.0.1:1', 'GET', '/task/fetch/SECRET/remoteEntry.js', '1.1', 200)
WEBSOCKET_TEMPLATES = (
    ('%s - "WebSocket %s" [accepted]', ('127.0.0.1:1', '/ws?auth=SECRET')),
    ('%s - "WebSocket %s" 403', ('127.0.0.1:1', '/ws?auth=SECRET')),
    ('%s - "WebSocket %s" %d', ('127.0.0.1:1', '/ws?auth=SECRET', 403)),
)


class TestRedactRequestTarget:
    @pytest.mark.parametrize(
        'target,expected',
        [
            # Query values
            ('/oauth/callback?code=SECRET&state=ST&x=1', '/oauth/callback?code=[redacted]&state=[redacted]&x=1'),
            (
                'http%3A//localhost/oauth/callback?code=SECRET&state=ST',
                'http%3A//localhost/oauth/callback?code=[redacted]&state=[redacted]',
            ),
            ('/mcp/?auth=SECRET', '/mcp/?auth=[redacted]'),
            ('/task/fetch?token=eyJ.abc.def', '/task/fetch?token=[redacted]'),
            (
                '/auth/vscode/google?tokens=%7B%22access_token%22%3A%22x%22%7D&state=s&scheme=vscode',
                '/auth/vscode/google?tokens=[redacted]&state=[redacted]&scheme=vscode',
            ),
            ('/cb?CODE=abc&Code=def', '/cb?CODE=[redacted]&Code=[redacted]'),
            ('/cb?%63ode=abc', '/cb?%63ode=[redacted]'),
            ('/cb?code=', '/cb?code=[redacted]'),
            ('/cb?code=a%26b=c', '/cb?code=[redacted]'),
            # Left alone
            ('/cb?code&x=1', '/cb?code&x=1'),
            ('/cb?a=1&&b=2', '/cb?a=1&&b=2'),
            ('/p?q=code', '/p?q=code'),
            ('/plain/path', '/plain/path'),
            ('/empty?', '/empty?'),
            ('*', '*'),
            # Path token, origin and absolute form
            ('/task/fetch/eyJ.abc.def/remoteEntry.js', '/task/fetch/[redacted]/remoteEntry.js'),
            ('/task/fetch/eyJ.abc.def/static/js/async/1.js', '/task/fetch/[redacted]/static/js/async/1.js'),
            (
                'http%3A//localhost:5565/task/fetch/eyJ.abc.def/remoteEntry.js',
                'http%3A//localhost:5565/task/fetch/[redacted]/remoteEntry.js',
            ),
            ('//task/fetch/eyJ.abc.def/x', '//task/fetch/[redacted]/x'),
            ('/task/fetch/eyJ.abc.def', '/task/fetch/[redacted]'),
            ('/task/fetch/eyJ.abc.def/x?token=t&a=1', '/task/fetch/[redacted]/x?token=[redacted]&a=1'),
            # Not a path token
            ('/task/fetch', '/task/fetch'),
            ('/task/fetch/', '/task/fetch/'),
            ('/task/fetching/abc/x', '/task/fetching/abc/x'),
            ('/other/fetch/abc/x', '/other/fetch/abc/x'),
        ],
    )
    def test_table(self, target, expected):
        assert redact_request_target(target) == expected

    @pytest.mark.parametrize('name', sorted(SENSITIVE_QUERY_PARAMS))
    def test_every_sensitive_name_is_redacted_in_order(self, name):
        assert redact_request_target(f'/x?a=1&{name}=SECRET&b=2') == f'/x?a=1&{name}={REDACTED}&b=2'


class TestRequestTargetIndex:
    def test_http_access_record_has_target_at_index_2(self):
        assert request_target_index(_record('uvicorn.access', HTTP_ACCESS_TEMPLATE, ORIGIN_FORM_ARGS)) == 2

    @pytest.mark.parametrize('msg,args', WEBSOCKET_TEMPLATES)
    def test_websocket_records_have_target_at_index_1(self, msg, args):
        assert request_target_index(_record('uvicorn.error', msg, args)) == 1

    def test_http_template_with_wrong_arity_is_not_matched(self):
        assert request_target_index(_record('uvicorn.access', HTTP_ACCESS_TEMPLATE, ORIGIN_FORM_ARGS[:4])) is None

    @pytest.mark.parametrize(
        'msg,args',
        [
            ('Uvicorn running on %s://%s:%d', ('http', '127.0.0.1', 5565)),
            ('Application startup complete.', None),
            ('%(a)s', ({'a': '/x?code=1'},)),
        ],
    )
    def test_unrelated_records_are_not_matched(self, msg, args):
        assert request_target_index(_record('uvicorn.error', msg, args)) is None


class TestFilterOnRecords:
    def test_http_access_record_redacts_only_the_target(self):
        record = _record('uvicorn.access', HTTP_ACCESS_TEMPLATE, ORIGIN_FORM_ARGS)
        assert RequestTargetRedactor().filter(record) is True
        assert record.args[2] == '/oauth/callback?code=[redacted]&state=[redacted]'
        assert (record.args[0], record.args[1], record.args[3], record.args[4]) == ('127.0.0.1:1', 'GET', '1.1', 302)

    def test_http_access_record_with_absolute_form_target_is_redacted(self):
        record = _record('uvicorn.access', HTTP_ACCESS_TEMPLATE, ABSOLUTE_FORM_ARGS)
        RequestTargetRedactor().filter(record)
        assert record.args[2] == 'http%3A//localhost/oauth/callback?code=[redacted]&state=[redacted]'
        assert 'code=[redacted]' in record.getMessage() and 'SECRET' not in record.getMessage()

    def test_http_access_record_with_path_token_is_redacted(self):
        record = _record('uvicorn.access', HTTP_ACCESS_TEMPLATE, PATH_TOKEN_ARGS)
        RequestTargetRedactor().filter(record)
        assert record.args[2] == '/task/fetch/[redacted]/remoteEntry.js'
        assert 'SECRET' not in record.getMessage()

    @pytest.mark.parametrize('msg,args', WEBSOCKET_TEMPLATES)
    def test_websocket_records(self, msg, args):
        record = _record('uvicorn.error', msg, args)
        RequestTargetRedactor().filter(record)
        assert record.args[1] == '/ws?auth=[redacted]'
        assert record.args[2:] == args[2:]
        assert 'SECRET' not in record.getMessage()

    def test_websocket_record_with_path_token_is_redacted(self):
        record = _record('uvicorn.error', '%s - "WebSocket %s" 403', ('127.0.0.1:1', '/task/fetch/SECRET/x'))
        RequestTargetRedactor().filter(record)
        assert record.args[1] == '/task/fetch/[redacted]/x'

    def test_unrelated_uvicorn_error_record_is_untouched(self):
        args = ('http', '127.0.0.1', 5565)
        record = _record('uvicorn.error', 'Uvicorn running on %s://%s:%d', args)
        assert RequestTargetRedactor().filter(record) is True
        assert record.args == args

    def test_http_template_with_wrong_arity_is_untouched(self):
        args = ('127.0.0.1:1', 'GET', '/x?code=1', '1.1')
        record = _record('uvicorn.access', HTTP_ACCESS_TEMPLATE, args)
        RequestTargetRedactor().filter(record)
        assert record.args == args

    def test_dict_args_are_left_alone(self):
        record = _record('uvicorn.access', '%(a)s', ({'a': '/x?code=1'},))
        RequestTargetRedactor().filter(record)
        assert record.args == {'a': '/x?code=1'}

    def test_rendered_message_has_no_secret(self):
        record = _record('uvicorn.access', HTTP_ACCESS_TEMPLATE, ORIGIN_FORM_ARGS)
        RequestTargetRedactor().filter(record)
        line = record.getMessage()
        assert 'code=[redacted]' in line and 'GET' in line and '/oauth/callback' in line and '302' in line
        assert 'SECRET' not in line

    def test_install_is_idempotent(self):
        _remove_redactors()
        install_access_log_redaction()
        install_access_log_redaction()
        for name in UVICORN_LOGGERS:
            redactors = [f for f in logging.getLogger(name).filters if isinstance(f, RequestTargetRedactor)]
            assert len(redactors) == 1, name

    def test_filter_survives_uvicorn_dict_config(self):
        uvicorn = pytest.importorskip('uvicorn')
        install_access_log_redaction()
        logging.config.dictConfig(copy.deepcopy(uvicorn.config.LOGGING_CONFIG))
        for name in UVICORN_LOGGERS:
            assert any(isinstance(f, RequestTargetRedactor) for f in logging.getLogger(name).filters), name

    @pytest.mark.parametrize(
        'args,status,target',
        [
            (ORIGIN_FORM_ARGS, '302 Found', 'code=[redacted]'),
            (ABSOLUTE_FORM_ARGS, '200 OK', 'code=[redacted]'),
            (PATH_TOKEN_ARGS, '200 OK', '/task/fetch/[redacted]/remoteEntry.js'),
        ],
    )
    def test_stock_access_formatter_renders_redacted_line(self, args, status, target):
        uvicorn = pytest.importorskip('uvicorn')
        from uvicorn.logging import AccessFormatter

        record = _record('uvicorn.access', HTTP_ACCESS_TEMPLATE, args)
        RequestTargetRedactor().filter(record)
        fmt = AccessFormatter(fmt=uvicorn.config.LOGGING_CONFIG['formatters']['access']['fmt'], use_colors=False)
        rendered = fmt.format(record)
        assert target in rendered and status in rendered and 'SECRET' not in rendered, rendered

    def test_templates_match_the_installed_uvicorn_source(self):
        """Every backend that logs a request target must use a template the filter recognises.

        A uvicorn bump that changes a template, or adds a backend with a new one, fails here.
        """
        uvicorn = pytest.importorskip('uvicorn')
        protocols = pathlib.Path(uvicorn.__file__).parent / 'protocols'
        checked = set()
        for source in protocols.rglob('*_impl.py'):
            text = source.read_text(encoding='utf-8')
            if 'get_path_with_query_string(' not in text:
                continue
            template = HTTP_ACCESS_TEMPLATE if source.parent.name == 'http' else WEBSOCKET_TEMPLATE_PREFIX
            assert template in text, source
            checked.add(source.name)
        assert {'h11_impl.py', 'httptools_impl.py', 'websockets_impl.py', 'wsproto_impl.py'} <= checked


def _optional_backend(name, module):
    return pytest.param(
        name,
        id=name,
        marks=pytest.mark.skipif(importlib.util.find_spec(module) is None, reason=f'{module} not installed'),
    )


class _Collect(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


class _LiveServer:
    """A real uvicorn server on a loopback socket, with the redactor installed as WebServer does it."""

    def __init__(self, uvicorn, app, logger, **config):
        self.sock = socket.socket()
        self.sock.bind(('127.0.0.1', 0))
        # loop='asyncio' keeps uvloop out of the test thread; lifespan='off' because the bare app has no
        # lifespan handler.
        self.server = uvicorn.Server(uvicorn.Config(app, log_level='info', lifespan='off', loop='asyncio', **config))
        install_access_log_redaction()
        # After Config: its dictConfig replaces the handlers of the uvicorn loggers.
        self.collector = _Collect()
        logging.getLogger(logger).addHandler(self.collector)
        self.thread = threading.Thread(target=self.server.run, kwargs={'sockets': [self.sock]}, daemon=True)

    def __enter__(self):
        self.thread.start()
        deadline = time.monotonic() + 10
        while not self.server.started and time.monotonic() < deadline:
            time.sleep(0.02)
        assert self.server.started
        return self

    def __exit__(self, *exc):
        self.server.should_exit = True
        self.thread.join(timeout=10)
        self.sock.close()

    def request(self, payload):
        with socket.create_connection(self.sock.getsockname(), timeout=5) as conn:
            conn.sendall(payload.encode())
            while conn.recv(4096):
                pass

    def websocket_handshake(self, target):
        """Send an upgrade request, read the first reply, and drop the connection."""
        nonce = base64.b64encode(os.urandom(16)).decode()
        with socket.create_connection(self.sock.getsockname(), timeout=5) as conn:
            conn.sendall(
                f'GET {target} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
                f'Sec-WebSocket-Key: {nonce}\r\nSec-WebSocket-Version: 13\r\n\r\n'.encode()
            )
            assert conn.recv(4096)


class TestLiveUvicorn:
    @pytest.mark.parametrize('http', [pytest.param('h11', id='h11'), _optional_backend('httptools', 'httptools')])
    def test_access_lines_hide_credentials_in_every_target_form(self, http):
        uvicorn = pytest.importorskip('uvicorn')
        from uvicorn.logging import AccessFormatter

        seen = []

        async def app(scope, receive, send):
            seen.append((scope['path'], scope['query_string']))
            await send({'type': 'http.response.start', 'status': 200, 'headers': [(b'content-length', b'2')]})
            await send({'type': 'http.response.body', 'body': b'ok'})

        # http= pins the backend under test: 'auto' picks httptools when installed and would never
        # exercise h11's absolute-form behaviour.
        with _LiveServer(uvicorn, app, 'uvicorn.access', http=http) as live:
            for target in (
                '/oauth/callback?code=SECRET&state=ST&x=1',
                'http://localhost/oauth/callback?code=SECRET&state=ST&x=1',
                '/task/fetch/SECRET/remoteEntry.js',
                'http://localhost/task/fetch/SECRET/remoteEntry.js',
            ):
                live.request(f'GET {target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')

        # The app saw the real values every time.
        assert [query for _path, query in seen] == [b'code=SECRET&state=ST&x=1'] * 2 + [b''] * 2
        assert all('SECRET' in path for path, _query in seen[2:])

        records = live.collector.records
        lines = [r.getMessage() for r in records]
        assert len(lines) == 4, lines
        fmt = AccessFormatter(fmt=uvicorn.config.LOGGING_CONFIG['formatters']['access']['fmt'], use_colors=False)
        for record, line in zip(records, lines):
            assert 'SECRET' not in line and 'state=ST' not in line, line
            assert ' 200' in line, line
            rendered = fmt.format(record)
            assert 'SECRET' not in rendered and '200 OK' in rendered, rendered
        assert all('code=[redacted]&state=[redacted]&x=1' in line for line in lines[:2]), lines
        assert all('/task/fetch/[redacted]/remoteEntry.js' in line for line in lines[2:]), lines

    @pytest.mark.parametrize(
        'ws',
        [
            _optional_backend('websockets', 'websockets'),
            _optional_backend('websockets-sansio', 'websockets'),
            _optional_backend('wsproto', 'wsproto'),
        ],
    )
    def test_websocket_lines_hide_credentials(self, ws):
        uvicorn = pytest.importorskip('uvicorn')

        seen = []

        async def app(scope, receive, send):
            seen.append(scope['query_string'])
            await receive()  # websocket.connect
            if scope['path'] == '/accept':
                await send({'type': 'websocket.accept'})
            await send({'type': 'websocket.close'})  # before the accept, this is a 403

        with _LiveServer(uvicorn, app, 'uvicorn.error', http='h11', ws=ws) as live:
            for path in ('/accept', '/reject'):
                live.websocket_handshake(f'{path}?auth=SECRET&x=1')

        assert seen == [b'auth=SECRET&x=1'] * 2  # the app saw the real value both times
        lines = [r.getMessage() for r in live.collector.records if 'WebSocket' in r.getMessage()]
        assert any('/accept?auth=[redacted]&x=1" [accepted]' in line for line in lines), lines
        assert any('/reject?auth=[redacted]&x=1" 403' in line for line in lines), lines
        assert not any('SECRET' in line for line in lines), lines
