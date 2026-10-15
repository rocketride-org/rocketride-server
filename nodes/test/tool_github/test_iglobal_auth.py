# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import base64
import types
from unittest.mock import patch

import pytest

from ._stubs import scoped_stubs


def _make_global(IGlobal):
    glb = IGlobal()
    glb.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='open'))
    glb.glb = types.SimpleNamespace(logicalType='tool_github', connConfig={})
    return glb


def _app_config(rsa_private_key_pem, **overrides):
    cfg = {'authType': 'app', 'appId': '123', 'privateKey': rsa_private_key_pem, 'installationId': '456'}
    cfg.update(overrides)
    return cfg


# ---------------------------------------------------------------------------
# beginGlobal
# ---------------------------------------------------------------------------


def test_begin_global_pat_default_missing_token_raises():
    with scoped_stubs({'token': ''}):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        with pytest.raises(ValueError, match='token is required'):
            glb.beginGlobal()


def test_begin_global_pat_valid():
    with scoped_stubs({'token': 'ghp_abc'}):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        glb.beginGlobal()
        assert glb.auth_type == 'pat'
        assert glb.token == 'ghp_abc'


@pytest.mark.parametrize('auth_type', ['App', 'github_app', 'PAT', 'oauth'])
def test_begin_global_unknown_auth_type_raises(rsa_private_key_pem, auth_type):
    cfg = _app_config(rsa_private_key_pem, authType=auth_type, token='ghp_abc')
    with scoped_stubs(cfg):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        with pytest.raises(ValueError, match=f'unknown authType {auth_type!r}; expected "pat" or "app"'):
            glb.beginGlobal()


def test_begin_global_app_missing_fields_raises():
    with scoped_stubs({'authType': 'app', 'appId': '', 'privateKey': '', 'installationId': ''}):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        with pytest.raises(ValueError, match='App ID, private key, installation ID required'):
            glb.beginGlobal()


def test_begin_global_app_invalid_key_raises(rsa_private_key_pem):
    with scoped_stubs(_app_config(rsa_private_key_pem, privateKey='not a pem')):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        with pytest.raises(ValueError, match='invalid GitHub App private key'):
            glb.beginGlobal()


def test_begin_global_app_non_rsa_key_raises(rsa_private_key_pem, ec_private_key_pem):
    with scoped_stubs(_app_config(rsa_private_key_pem, privateKey=ec_private_key_pem)):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        with pytest.raises(ValueError, match='must be an RSA key'):
            glb.beginGlobal()


def test_begin_global_app_accepts_uploaded_pem_data_url(rsa_private_key_pem):
    data_url = 'data:application/x-pem-file;base64,' + base64.b64encode(rsa_private_key_pem.encode()).decode()
    with scoped_stubs(_app_config(rsa_private_key_pem, privateKey=data_url)):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        glb.beginGlobal()
        assert glb.private_key_pem == rsa_private_key_pem


def test_begin_global_app_accepts_pasted_pem_text(rsa_private_key_pem):
    with scoped_stubs(_app_config(rsa_private_key_pem, privateKey='\n' + rsa_private_key_pem + '\n')):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        glb.beginGlobal()
        assert glb.private_key_pem == rsa_private_key_pem.strip()


@pytest.mark.parametrize(
    'upload',
    [
        'data:application/x-pem-file;base64,QUJDRA',  # bad padding
        'data:application/x-pem-file;base64,QUJD RA==',  # stray character: rejected, not dropped
        'data:application/x-pem-file;base64,' + base64.b64encode(b'\xff\xfe').decode(),  # not UTF-8
    ],
)
def test_begin_global_app_corrupt_pem_upload_raises(rsa_private_key_pem, upload):
    with scoped_stubs(_app_config(rsa_private_key_pem, privateKey=upload)):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        with pytest.raises(ValueError, match='invalid GitHub App private key upload'):
            glb.beginGlobal()


@pytest.mark.parametrize(
    'installation_id', ['../x', '12 34', '１２３', 'https://github.com/settings/installations/456']
)
def test_begin_global_app_non_numeric_installation_id_raises(rsa_private_key_pem, installation_id):
    with scoped_stubs(_app_config(rsa_private_key_pem, installationId=installation_id)):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        with pytest.raises(ValueError, match='installation ID must be numeric'):
            glb.beginGlobal()


def test_begin_global_app_valid_does_not_call_network(rsa_private_key_pem):
    with scoped_stubs(_app_config(rsa_private_key_pem)):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        with patch('tool_github.IGlobal.github_client.mint_installation_token') as mock_mint:
            glb.beginGlobal()
        mock_mint.assert_not_called()
        assert glb.auth_type == 'app'
        assert glb.app_id == '123'
        assert glb.installation_id == '456'
        assert glb._cached_token == ''


# ---------------------------------------------------------------------------
# validateConfig: warns with the same message beginGlobal raises, never raises
# ---------------------------------------------------------------------------


