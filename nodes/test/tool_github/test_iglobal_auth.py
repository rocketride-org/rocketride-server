import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes'))

_STUB_MODULE_NAMES = ('rocketlib', 'ai', 'ai.common', 'ai.common.config', 'ai.common.utils')


def _install_stubs(node_config: dict) -> None:
    mod_rl = types.ModuleType('rocketlib')

    def mock_tool_function(*args, **kwargs):
        return lambda f: f

    mod_rl.tool_function = mock_tool_function

    class IInstanceBase:
        pass

    class IGlobalBase:
        pass

    mod_rl.IInstanceBase = IInstanceBase
    mod_rl.IGlobalBase = IGlobalBase
    mod_rl.OPEN_MODE = types.SimpleNamespace(CONFIG='config')
    mod_rl.warning = Mock()
    sys.modules['rocketlib'] = mod_rl

    sys.modules['ai'] = types.ModuleType('ai')
    sys.modules['ai.common'] = types.ModuleType('ai.common')

    mod_ai_common_config = types.ModuleType('ai.common.config')

    class Config:
        @staticmethod
        def getNodeConfig(logical_type, conn_config):
            return node_config

    mod_ai_common_config.Config = Config
    sys.modules['ai.common.config'] = mod_ai_common_config

    mod_ai_common_utils = types.ModuleType('ai.common.utils')
    mod_ai_common_utils.normalize_tool_input = lambda x, **kwargs: x
    mod_ai_common_utils.require_str = lambda x, k, **kwargs: x.get(k)
    mod_ai_common_utils.require_int = lambda x, k, **kwargs: x.get(k)
    sys.modules['ai.common.utils'] = mod_ai_common_utils


@contextmanager
def _scoped_stubs(node_config: dict) -> Iterator[None]:
    """Install fresh module stubs bound to ``node_config`` and force a clean re-import of
    ``tool_github.*`` so ``IGlobal`` picks up this test's ``Config.getNodeConfig`` stub rather
    than a previous test's cached module. Everything that touches ``tool_github.IGlobal`` --
    imports, patches, and assertions -- must happen inside this context, since the real
    ``rocketlib``/``ai.common.*`` packages this stubs out are not actually installed.
    """
    original_modules = {module_name: sys.modules.get(module_name) for module_name in _STUB_MODULE_NAMES}
    for k in [k for k in sys.modules if k == 'tool_github' or k.startswith('tool_github.')]:
        del sys.modules[k]
    _install_stubs(node_config)
    try:
        yield
    finally:
        for module_name, module in original_modules.items():
            if module is None:
                sys.modules.pop(module_name, None)
            else:
                sys.modules[module_name] = module
        for k in [k for k in sys.modules if k == 'tool_github' or k.startswith('tool_github.')]:
            del sys.modules[k]


def _generate_test_private_key_pem() -> str:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode('utf-8')


_TEST_PRIVATE_KEY_PEM = _generate_test_private_key_pem()


def _generate_test_ec_private_key_pem() -> str:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode('utf-8')


_TEST_EC_PRIVATE_KEY_PEM = _generate_test_ec_private_key_pem()


def _make_global(IGlobal):
    glb = IGlobal()
    glb.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='open'))
    glb.glb = types.SimpleNamespace(logicalType='tool_github', connConfig={})
    return glb


# ---------------------------------------------------------------------------
# beginGlobal / validateConfig branching
# ---------------------------------------------------------------------------


def test_begin_global_pat_default_missing_token_raises():
    with _scoped_stubs({'token': ''}):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        with pytest.raises(Exception, match='token is required'):
            glb.beginGlobal()


def test_begin_global_pat_valid():
    with _scoped_stubs({'token': 'ghp_abc'}):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        glb.beginGlobal()
        assert glb.auth_type == 'pat'
        assert glb.token == 'ghp_abc'


