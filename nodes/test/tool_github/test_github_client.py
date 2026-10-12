# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import base64
from unittest.mock import patch, Mock

import pytest
import requests

from ._stubs import scoped_stubs

with scoped_stubs(keep_modules=True):
    from tool_github.github_client import (
        call,
        GitHubAPIError,
        load_app_private_key,
        mint_installation_token,
    )
    from tool_github.IInstance import IInstance


def test_file_get_404_ambiguous():
    """Test that ambiguous 404s (missing file, invalid ref, inaccessible repo) return a structured dict."""
    inst = Mock()
    inst._token.return_value = 'token'
    inst._repo.return_value = 'owner/repo'

    with patch('tool_github.IInstance.call') as mock_call:
        # 1. Missing file or inaccessible repository
        mock_call.side_effect = GitHubAPIError(404, 'Not Found')
        result = IInstance.file_get(inst, {'path': 'missing.txt'})
        assert result == {'found': False, 'message': 'GitHub API 404: Not Found'}

        # 2. Invalid ref
        mock_call.side_effect = GitHubAPIError(404, 'No commit found for the ref X')
        result = IInstance.file_get(inst, {'path': 'file.txt', 'ref': 'X'})
        assert result == {'found': False, 'message': 'GitHub API 404: No commit found for the ref X'}


def test_file_get_token_error_is_not_reported_as_missing_file():
    """A 404 from the installation-token endpoint must propagate, not become found=False."""
    inst = Mock()
    inst._token.side_effect = GitHubAPIError(404, 'Integration not found')
    inst._repo.return_value = 'owner/repo'

    with patch('tool_github.IInstance.call') as mock_call:
        with pytest.raises(GitHubAPIError, match='Integration not found'):
            IInstance.file_get(inst, {'path': 'README.md'})
        mock_call.assert_not_called()


def _repos_instance(auth_type: str) -> Mock:
    inst = Mock()
    inst._token.return_value = 'token'
    inst.IGlobal = Mock()
    inst.IGlobal.auth_type = auth_type
    return inst


def test_user_get_repos_without_username_under_app_auth_lists_installation_repos():
    inst = _repos_instance('app')
    with patch('tool_github.IInstance.call') as mock_call:
        mock_call.return_value = {'total_count': 1, 'repositories': [{'full_name': 'o/r', 'name': 'r'}]}
        result = IInstance.user_get_repos(inst, {})

    assert [r['full_name'] for r in result] == ['o/r']
    args, kwargs = mock_call.call_args
    assert args[1:] == ('GET', '/installation/repositories')
    assert 'type' not in kwargs['params']


def test_user_get_repos_without_username_under_pat_lists_own_repos():
    inst = _repos_instance('pat')
    with patch('tool_github.IInstance.call') as mock_call:
        mock_call.return_value = [{'full_name': 'me/r', 'name': 'r'}]
        result = IInstance.user_get_repos(inst, {})

    assert [r['full_name'] for r in result] == ['me/r']
    assert mock_call.call_args.args[1:] == ('GET', '/user/repos')


def test_user_get_repos_with_username_under_app_auth_uses_users_endpoint():
    inst = _repos_instance('app')
    with patch('tool_github.IInstance.call') as mock_call:
        mock_call.return_value = []
        IInstance.user_get_repos(inst, {'username': 'octocat'})

    assert mock_call.call_args.args[1:] == ('GET', '/users/octocat/repos')


@patch('tool_github.github_client.requests.request')
def test_non_rate_limit_403(mock_request):
    """Test that a 403 that is not a rate limit raises GitHubAPIError immediately."""
    resp_403 = Mock(spec=requests.Response)
    resp_403.ok = False
    resp_403.status_code = 403
    resp_403.headers = {}
    resp_403.json.return_value = {'message': 'Resource not accessible by integration'}
    resp_403.text = 'Resource not accessible by integration'

    mock_request.return_value = resp_403

    with pytest.raises(GitHubAPIError) as exc_info:
        call('token', 'GET', '/test')

    assert exc_info.value.status_code == 403
    assert 'Resource not accessible' in exc_info.value.message
    assert mock_request.call_count == 1  # No retries


@patch('tool_github.github_client.time.time', return_value=1000.0)
@patch('time.sleep')
@patch('tool_github.github_client.requests.request')
def test_rate_limit_429_retry_after(mock_request, mock_sleep, mock_time):
    """Test that a 429 response with Retry-After header correctly sleeps and retries."""
    resp_429 = Mock(spec=requests.Response)
    resp_429.ok = False
    resp_429.status_code = 429
    resp_429.headers = {'Retry-After': '5'}
    resp_429.json.return_value = {'message': 'rate limit'}
    resp_429.text = 'rate limit'

    resp_success = Mock(spec=requests.Response)
    resp_success.ok = True
    resp_success.status_code = 200
    resp_success.json.return_value = {'success': True}

    mock_request.side_effect = [resp_429, resp_429, resp_success]

    result = call('token', 'GET', '/test')

    assert result == {'success': True}
    assert mock_request.call_count == 3
    assert mock_sleep.call_count == 2
    mock_sleep.assert_called_with(5.0)


