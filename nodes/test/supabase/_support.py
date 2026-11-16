# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Shared test support for the Supabase services (no engine, no network).

Usage in a service test (``nodes/test/supabase/<service>/test_<service>.py``)::

    from .._support import engine_stubs, make_global, make_instance, FakeSupabaseClient, API_CFG

    with engine_stubs():
        from nodes.supabase.auth.IGlobal import IGlobal
        from nodes.supabase.auth.IInstance import IInstance


    def test_get_user():
        client = FakeSupabaseClient({'auth.admin.get_user_by_id': SimpleNamespace(user={...})})
        inst = make_instance(IInstance, make_global(IGlobal, API_CFG, client=client))
        assert inst.get_user({'user_id': 'u1'})['id'] == 'u1'
        assert client.calls[-1] == ('auth.admin.get_user_by_id', ('u1',), {})

``engine_stubs()`` installs FRESH stubs for rocketlib / depends / ai.* only for
the duration of the import and restores ``sys.modules`` afterwards, so nothing
leaks to sibling tests (the guard in ``_sys_modules_guard.py`` checks this).
``ai.common.utils`` carries the REAL validators (``tool_args.py`` and
``config_utils.py`` executed from packages/ai), and ``ai.common.config`` the
REAL ``check_credential_resolved``, so messages match runtime.
``rocketlib.IInstanceBase`` carries the REAL tool dispatch (``invoke``,
``_dispatch_tool``, ``_collect_tool_methods`` ... compiled from
rocketlib/filters.py), and ``tool_function`` / ``invoke_function`` are filters.py's own, so ``tool_query`` / ``tool_invoke`` below drive what
the engine runs for ``tool.query`` / ``tool.invoke``.
The imported ``nodes.supabase.*`` modules stay cached and keep the stubs they
were imported with.
"""

from __future__ import annotations

import contextlib
import importlib
import importlib.util
import inspect
import json
import re
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, Iterator, List, Mapping, Optional, Tuple

_REPO = Path(__file__).resolve().parents[3]
NODES_SRC = _REPO / 'nodes' / 'src'
NODE_DIR = NODES_SRC / 'nodes' / 'supabase'
CORE_DIR = NODES_SRC / 'nodes' / 'core'
_AI_COMMON = _REPO / 'packages' / 'ai' / 'src' / 'ai' / 'common'
_AI_UTILS = _AI_COMMON / 'utils'

if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))

# -----------------------------------------------------------------------------
# Fake settings. Obviously fake values: never put a real key in a test.
# -----------------------------------------------------------------------------

FAKE_SECRET_KEY = 'sb_secret_TESTONLY_not_a_real_key_0123456789'
FAKE_DB_PASSWORD = 'test-only-db-password-#@!'
FAKE_REF = 'abcdefghijklmnopqrst'

API_CFG: Dict[str, Any] = {
    'authType': 'key',
    'url': f'https://{FAKE_REF}.supabase.co',
    'secretKey': FAKE_SECRET_KEY,
    'access': 'read',
}

PG_CFG: Dict[str, Any] = {
    'host': 'aws-0-eu-west-1.pooler.supabase.com:5432',
    'user': f'postgres.{FAKE_REF}',
    'password': FAKE_DB_PASSWORD,
    'database': 'postgres',
    'access': 'read',
}


def cfg_with(base: Mapping[str, Any], **overrides: Any) -> Dict[str, Any]:
    """Copy of a config with overrides (``access='write'`` etc.)."""
    out = dict(base)
    out.update(overrides)
    return out


# -----------------------------------------------------------------------------
# Engine stubs
# -----------------------------------------------------------------------------

#: Every rocketlib debug/info/warning/error call made by stubbed modules: (level, message).
LOGS: List[Tuple[str, str]] = []

_STUBBED = ('rocketlib', 'depends', 'ai', 'ai.common', 'ai.common.utils', 'ai.common.config')


def _logger(level: str):
    def log(message: Any = '', *args: Any, **kwargs: Any) -> None:
        LOGS.append((level, str(message)))

    return log


class _Ec:
    """The engine error codes the real tool dispatch raises (rocketlib.error.Ec wraps engLib's)."""

    NoErr = 'Ec.NoErr'
    InvalidParam = 'Ec.InvalidParam'
    PreventDefault = 'Ec.PreventDefault'


class _APERR(Exception):
    """Same shape as rocketlib.error.APERR: ``.ec`` and ``.msg``."""

    def __init__(self, ec: str = _Ec.NoErr, msg: str = '') -> None:
        self.ec = ec
        self.msg = msg
        super().__init__(f'Error {ec}: {msg}')


_FILTERS = _REPO / 'packages' / 'server' / 'engine-lib' / 'rocketlib-python' / 'lib' / 'rocketlib' / 'filters.py'

# The IInstanceBase methods that build tool.query and dispatch tool.invoke,
# plus the lifecycle no-ops a node may call through super().
_REAL_INSTANCE_METHODS = (
    'invoke',
    'preventDefault',
    '_collect_invoke_methods',
    '_collect_tool_methods',
    '_build_tool_descriptors',
    '_dispatch_tool',
    '_tool_query_dynamic',
    '_tool_invoke_dynamic',
    '_tool_config_description',
    '_get_op',
    '_get_param_field',
    '_set_param_field',
    'beginInstance',
    'endInstance',
)


# The module-level decorators taken from filters.py as they are.
_REAL_DECORATORS = ('tool_function', 'invoke_function')


def _real_filters() -> Dict[str, Any]:
    """``tool_function``, ``invoke_function`` and IInstanceBase's tool dispatch, compiled from rocketlib/filters.py.

    filters.py imports engLib at the top, so the file cannot be imported here.
    It is parsed instead and only the decorators and the IInstanceBase methods
    above are kept, so the decorators that stamp a tool and ``tool.query`` /
    ``tool.invoke`` in the tests run the engine's own code (``_dispatch_tool``
    calling ``self._collect_tool_methods()``), not a copy. The media-lane
    wrapping (``__init_subclass__``) and the lane handlers are left out: the
    Supabase tool services have no lanes.
    """
    import __future__

    import ast

    tree = ast.parse(_FILTERS.read_text(encoding='utf-8'), filename=str(_FILTERS))
    decorators = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in _REAL_DECORATORS]
    if {node.name for node in decorators} != set(_REAL_DECORATORS):
        raise AssertionError(f'rocketlib/filters.py no longer defines {list(_REAL_DECORATORS)}; update _support.py')
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'IInstanceBase')
    kept = [node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name in _REAL_INSTANCE_METHODS]
    missing = set(_REAL_INSTANCE_METHODS) - {node.name for node in kept}
    if missing:
        raise AssertionError(f'rocketlib/filters.py IInstanceBase no longer has {sorted(missing)}; update _support.py')
    cls.body, cls.bases, cls.keywords, cls.decorator_list = kept, [], [], []
    module = ast.fix_missing_locations(ast.Module(body=[*decorators, cls], type_ignores=[]))
    namespace: Dict[str, Any] = {'__name__': 'rocketlib.filters', 'APERR': _APERR, 'Ec': _Ec}
    flags = __future__.annotations.compiler_flag  # filters.py's annotations stay unevaluated, as there
    exec(compile(module, str(_FILTERS), 'exec', flags=flags, dont_inherit=True), namespace)
    return namespace