def test_begin_global_app_missing_fields_raises():
    with _scoped_stubs({'authType': 'app', 'appId': '', 'privateKey': '', 'installationId': ''}):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        with pytest.raises(Exception, match='App ID, private key, installation ID required'):
            glb.beginGlobal()


def test_begin_global_app_invalid_key_raises():
    with _scoped_stubs({'authType': 'app', 'appId': '123', 'privateKey': 'not a pem', 'installationId': '456'}):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        with pytest.raises(ValueError, match='invalid GitHub App private key'):
            glb.beginGlobal()


def test_begin_global_app_non_rsa_key_raises():
    with _scoped_stubs(
        {
            'authType': 'app',
            'appId': '123',
            'privateKey': _TEST_EC_PRIVATE_KEY_PEM,
            'installationId': '456',
        }
    ):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        with pytest.raises(ValueError, match='must be an RSA key'):
            glb.beginGlobal()


def test_begin_global_app_valid_does_not_call_network():
    with _scoped_stubs(
        {
            'authType': 'app',
            'appId': '123',
            'privateKey': _TEST_PRIVATE_KEY_PEM,
            'installationId': '456',
        }
    ):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        glb.beginGlobal()
        assert glb.auth_type == 'app'
        assert glb.app_id == '123'
        assert glb.installation_id == '456'
        assert glb._cached_token == ''


def test_validate_config_warns_on_missing_pat():
    with _scoped_stubs({'token': ''}):
        from tool_github.IGlobal import IGlobal, warning

        glb = _make_global(IGlobal)
        glb.validateConfig()
        warning.assert_called_once()
        assert 'token is required' in warning.call_args[0][0]


def test_validate_config_warns_on_missing_app_fields():
    with _scoped_stubs({'authType': 'app'}):
        from tool_github.IGlobal import IGlobal, warning

        glb = _make_global(IGlobal)
        glb.validateConfig()
        warning.assert_called_once()
        assert 'App ID' in warning.call_args[0][0]


def test_validate_config_no_network_call_on_valid_app_config():
    with _scoped_stubs(
        {
            'authType': 'app',
            'appId': '123',
            'privateKey': _TEST_PRIVATE_KEY_PEM,
            'installationId': '456',
        }
    ):
        from tool_github.IGlobal import IGlobal, warning

        glb = _make_global(IGlobal)
        glb.validateConfig()
        warning.assert_not_called()


# ---------------------------------------------------------------------------
# get_token: caching + refresh
# ---------------------------------------------------------------------------


def test_get_token_pat_passthrough():
    with _scoped_stubs({'token': 'ghp_abc'}):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        glb.beginGlobal()
        assert glb.get_token() == 'ghp_abc'


def test_get_token_caches_and_refreshes():
    with _scoped_stubs(
        {
            'authType': 'app',
            'appId': '123',
            'privateKey': _TEST_PRIVATE_KEY_PEM,
            'installationId': '456',
        }
    ):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        glb.beginGlobal()

        with (
            patch('tool_github.IGlobal.github_client.mint_installation_token') as mock_mint,
            patch('tool_github.IGlobal.time.time') as mock_time,
        ):
            mock_mint.return_value = ('ghs_token1', 2000.0)  # expires at t=2000

            # First call at t=1000: mints.
            mock_time.return_value = 1000.0
            assert glb.get_token() == 'ghs_token1'
            assert mock_mint.call_count == 1

            # Second call at t=1500, still well within TTL: cached, no re-mint.
            mock_time.return_value = 1500.0
            assert glb.get_token() == 'ghs_token1'
            assert mock_mint.call_count == 1

            # Third call at t=1945 (within REFRESH_SKEW_SECONDS=60 of the 2000 expiry): re-mints.
            mock_mint.return_value = ('ghs_token2', 5000.0)
            mock_time.return_value = 1945.0
            assert glb.get_token() == 'ghs_token2'
            assert mock_mint.call_count == 2