def _validate_warnings(cfg) -> list[str]:
    with scoped_stubs(cfg):
        from tool_github.IGlobal import IGlobal, warning

        glb = _make_global(IGlobal)
        glb.validateConfig()
        return [call.args[0] for call in warning.call_args_list]


def test_validate_config_warns_on_missing_pat():
    assert _validate_warnings({'token': ''}) == ['tool_github: token is required']


def test_validate_config_warns_on_unknown_auth_type():
    warnings = _validate_warnings({'authType': 'App', 'token': 'ghp_abc'})
    assert warnings == ['tool_github: unknown authType \'App\'; expected "pat" or "app"']


def test_validate_config_warns_on_missing_app_fields():
    warnings = _validate_warnings({'authType': 'app'})
    assert warnings == ['tool_github: App ID, private key, installation ID required for GitHub App auth']


def test_validate_config_warns_on_malformed_key(rsa_private_key_pem):
    warnings = _validate_warnings(_app_config(rsa_private_key_pem, privateKey='not a pem'))
    assert len(warnings) == 1
    assert warnings[0].startswith('tool_github: invalid GitHub App private key')


def test_validate_config_warns_on_corrupt_key_upload(rsa_private_key_pem):
    warnings = _validate_warnings(
        _app_config(rsa_private_key_pem, privateKey='data:application/x-pem-file;base64,QUJDRA')
    )
    assert len(warnings) == 1
    assert warnings[0].startswith('tool_github: invalid GitHub App private key upload')


def test_validate_config_warns_on_non_numeric_installation_id(rsa_private_key_pem):
    warnings = _validate_warnings(_app_config(rsa_private_key_pem, installationId='../x'))
    assert warnings == ['tool_github: installation ID must be numeric for GitHub App auth']


def test_validate_config_no_warning_on_valid_app_config(rsa_private_key_pem):
    assert _validate_warnings(_app_config(rsa_private_key_pem)) == []


def test_validate_config_no_warning_on_valid_pat_config():
    assert _validate_warnings({'token': 'ghp_abc'}) == []


# ---------------------------------------------------------------------------
# get_token: caching + refresh
# ---------------------------------------------------------------------------


def test_get_token_pat_passthrough():
    with scoped_stubs({'token': 'ghp_abc'}):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        glb.beginGlobal()
        assert glb.get_token() == 'ghp_abc'


def test_get_token_caches_and_refreshes(rsa_private_key_pem):
    with scoped_stubs(_app_config(rsa_private_key_pem)):
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


def test_get_token_keeps_cached_token_when_early_refresh_fails(rsa_private_key_pem):
    with scoped_stubs(_app_config(rsa_private_key_pem)):
        from tool_github.IGlobal import IGlobal, warning

        glb = _make_global(IGlobal)
        glb.beginGlobal()

        with (
            patch('tool_github.IGlobal.github_client.mint_installation_token') as mock_mint,
            patch('tool_github.IGlobal.time.time') as mock_time,
        ):
            mock_mint.return_value = ('ghs_token1', 2000.0)
            mock_time.return_value = 1000.0
            assert glb.get_token() == 'ghs_token1'

            # Refresh window (expiry - 30): GitHub is down, the still-valid token is kept.
            mock_mint.side_effect = ValueError('GitHub App token request failed: 503')
            mock_time.return_value = 1970.0
            assert glb.get_token() == 'ghs_token1'
            assert mock_mint.call_count == 2
            warning.assert_called_once()
            assert 'token refresh failed' in warning.call_args.args[0]

            # GitHub is back after the retry window (1970 + 15): re-mints.
            mock_mint.side_effect = None
            mock_mint.return_value = ('ghs_token2', 5000.0)
            mock_time.return_value = 1986.0
            assert glb.get_token() == 'ghs_token2'


def test_get_token_does_not_retry_refresh_within_backoff_window(rsa_private_key_pem):
    with scoped_stubs(_app_config(rsa_private_key_pem)):
        from tool_github.IGlobal import IGlobal, warning

        glb = _make_global(IGlobal)
        glb.beginGlobal()

        with (
            patch('tool_github.IGlobal.github_client.mint_installation_token') as mock_mint,
            patch('tool_github.IGlobal.time.time') as mock_time,
        ):
            mock_mint.return_value = ('ghs_token1', 2000.0)
            mock_time.return_value = 1000.0
            assert glb.get_token() == 'ghs_token1'

            mock_mint.side_effect = ValueError('GitHub App token request failed: 503')
            mock_time.return_value = 1970.0
            assert glb.get_token() == 'ghs_token1'
            assert mock_mint.call_count == 2

            # 1970 + 15 = 1985: calls before that use the cached token without a request or a warning.
            for now in (1971.0, 1980.0, 1984.9):
                mock_time.return_value = now
                assert glb.get_token() == 'ghs_token1'
            assert mock_mint.call_count == 2
            warning.assert_called_once()

            # The window is over: the request is sent again.
            mock_time.return_value = 1985.0
            assert glb.get_token() == 'ghs_token1'
            assert mock_mint.call_count == 3
            assert warning.call_count == 2