def tool_query(inst: Any) -> List[Dict[str, Any]]:
    """What the engine's ``tool.query`` collects from this node (the real dispatch)."""
    param: Dict[str, Any] = {'op': 'tool.query', 'tools': []}
    try:
        inst.invoke(param)
    except _APERR as e:
        # Every tool node ends tool.query with PreventDefault so the engine asks the next one.
        if e.ec != _Ec.PreventDefault:
            raise
    return param['tools']


def tool_invoke(inst: Any, tool_name: str, payload: Any = None) -> Any:
    """Call a tool the way the engine's ``tool.invoke`` does; returns ``param['output']``.

    A tool the node does not offer raises ``rocketlib.APERR`` with ``Ec.PreventDefault``
    (the engine then tries the next node, and fails when none owns it).
    """
    param: Dict[str, Any] = {'op': 'tool.invoke', 'tool_name': tool_name, 'input': payload}
    inst.invoke(param)
    return param['output']


def is_prevent_default(error: BaseException) -> bool:
    """True for the engine's 'not mine, try the next node' answer."""
    return isinstance(error, _APERR) and error.ec == _Ec.PreventDefault


def _build_rocketlib() -> types.ModuleType:
    mod = types.ModuleType('rocketlib')
    mod.IGlobalBase = type('IGlobalBase', (), {})
    filters = _real_filters()
    mod.IInstanceBase = filters['IInstanceBase']
    mod.APERR = _APERR
    mod.Ec = _Ec
    mod.IEndpointBase = type('IEndpointBase', (), {})
    mod.tool_function = filters['tool_function']
    mod.invoke_function = filters['invoke_function']
    mod.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config', 'SOURCE': 'source', 'TARGET': 'target'})
    for level in ('debug', 'info', 'warning', 'error', 'monitorStatus'):
        setattr(mod, level, _logger(level))
    mod.isCancelled = lambda: False
    # Used by the real ai/common/config.py (check_credential_resolved).
    mod.getServiceDefinition = lambda logical_type: {}
    mod.IJson = type('IJson', (), {'toDict': staticmethod(lambda value: value)})
    return mod


