import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch, Mock

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes'))

_STUB_MODULE_NAMES = ('rocketlib', 'ai', 'ai.common', 'ai.common.config', 'ai.common.utils')


def _install_stubs() -> None:
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
    mod_rl.OPEN_MODE = Mock()
    mod_rl.warning = Mock()
    sys.modules['rocketlib'] = mod_rl

    sys.modules['ai'] = types.ModuleType('ai')
    sys.modules['ai.common'] = types.ModuleType('ai.common')

    mod_ai_common_config = types.ModuleType('ai.common.config')

    class Config:
        pass

    mod_ai_common_config.Config = Config
    sys.modules['ai.common.config'] = mod_ai_common_config

    mod_ai_common_utils = types.ModuleType('ai.common.utils')
    mod_ai_common_utils.normalize_tool_input = lambda x, **kwargs: x
    mod_ai_common_utils.require_str = lambda x, k, **kwargs: x.get(k)
    mod_ai_common_utils.require_int = lambda x, k, **kwargs: x.get(k)
    sys.modules['ai.common.utils'] = mod_ai_common_utils


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    original_modules = {module_name: sys.modules.get(module_name) for module_name in _STUB_MODULE_NAMES}
    _install_stubs()
    try:
        yield
    finally:
        for module_name, module in original_modules.items():
            if module is None:
                sys.modules.pop(module_name, None)
            else:
                sys.modules[module_name] = module


with _scoped_stubs():
    from tool_github.github_client import call, GitHubAPIError
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