@patch('tool_github.github_client.time.time', return_value=1000.0)
@patch('time.sleep')
@patch('tool_github.github_client.requests.request')
def test_rate_limit_403_reset(mock_request, mock_sleep, mock_time):
    """Test that a 403 secondary rate limit with X-RateLimit-Reset correctly sleeps and retries."""
    resp_403 = Mock(spec=requests.Response)
    resp_403.ok = False
    resp_403.status_code = 403
    resp_403.headers = {'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1010.0'}
    resp_403.json.return_value = {'message': 'rate limit'}
    resp_403.text = 'rate limit'

    mock_request.side_effect = [resp_403, resp_403, resp_403, resp_403]

    with pytest.raises(GitHubAPIError) as exc_info:
        call('token', 'GET', '/test')

    assert exc_info.value.status_code == 403
    assert mock_request.call_count == 3
    assert mock_sleep.call_count == 2
    mock_sleep.assert_called_with(10.0)


@patch('tool_github.github_client.time.time', return_value=1000.0)
@patch('time.sleep')
@patch('tool_github.github_client.requests.request')
@pytest.mark.parametrize('bad_value', ['malformed', '-5', 'NaN', 'Inf'])
def test_rate_limit_retry_after_malformed(mock_request, mock_sleep, mock_time, bad_value):
    """Test that malformed/negative/non-finite Retry-After falls back to exponential backoff."""
    resp_429 = Mock(spec=requests.Response)
    resp_429.ok = False
    resp_429.status_code = 429
    resp_429.headers = {'Retry-After': bad_value}
    resp_429.json.return_value = {'message': 'rate limit'}
    resp_429.text = 'rate limit'

    resp_success = Mock(spec=requests.Response)
    resp_success.ok = True
    resp_success.status_code = 200
    resp_success.json.return_value = {'success': True}

    mock_request.side_effect = [resp_429, resp_success]

    result = call('token', 'GET', '/test')

    assert result == {'success': True}
    assert mock_request.call_count == 2
    assert mock_sleep.call_count == 1
    # Should fall back to wait_exponential (first wait is usually 2s with multiplier=2, min=2)
    # Actually wait_exponential without attempt context just evaluates to a power of 2, 2.0s
    assert mock_sleep.call_args[0][0] >= 2.0


@patch('tool_github.github_client.time.time', return_value=1000.0)
@patch('time.sleep')
@patch('tool_github.github_client.requests.request')
def test_rate_limit_excessive_wait_fails_fast(mock_request, mock_sleep, mock_time):
    """Test that an excessive server-provided wait > DEFAULT_TIMEOUT fails fast."""
    resp_429 = Mock(spec=requests.Response)
    resp_429.ok = False
    resp_429.status_code = 429
    resp_429.headers = {'Retry-After': '3600'}  # 1 hour
    resp_429.json.return_value = {'message': 'rate limit'}
    resp_429.text = 'rate limit'

    mock_request.return_value = resp_429

    with pytest.raises(GitHubAPIError) as exc_info:
        call('token', 'GET', '/test')

    assert exc_info.value.status_code == 429
    assert 'rate limit' in exc_info.value.message
    assert 'retry after 3600s' in exc_info.value.message  # reset hint tells caller when to retry
    assert mock_request.call_count == 1  # Failed fast on first attempt
    assert mock_sleep.call_count == 0  # No sleep


# ---------------------------------------------------------------------------
# GitHub App installation-token auth
# ---------------------------------------------------------------------------


def _mint_response(body, status_code=201):
    resp = Mock(spec=requests.Response)
    resp.ok = True
    resp.status_code = status_code
    resp.json.return_value = body
    return resp


def test_load_app_private_key_valid(rsa_private_key_pem):
    key = load_app_private_key(rsa_private_key_pem)
    assert key is not None


def test_load_app_private_key_invalid():
    with pytest.raises(ValueError, match='invalid GitHub App private key'):
        load_app_private_key('not a real pem')


def test_load_app_private_key_rejects_non_rsa(ec_private_key_pem):
    with pytest.raises(ValueError, match='must be an RSA key'):
        load_app_private_key(ec_private_key_pem)