def _exec_file(name: str, path: Path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


class _Config:
    """Stub; IGlobal._node_config is replaced by make_global, so this is only a fallback."""

    @staticmethod
    def getNodeConfig(logicalType: str, connConfig: Any) -> Dict[str, Any]:
        return dict(connConfig or {})


def _build_ai() -> Dict[str, types.ModuleType]:
    ai = types.ModuleType('ai')
    ai.__path__ = []
    common = types.ModuleType('ai.common')
    common.__path__ = []
    config = types.ModuleType('ai.common.config')
    config.Config = _Config
    # The REAL placeholder check (the rest of config.py needs the engine).
    real_config = _exec_file('_supabase_test_config', _AI_COMMON / 'config.py')
    config.check_credential_resolved = real_config.check_credential_resolved
    config.UnresolvedCredentialError = real_config.UnresolvedCredentialError
    utils = types.ModuleType('ai.common.utils')
    utils.__path__ = []
    tool_args = _exec_file('_supabase_test_tool_args', _AI_UTILS / 'tool_args.py')
    config_utils = _exec_file('_supabase_test_config_utils', _AI_UTILS / 'config_utils.py')
    for source in (tool_args, config_utils):
        for name in dir(source):
            if not name.startswith('_'):
                setattr(utils, name, getattr(source, name))
    ai.common = common
    common.config = config
    common.utils = utils
    return {'ai': ai, 'ai.common': common, 'ai.common.config': config, 'ai.common.utils': utils}


@contextlib.contextmanager
def engine_stubs(extra: Optional[Mapping[str, Any]] = None) -> Iterator[Dict[str, Any]]:
    """Install fresh engine stubs for an import block; restore sys.modules after.

    ``extra`` adds or overrides modules (e.g. ``{'ai.common.store': stub}`` for
    Vector, or ``{'ai.common.database': stub}`` for Database). Yields the stub
    dict so a test can reach e.g. ``stubs['rocketlib']``.
    """
    names = set(_STUBBED) | set(extra or {})
    saved = {name: sys.modules.get(name) for name in names}
    stubs: Dict[str, Any] = {'rocketlib': _build_rocketlib()}
    depends = types.ModuleType('depends')
    depends.depends = lambda *a, **k: None
    depends.load_depends = lambda *a, **k: None
    stubs['depends'] = depends
    try:
        # tool_args.py does `from rocketlib import warning` when it is executed.
        sys.modules['rocketlib'] = stubs['rocketlib']
        stubs.update(_build_ai())
        stubs.update(dict(extra or {}))
        for name, module in stubs.items():
            sys.modules[name] = module
        yield stubs
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


# -----------------------------------------------------------------------------
# Building globals / instances without the engine
# -----------------------------------------------------------------------------


def make_global(
    global_cls: type,
    cfg: Mapping[str, Any],
    *,
    client: Any = None,
    http: Any = None,
    open_mode: str = 'source',
    begin: bool = True,
) -> Any:
    """Instantiate an IGlobal, feed it ``cfg`` as the merged node config, and run beginGlobal.

    ``client`` replaces the supabase-py client (get_client), ``http`` the
    httpx client inside SupabaseApi (get_api). Requirements are not installed.
    """
    glb = global_cls()
    glb.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=open_mode))
    glb.glb = SimpleNamespace(logicalType='test', connConfig=dict(cfg))
    glb._node_config = lambda: dict(cfg)
    glb._load_requirements = lambda: None
    if begin:
        glb.beginGlobal()
        if client is not None:
            glb._client = client
        if http is not None:
            sc = sys.modules['nodes.supabase.supabase_client']
            glb._api = sc.SupabaseApi(glb.connection, timeout=glb.TIMEOUT, http_client=http)
    return glb