def test_get_token_backoff_window_starts_when_the_slow_refresh_fails(rsa_private_key_pem):
    with scoped_stubs(_app_config(rsa_private_key_pem)):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        glb.beginGlobal()

        with (
            patch('tool_github.IGlobal.github_client.mint_installation_token') as mock_mint,
            patch('tool_github.IGlobal.time.time') as mock_time,
        ):
            mock_mint.return_value = ('ghs_token1', 2000.0)
            mock_time.return_value = 1000.0
            assert glb.get_token() == 'ghs_token1'

            # The request starts at 1945 (inside the refresh window) and hangs until 1975 before failing.
            mock_mint.side_effect = ValueError('GitHub App token request failed: 503')
            mock_time.side_effect = [1945.0, 1975.0]
            assert glb.get_token() == 'ghs_token1'
            assert mock_mint.call_count == 2

            # 1975 + 15 = 1990: a call at 1985 must not send the request again.
            mock_time.side_effect = None
            mock_time.return_value = 1985.0
            assert glb.get_token() == 'ghs_token1'
            assert mock_mint.call_count == 2


def test_get_token_raises_when_the_slow_refresh_fails_after_expiry(rsa_private_key_pem):
    with scoped_stubs(_app_config(rsa_private_key_pem)):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        glb.beginGlobal()

        with (
            patch('tool_github.IGlobal.github_client.mint_installation_token') as mock_mint,
            patch('tool_github.IGlobal.time.time') as mock_time,
        ):
            mock_mint.return_value = ('ghs_token1', 2000.0)
            mock_time.return_value = 1000.0
            assert glb.get_token() == 'ghs_token1'

            # Starts at 1975 with a valid token, fails at 2005: the token died while waiting.
            mock_mint.side_effect = ValueError('GitHub App token request failed: 503')
            mock_time.side_effect = [1975.0, 2005.0]
            with pytest.raises(ValueError, match='token request failed'):
                glb.get_token()


def test_get_token_backoff_ends_at_expiry(rsa_private_key_pem):
    with scoped_stubs(_app_config(rsa_private_key_pem)):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        glb.beginGlobal()

        with (
            patch('tool_github.IGlobal.github_client.mint_installation_token') as mock_mint,
            patch('tool_github.IGlobal.time.time') as mock_time,
        ):
            mock_mint.return_value = ('ghs_token1', 2000.0)
            mock_time.return_value = 1000.0
            assert glb.get_token() == 'ghs_token1'

            # Fails at 1999; at 2001 the token is dead, so the backoff must not hand it out.
            mock_mint.side_effect = ValueError('GitHub App token request failed: 503')
            mock_time.return_value = 1999.0
            assert glb.get_token() == 'ghs_token1'
            mock_time.return_value = 2001.0
            with pytest.raises(ValueError, match='token request failed'):
                glb.get_token()
            assert mock_mint.call_count == 3


def test_get_token_first_mint_failure_has_no_backoff(rsa_private_key_pem):
    with scoped_stubs(_app_config(rsa_private_key_pem)):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        glb.beginGlobal()

        with (
            patch('tool_github.IGlobal.github_client.mint_installation_token') as mock_mint,
            patch('tool_github.IGlobal.time.time') as mock_time,
        ):
            mock_mint.side_effect = ValueError('GitHub App token request failed: 503')
            mock_time.return_value = 1000.0
            with pytest.raises(ValueError, match='token request failed'):
                glb.get_token()

            # Nothing is cached, so the next call one second later asks GitHub again.
            mock_mint.side_effect = None
            mock_mint.return_value = ('ghs_token1', 5000.0)
            mock_time.return_value = 1001.0
            assert glb.get_token() == 'ghs_token1'
            assert mock_mint.call_count == 2


def test_get_token_raises_when_refresh_fails_after_expiry(rsa_private_key_pem):
    with scoped_stubs(_app_config(rsa_private_key_pem)):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        glb.beginGlobal()

        with (
            patch('tool_github.IGlobal.github_client.mint_installation_token') as mock_mint,
            patch('tool_github.IGlobal.time.time') as mock_time,
        ):
            mock_mint.return_value = ('ghs_token1', 2000.0)
            mock_time.return_value = 1000.0
            assert glb.get_token() == 'ghs_token1'

            # Past expiry (expiry + 1): nothing usable is left, the error propagates.
            mock_mint.side_effect = ValueError('GitHub App token request failed: 503')
            mock_time.return_value = 2001.0
            with pytest.raises(ValueError, match='token request failed'):
                glb.get_token()


def test_get_token_raises_when_first_mint_fails(rsa_private_key_pem):
    with scoped_stubs(_app_config(rsa_private_key_pem)):
        from tool_github.IGlobal import IGlobal

        glb = _make_global(IGlobal)
        glb.beginGlobal()

        with patch('tool_github.IGlobal.github_client.mint_installation_token') as mock_mint:
            mock_mint.side_effect = ValueError('GitHub App token request failed: 503')
            with pytest.raises(ValueError, match='token request failed'):
                glb.get_token()