@patch('tool_github.github_client.requests.request')
def test_mint_installation_token_success(mock_request, rsa_private_key_pem):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    mock_request.return_value = _mint_response({'token': 'ghs_abc123', 'expires_at': '2026-08-24T12:00:00Z'})

    token, expiry = mint_installation_token('12345', rsa_private_key_pem, '67890')

    assert token == 'ghs_abc123'
    assert expiry == 1787572800.0  # 2026-08-24T12:00:00Z as epoch seconds

    # Verify the mint call hit the right endpoint with a signed JWT bearer.
    args, kwargs = mock_request.call_args
    assert args[0] == 'POST'
    assert args[1] == 'https://api.github.com/app/installations/67890/access_tokens'
    auth_header = kwargs['headers']['Authorization']
    assert auth_header.startswith('Bearer ')
    jwt_token = auth_header.split(' ', 1)[1]

    signing_input, _, signature_b64 = jwt_token.rpartition('.')
    header_b64, _, payload_b64 = signing_input.partition('.')

    def _b64url_decode(s: str) -> bytes:
        return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))

    import json

    header = json.loads(_b64url_decode(header_b64))
    payload = json.loads(_b64url_decode(payload_b64))
    assert header['alg'] == 'RS256'
    assert header['typ'] == 'JWT'
    assert payload['iss'] == '12345'
    assert payload['exp'] - payload['iat'] <= 630  # 570s TTL + 60s backdated iat

    # GitHub verifies this signature with the App's public key; do the same here.
    load_app_private_key(rsa_private_key_pem).public_key().verify(
        _b64url_decode(signature_b64), signing_input.encode('ascii'), padding.PKCS1v15(), hashes.SHA256()
    )


@patch('tool_github.github_client.requests.request')
def test_mint_installation_token_signature_is_bound_to_the_key(mock_request, rsa_private_key_pem):
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    mock_request.return_value = _mint_response({'token': 'ghs_abc123', 'expires_at': '2026-08-24T12:00:00Z'})
    mint_installation_token('12345', rsa_private_key_pem, '67890')

    jwt_token = mock_request.call_args.kwargs['headers']['Authorization'].split(' ', 1)[1]
    signing_input, _, signature_b64 = jwt_token.rpartition('.')
    signature = base64.urlsafe_b64decode(signature_b64 + '=' * (-len(signature_b64) % 4))

    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(InvalidSignature):
        other_key.public_key().verify(signature, signing_input.encode('ascii'), padding.PKCS1v15(), hashes.SHA256())


@patch('tool_github.github_client.requests.request')
def test_mint_installation_token_401(mock_request, rsa_private_key_pem):
    resp = Mock(spec=requests.Response)
    resp.ok = False
    resp.status_code = 401
    resp.headers = {}
    resp.json.return_value = {'message': 'Bad credentials'}
    resp.text = 'Bad credentials'

    mock_request.return_value = resp

    with pytest.raises(GitHubAPIError) as exc_info:
        mint_installation_token('12345', rsa_private_key_pem, '67890')

    assert exc_info.value.status_code == 401


@patch('tool_github.github_client.requests.request')
def test_mint_installation_token_network_error_raises_value_error(mock_request, rsa_private_key_pem):
    mock_request.side_effect = requests.ConnectionError('dns down')

    with pytest.raises(ValueError, match='GitHub App token request failed: dns down') as exc_info:
        mint_installation_token('12345', rsa_private_key_pem, '67890')

    assert not isinstance(exc_info.value, GitHubAPIError)
    assert isinstance(exc_info.value.__cause__, requests.ConnectionError)


@patch('tool_github.github_client.requests.request')
def test_mint_installation_token_missing_fields(mock_request, rsa_private_key_pem):
    mock_request.return_value = _mint_response({'token': 'ghs_abc123'})  # missing expires_at

    with pytest.raises(GitHubAPIError, match='missing token/expires_at'):
        mint_installation_token('12345', rsa_private_key_pem, '67890')


@patch('tool_github.github_client.requests.request')
def test_mint_installation_token_non_json_body_is_github_error(mock_request, rsa_private_key_pem):
    resp = _mint_response(None, status_code=200)
    resp.json.side_effect = ValueError('Expecting value: line 1 column 1 (char 0)')
    mock_request.return_value = resp

    with pytest.raises(GitHubAPIError, match='installation token response is not JSON') as exc_info:
        mint_installation_token('12345', rsa_private_key_pem, '67890')

    assert exc_info.value.status_code == 200


@patch('tool_github.github_client.requests.request')
def test_mint_installation_token_non_object_body_is_github_error(mock_request, rsa_private_key_pem):
    mock_request.return_value = _mint_response(['not', 'an', 'object'])

    with pytest.raises(GitHubAPIError, match='missing token/expires_at'):
        mint_installation_token('12345', rsa_private_key_pem, '67890')


@patch('tool_github.github_client.requests.request')
def test_mint_installation_token_malformed_expires_at_is_github_error(mock_request, rsa_private_key_pem):
    mock_request.return_value = _mint_response({'token': 'ghs_abc123', 'expires_at': 'soon'})

    with pytest.raises(GitHubAPIError, match='invalid expires_at: soon') as exc_info:
        mint_installation_token('12345', rsa_private_key_pem, '67890')

    assert exc_info.value.status_code == 201