def make_instance(instance_cls: type, glb: Any) -> Any:
    """Instantiate an IInstance bound to ``glb``."""
    inst = instance_cls()
    inst.IGlobal = glb
    inst.IEndpoint = glb.IEndpoint
    inst.instance = SimpleNamespace()
    return inst


def tool_methods(cls: type) -> Dict[str, Any]:
    """Every @tool_function on ``cls`` (what the engine collects), by name."""
    return {name: getattr(cls, name) for name in dir(cls) if hasattr(getattr(cls, name, None), '__tool_meta__')}


def tool_levels(cls: type) -> Dict[str, Optional[str]]:
    """Tool name -> declared access level (None when a tool forgot @requires_access).

    Reads the level through the base's public ``tool_access_level``, from the
    module the service under test imported (the stubs are gone by now).
    """
    tool_access_level = sys.modules['nodes.supabase.IInstance'].tool_access_level
    return {name: tool_access_level(fn) for name, fn in tool_methods(cls).items()}


# -----------------------------------------------------------------------------
# Fakes
# -----------------------------------------------------------------------------


# Real supabase-py class behind each call-path prefix of FakeSupabaseClient.
# '' is the client itself; 'storage.from_' is what storage.from_(bucket) returns.
_SUPABASE_OWNERS = {
    '': ('supabase._sync.client', 'Client'),
    'auth': ('supabase._sync.auth_client', 'SyncSupabaseAuthClient'),
    'auth.admin': ('supabase_auth._sync.gotrue_admin_api', 'SyncGoTrueAdminAPI'),
    'storage': ('storage3._sync.client', 'SyncStorageClient'),
    'storage.from_': ('storage3._sync.client', 'SyncBucketProxy'),
    'schema': ('postgrest._sync.client', 'SyncPostgrestClient'),
    'schema.rpc': ('postgrest._sync.request_builder', 'SyncRPCFilterRequestBuilder'),
}


def check_supabase_signature(path: str, args: tuple, kwargs: dict) -> None:
    """Fail unless supabase-py's real method at ``path`` accepts these arguments.

    Keeps the fake honest: a wrong keyword (``delete_user(soft=...)``) or a
    method that does not exist fails here, as it would at runtime. Skipped
    only when supabase-py is not installed.
    """
    owner, _, name = path.rpartition('.')
    if owner not in _SUPABASE_OWNERS:
        raise AssertionError(
            f'FakeSupabaseClient: no supabase-py class known for {owner!r}; add it to _SUPABASE_OWNERS'
        )
    module_name, class_name = _SUPABASE_OWNERS[owner]
    try:
        module = importlib.import_module(module_name)
    except ImportError:
        return
    method = getattr(getattr(module, class_name), name, None)
    if not callable(method):
        raise AssertionError(f'supabase-py {class_name} has no method {name!r} (called as {path})')
    try:
        inspect.signature(method).bind(None, *args, **kwargs)
    except TypeError as e:
        raise AssertionError(f'supabase-py {class_name}.{name} does not accept these arguments: {e}') from None


class FakeSupabaseClient:
    """Records every call on any attribute chain and returns canned results.

    ``results`` maps a dotted call path to a value (or an Exception to raise,
    or a callable taking ``(*args, **kwargs)``). Arguments of intermediate
    calls are recorded but not part of the path::

        client.storage.from_('b').upload('p', b'x')
        -> calls: [('storage.from_', ('b',), {}), ('storage.from_.upload', ('p', b'x'), {})]
        -> returns results['storage.from_.upload']

    A call whose path is not in ``results`` returns another recorder, so any
    chain works (``client.schema('pgmq_public').rpc('send', {...}).execute()``).

    Every call is checked against the real supabase-py method signature
    (``check_supabase_signature``).
    """

    def __init__(self, results: Optional[Dict[str, Any]] = None) -> None:
        self.results: Dict[str, Any] = dict(results or {})
        self.calls: List[Tuple[str, tuple, dict]] = []

    def __getattr__(self, name: str) -> Any:
        if name.startswith('__'):
            raise AttributeError(name)
        return _Chain(self, name)

    def paths(self) -> List[str]:
        return [c[0] for c in self.calls]

    def calls_to(self, path: str) -> List[Tuple[tuple, dict]]:
        return [(a, k) for p, a, k in self.calls if p == path]


class _Chain:
    def __init__(self, root: FakeSupabaseClient, path: str) -> None:
        self._root = root
        self._path = path

    def __getattr__(self, name: str) -> Any:
        if name.startswith('__'):
            raise AttributeError(name)
        return _Chain(self._root, f'{self._path}.{name}')

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        check_supabase_signature(self._path, args, kwargs)
        self._root.calls.append((self._path, args, kwargs))
        if self._path in self._root.results:
            value = self._root.results[self._path]
            if isinstance(value, BaseException):
                raise value
            if isinstance(value, type) and issubclass(value, BaseException):
                raise value()
            if callable(value) and not isinstance(value, (SimpleNamespace, dict, list)):
                return value(*args, **kwargs)
            return value
        return _Chain(self._root, self._path)


class FakeResponse:
    """httpx.Response stand-in (status_code, headers, content)."""

    def __init__(self, status: int = 200, body: Any = None, headers: Optional[Dict[str, str]] = None) -> None:
        self.status_code = status
        self.headers = dict(headers or {})
        if body is None:
            self.content = b''
        elif isinstance(body, (bytes, bytearray)):
            self.content = bytes(body)
        elif isinstance(body, str):
            self.content = body.encode('utf-8')
            self.headers.setdefault('content-type', 'text/plain')
        else:
            self.content = json.dumps(body).encode('utf-8')
            self.headers.setdefault('content-type', 'application/json')
        if self.content:
            # As most servers send it; drop it in a test to model a chunked answer.
            self.headers.setdefault('content-length', str(len(self.content)))
        #: Bytes handed out by iter_bytes (a streamed read must stop early).
        self.bytes_streamed = 0

    def iter_bytes(self, chunk_size: int = 64 * 1024) -> Iterator[bytes]:
        for start in range(0, len(self.content), chunk_size):
            chunk = self.content[start : start + chunk_size]
            self.bytes_streamed += len(chunk)
            yield chunk


class FakeHttpClient:
    """httpx.Client stand-in for SupabaseApi.

    ``routes`` maps ``'METHOD /path'`` (path without the project URL) to a
    FakeResponse, an Exception to raise, or a callable(request) -> FakeResponse.
    Unknown routes answer 404. Every request is recorded in ``requests`` as a
    dict with method, url, path, headers, json, params, content, timeout.
    """

    def __init__(self, routes: Optional[Dict[str, Any]] = None, base_url: str = API_CFG['url']) -> None:
        self.routes: Dict[str, Any] = dict(routes or {})
        self.base_url = base_url
        self.requests: List[Dict[str, Any]] = []
        self.closed = False

    @contextlib.contextmanager
    def stream(self, method: str, url: str, **kwargs: Any) -> Iterator[FakeResponse]:
        """httpx.Client.stream: same routes, recorded with ``stream: True``."""
        yield self.request(method, url, stream=True, **kwargs)

    def request(self, method: str, url: str, **kwargs: Any) -> FakeResponse:
        path = url[len(self.base_url) :] if url.startswith(self.base_url) else url
        req = {'method': method, 'url': url, 'path': path, **kwargs}
        self.requests.append(req)
        route = self.routes.get(f'{method} {path}')
        if route is None:
            return FakeResponse(404, {'message': f'no fake route for {method} {path}'})
        if isinstance(route, BaseException):
            raise route
        if callable(route) and not isinstance(route, FakeResponse):
            return route(req)
        return route

    def close(self) -> None:
        self.closed = True


class FakeCursor:
    def __init__(self, conn: 'FakePgConnection') -> None:
        self._conn = conn
        self._rows: List[Any] = []
        self.description: Any = None
        self.rowcount = -1

    def execute(self, sql: str, params: Any = None) -> None:
        self._conn.executed.append((sql, params))
        for pattern, result in self._conn.results:
            if re.search(pattern, sql, re.IGNORECASE | re.DOTALL):
                if isinstance(result, BaseException):
                    raise result
                rows, columns = result if isinstance(result, tuple) else (result, None)
                self._rows = list(rows)
                self.description = [(c,) for c in columns] if columns else None
                self.rowcount = len(self._rows)
                return
        self._rows, self.description, self.rowcount = [], None, 0

    def fetchall(self) -> List[Any]:
        rows, self._rows = self._rows, []
        return rows

    def fetchone(self) -> Any:
        return self._rows.pop(0) if self._rows else None

    def __enter__(self) -> 'FakeCursor':
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def close(self) -> None:
        return None


class FakePgConnection:
    """psycopg2 connection stand-in.

    ``results`` is a list of ``(regex, rows | (rows, column_names) | Exception)``
    matched against each executed SQL, first match wins.
    """

    def __init__(self, results: Optional[List[Tuple[str, Any]]] = None) -> None:
        self.results = list(results or [])
        self.executed: List[Tuple[str, Any]] = []
        self.committed = 0
        self.rolled_back = 0
        self.closed = False
        self.autocommit = False

    def cursor(self, *a: Any, **k: Any) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        self.committed += 1

    def rollback(self) -> None:
        self.rolled_back += 1

    def close(self) -> None:
        self.closed = True


def install_fake_psycopg2(
    monkeypatch: Any, conn: Optional[FakePgConnection] = None, error: Any = None
) -> SimpleNamespace:
    """Make ``import psycopg2`` return a fake whose connect() yields ``conn`` (or raises ``error``).

    Uses monkeypatch, so the real module (if any) is restored after the test.
    Returns a namespace with ``.connect_kwargs`` (list of the kwargs used) and ``.conn``.
    """
    state = SimpleNamespace(connect_kwargs=[], conn=conn or FakePgConnection())
    mod = types.ModuleType('psycopg2')

    def connect(**kwargs: Any) -> FakePgConnection:
        state.connect_kwargs.append(kwargs)
        if error is not None:
            raise error
        return state.conn

    mod.connect = connect
    monkeypatch.setitem(sys.modules, 'psycopg2', mod)
    return state


# -----------------------------------------------------------------------------
# Assertions / services.json helpers
# -----------------------------------------------------------------------------


def assert_no_secrets(value: Any, *secrets: str) -> None:
    """Fail if any secret (default: the fake key and password) appears anywhere in ``value``."""
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    for secret in secrets or (FAKE_SECRET_KEY, FAKE_DB_PASSWORD):
        assert secret not in text, 'a secret value leaked into output'


def load_jsonc(path: Path) -> Dict[str, Any]:
    """Parse a services*.json file (JSONC: // comments, trailing commas)."""
    out_lines = []
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        in_string = False
        i = 0
        while i < len(line):
            ch = line[i]
            if ch == '"' and (i == 0 or line[i - 1] != '\\'):
                in_string = not in_string
            elif not in_string and line.startswith('//', i):
                line = line[:i]
                break
            i += 1
        out_lines.append(line)
    text = re.sub(r',(\s*[}\]])', r'\1', '\n'.join(out_lines))
    return json.loads(text, strict=False)


def load_service(name: str) -> Dict[str, Any]:
    """Load ``nodes/src/nodes/supabase/services.<name>.json``."""
    return load_jsonc(NODE_DIR / f'services.{name}.json')


def load_common_fields() -> Dict[str, Any]:
    """Fields of ``core/services.common.supabase.json``."""
    return load_jsonc(CORE_DIR / 'services.common.supabase.json')['fields']


def config_key(field_id: str) -> str:
    """The config key the engine gives a field: its last dotted segment."""
    return field_id.rsplit('.', 1)[-1]
