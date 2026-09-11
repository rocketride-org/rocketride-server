# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for HTTP-tool configuration and URL guardrails."""

from __future__ import annotations

import importlib.util
import re
import sys
import types
from pathlib import Path
from unittest.mock import Mock

import pytest

pytest.importorskip('requests')

NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_http_request'


def _load_node_modules(monkeypatch: pytest.MonkeyPatch):
    """Load the node files with small engine-runtime stubs."""
    package_name = f'_tool_http_request_guardrail_test_{id(monkeypatch)}'
    package = types.ModuleType(package_name)
    package.__path__ = [str(NODE_DIR)]
    monkeypatch.setitem(sys.modules, package_name, package)

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = object
    rocketlib.IInstanceBase = object
    rocketlib.OPEN_MODE = types.SimpleNamespace(CONFIG='config')
    rocketlib.warning = Mock()
    rocketlib.tool_function = lambda **_kwargs: lambda function: function
    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib)

    config_module = types.ModuleType('ai.common.config')
    config_module.Config = Mock()
    utils_module = types.ModuleType('ai.common.utils')
    utils_module.config_int = Mock()
    ai_module = types.ModuleType('ai')
    common_module = types.ModuleType('ai.common')
    monkeypatch.setitem(sys.modules, 'ai', ai_module)
    monkeypatch.setitem(sys.modules, 'ai.common', common_module)
    monkeypatch.setitem(sys.modules, 'ai.common.config', config_module)
    monkeypatch.setitem(sys.modules, 'ai.common.utils', utils_module)

    def load(name: str):
        qualified_name = f'{package_name}.{name}'
        spec = importlib.util.spec_from_file_location(qualified_name, NODE_DIR / f'{name}.py')
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, qualified_name, module)
        spec.loader.exec_module(module)
        return module

    http_client = load('http_client')
    iglobal = load('IGlobal')
    iinstance = load('IInstance')
    return http_client, iglobal, iinstance


@pytest.mark.parametrize(
    'whitelist,error',
    [
        ([{'whitelistPattern': '['}], 'Invalid URL whitelist regex'),
        ([{}], 'must be a string'),
        ([{'whitelistPattern': ['^https://service.example/$']}], 'must be a string'),
        ([{'whitelistPattern': True}], 'must be a string'),
        ([{'whitelistPattern': 123}], 'must be a string'),
        (['https://service.example'], 'must be an object'),
        ({}, 'malformed and cannot be parsed'),
        (False, 'malformed and cannot be parsed'),
        (0, 'malformed and cannot be parsed'),
    ],
)
def test_invalid_url_whitelist_fails_closed(monkeypatch, whitelist, error):
    """A malformed intended restriction cannot silently become allow-all."""
    _http_client, iglobal, _iinstance = _load_node_modules(monkeypatch)

    with pytest.raises(ValueError, match=error):
        iglobal.IGlobal._build_guardrails({'urlWhitelist': whitelist})


def test_empty_url_whitelist_still_allows_all_public_urls(monkeypatch):
    """An intentionally empty whitelist keeps the documented public-only default."""
    _http_client, iglobal, _iinstance = _load_node_modules(monkeypatch)

    _enabled, patterns = iglobal.IGlobal._build_guardrails({'urlWhitelist': []})

    assert patterns == []


@pytest.mark.parametrize(
    'whitelist',
    [
        [{'whitelistPattern': ''}],
        [{'whitelistPattern': ' \t '}],
    ],
)
def test_placeholder_only_url_whitelist_is_treated_as_empty(monkeypatch, whitelist):
    """Empty UI placeholder rows preserve the documented public-only default."""
    _http_client, iglobal, _iinstance = _load_node_modules(monkeypatch)

    _enabled, patterns = iglobal.IGlobal._build_guardrails({'urlWhitelist': whitelist})

    assert patterns == []


def test_blank_url_whitelist_rows_are_ignored_alongside_valid_patterns(monkeypatch):
    """Placeholder rows never broaden a whitelist containing real patterns."""
    _http_client, iglobal, _iinstance = _load_node_modules(monkeypatch)

    _enabled, patterns = iglobal.IGlobal._build_guardrails(
        {
            'urlWhitelist': [
                {'whitelistPattern': ''},
                {'whitelistPattern': '^https://service\\.example/public/'},
                {'whitelistPattern': '  '},
            ]
        }
    )

    assert [pattern.pattern for pattern in patterns] == [r'^https://service\.example/public/']


def test_config_preserves_arbitrary_valid_python_regex_syntax(monkeypatch):
    """Config compilation does not reject or rewrite valid Python regex syntax."""
    _http_client, iglobal, _iinstance = _load_node_modules(monkeypatch)
    sources = [
        r'^https://service\.example(?=/|$)',
        r'^https://service\.example/(?# (?= is comment text)[a-z]+$',
        r'^https://service\.example/[](?=a-z]$',
        r'^https://service\.example/x{,100}$',
        r'^https://service\.example/x{,}$',
        r'^https://service\.example/x{1,}$',
        r'^https://service\.example/x{1,100}$',
        r'^https://service\.example/x{1}$',
    ]
    if sys.version_info >= (3, 11):
        sources.append(r'^https://service\.example/.++$')

    _enabled, patterns = iglobal.IGlobal._build_guardrails(
        {'urlWhitelist': [{'whitelistPattern': source} for source in sources]}
    )

    assert [pattern.pattern for pattern in patterns] == sources


@pytest.mark.parametrize(
    'pattern',
    [
        'https://service\\.example/',
        '^https://service\\.example/',
    ],
)
def test_begin_global_warns_about_whitelist_migration(monkeypatch, pattern):
    """Every configured whitelist gets a canonical-matching migration warning."""
    _http_client, iglobal, _iinstance = _load_node_modules(monkeypatch)
    cfg = {'urlWhitelist': [{'whitelistPattern': pattern}]}
    iglobal.Config.getNodeConfig.return_value = cfg
    iglobal.config_int.side_effect = [1, 60, 10]
    instance = object.__new__(iglobal.IGlobal)
    instance.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='run'))
    instance.glb = types.SimpleNamespace(logicalType='tool_http_request', connConfig={})

    instance.beginGlobal()

    iglobal.warning.assert_called_once_with(
        'URL whitelist patterns now require a supported, explicit authority boundary; '
        'review existing patterns before making requests'
    )


def test_whitelist_checks_path_resolved_url(monkeypatch):
    """The allowlist sees the exact path that will be sent on the wire."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(r'^https://service\.example/users/42$')],
    )

    resolved_url = instance._validate_guardrails(
        {
            'url': 'https://service.example/users/:id',
            'method': 'GET',
            'path_params': {'id': '42'},
        }
    )

    assert resolved_url == 'https://service.example/users/42'


def test_whitelist_rejects_path_after_resolution(monkeypatch):
    """A template cannot be approved before its final path is known."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(r'^https://service\.example/users/allowed$')],
    )

    with pytest.raises(ValueError, match='does not match'):
        instance._validate_guardrails(
            {
                'url': 'https://service.example/users/:id',
                'method': 'GET',
                'path_params': {'id': 'denied'},
            }
        )


@pytest.mark.parametrize(
    ('request_options', 'expected_url'),
    [
        (
            {'query_params': {'extra': '2'}},
            'https://api.example.com/path?fixed=1&extra=2',
        ),
        (
            {
                'auth': {
                    'type': 'api_key',
                    'api_key': {'key': 'api_key', 'value': 'secret', 'add_to': 'query_param'},
                }
            },
            'https://api.example.com/path?fixed=1&api_key=secret',
        ),
    ],
)
def test_whitelist_rejects_final_query_mutations(monkeypatch, request_options, expected_url):
    """Exact URL patterns reject query data added after path substitution."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(r'^https://api\.example\.com/path\?fixed=1$')],
    )

    with pytest.raises(ValueError, match='does not match') as exc_info:
        instance._validate_guardrails(
            {
                'url': 'https://api.example.com/path?fixed=1',
                'method': 'GET',
                **request_options,
            }
        )

    assert expected_url not in str(exc_info.value)
    assert 'secret' not in str(exc_info.value)


@pytest.mark.parametrize(
    ('request_options', 'expected_url'),
    [
        (
            {'query_params': {'extra': '2'}},
            'https://api.example.com/path?fixed=1&extra=2',
        ),
        (
            {
                'auth': {
                    'type': 'api_key',
                    'api_key': {'key': 'api_key', 'value': 'secret', 'add_to': 'query_param'},
                }
            },
            'https://api.example.com/path?fixed=1&api_key=secret',
        ),
    ],
)
def test_whitelist_checks_final_query_url(monkeypatch, request_options, expected_url):
    """Exact URL patterns see the canonical query string sent to transport."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(rf'^{re.escape(expected_url)}$')],
    )

    assert (
        instance._validate_guardrails(
            {
                'url': 'https://api.example.com/path?fixed=1',
                'method': 'GET',
                **request_options,
            }
        )
        == expected_url
    )


@pytest.mark.parametrize(
    ('pattern', 'url'),
    [
        (r'^https://', 'https://api.example.com/x'),
        (r'^https://api\.example\.com', 'https://api.example.com.evil.net/x'),
        (r'^https://api\.example\.com:4', 'https://api.example.com:443/x'),
    ],
)
def test_whitelist_rejects_matches_ending_inside_authority(monkeypatch, pattern, url):
    """Whitelist matches must consume some authority without stopping inside a field."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(pattern)],
    )

    with pytest.raises(ValueError, match='does not match'):
        instance._validate_guardrails({'url': url, 'method': 'GET'})


@pytest.mark.parametrize(
    ('pattern', 'url'),
    [
        (r'^https://api\.example\.com.*', 'https://api.example.com.evil.net/data'),
        (r'^https://api\.example\.com.*$', 'https://api.example.com.evil.net/data'),
        (r'^https://api\.example\.com:4.*', 'https://api.example.com:443/data'),
        (r'^https://api\.example\.com.*/private$', 'https://api.example.com.evil.net/private'),
        (r'^https://api\.example\.com.+/private$', 'https://api.example.com.evil.net/x/private'),
        (r'^https://api\.example\.com[^?]*\?key=x$', 'https://api.example.com.evil.net/private?key=x'),
        (r'^https://api\.example\.com.{,100}$', 'https://api.example.com.evil.net/private'),
        (r'^https://api\.example\.com.{,}$', 'https://api.example.com.evil.net/private'),
        (r'^https://api\.example\.com(?::443)?.*/private$', 'https://api.example.com:4434/private'),
        (r'^https://api\.example\.com\w*/private$', 'https://api.example.comevil/private'),
        (r'^https://api\.example\.com[^./]{,4}/private$', 'https://api.example.comevil/private'),
        (r'^https://api\.example\.com[a-z]{,4}/', 'https://api.example.comevil/private'),
        (r'^https://192\.0\.2\.1[0-9]{1}/private$', 'https://192.0.2.10/private'),
        (r'^https://\[2001:db8::1[0-9a-f]{1}\]/private$', 'https://[2001:db8::1a]/private'),
        (r'^https://api\.example\.com:443[1-9]*/private$', 'https://api.example.com:4431/private'),
        (r'^https://api\.example\.com:443[0-9]{1}/private$', 'https://api.example.com:4431/private'),
        (r'^https://api\.example\.com:443[0-9]{,1}/private$', 'https://api.example.com:4431/private'),
        pytest.param(
            r'^https://api\.example\.com:443[1-9]*+/private$',
            'https://api.example.com:4431/private',
            marks=pytest.mark.skipif(sys.version_info < (3, 11), reason='possessive quantifiers require Python 3.11'),
        ),
        (
            r'^(?:https://api\.example\.com.*/private$|https://[^/]+(?:/|$))',
            'https://api.example.com.evil.net/private',
        ),
        (
            r'^(?:https://api\.example\.com:443.*/private$|https://api\.example\.com:[0-9]+(?:/|$))',
            'https://api.example.com:4434/private',
        ),
        (
            r'^https://api\.example\.com:443/private$|^https://api\.example\.com:443[1-9]*/private$',
            'https://api.example.com:4431/private',
        ),
        (r'^https://api\.example\.com', 'https://api.example.com/private'),
        (r'^https://api\.example\.com:443', 'https://api.example.com:443/private'),
        (r'^(?=https://api\.example\.com).*', 'https://api.example.com.evil.net/private'),
        (r'^https://api\.example\.com(?=:443).*', 'https://api.example.com:4434/private'),
    ],
)
def test_whitelist_rejects_consuming_authority_prefixes(monkeypatch, pattern, url):
    """Full matches cannot hide hostname or port prefixes behind later syntax."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(pattern)],
    )

    with pytest.raises(ValueError, match='does not match'):
        instance._validate_guardrails({'url': url, 'method': 'GET'})


@pytest.mark.parametrize(
    ('pattern', 'url'),
    [
        (r'^https://api\.example\.com.*/private$', 'https://api.example.com.evil.net/private'),
        (r'^https://192\.0\.2\.1.*/private$', 'https://192.0.2.10/private'),
        (r'^https://\[2001:db8::1.*/private$', 'https://[2001:db8::10]/private'),
    ],
)
def test_canonical_match_rejects_extended_hostnames_for_each_address_family(monkeypatch, pattern, url):
    """DNS, IPv4, and bracketed IPv6 prefixes are detected semantically."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)

    assert not iinstance._pattern_matches_canonical_url(re.compile(pattern), url)


@pytest.mark.parametrize(
    ('pattern', 'url'),
    [
        (r'^https://api\.example\.com.*/private$', 'https://api.example.com.evil.net/private'),
        (r'^https://api\.example\.com.+/private$', 'https://api.example.com.evil.net/x/private'),
        (r'^https://api\.example\.com[^?]*\?key=x$', 'https://api.example.com.evil.net/x?key=x'),
        (r'^https://api\.example\.com.{,100}$', 'https://api.example.com.evil.net/private'),
        (r'^https://api\.example\.com.{,}$', 'https://api.example.com.evil.net/private'),
    ],
)
def test_canonical_match_rejects_forced_suffix_regex_constructs(monkeypatch, pattern, url):
    """Path/query suffixes and legal brace forms cannot conceal a hostname prefix."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)

    assert not iinstance._pattern_matches_canonical_url(re.compile(pattern), url)


def test_canonical_match_rejects_python_314_terminal_z(monkeypatch):
    """Python 3.14's terminal z anchor cannot force an unsafe match past the host."""
    try:
        pattern = re.compile(r'^https://api\.example\.com.*\z')
    except re.error:
        pytest.skip(r'Python does not support \z')
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)

    assert not iinstance._pattern_matches_canonical_url(pattern, 'https://api.example.com.evil.net/private')


@pytest.mark.parametrize(
    ('pattern', 'url'),
    [
        (r'^https://api\.example\.com[a-z]*(?:/|$)', 'https://api.example.com/private'),
        (r'^https://(?=api\.example\.com)api\.example\.com/', 'https://api.example.com/private'),
        (r'^https://(?:api\.example\.com|[^/]+)(?:/|$)', 'https://api.example.com/private'),
        (r'^https?://api\.example\.com/', 'https://api.example.com/private'),
        (r'^https://api.example.com/', 'https://api.example.com/private'),
        (r'^https://(?:[a-z0-9-]+\.)*example\.com(?:/|$)', 'https://sub.api.example.com/data'),
        (r'.+/private$', 'https://any.public.example/private'),
        (
            '^https://api\\.example\\.com/never(?x:# (\n)|^https://api\\.example\\.com/private(?x:# )\n)',
            'https://api.example.com/private',
        ),
    ],
)
def test_canonical_match_rejects_unsupported_authority_syntax(monkeypatch, pattern, url):
    """Ambiguous authority syntax fails closed even when the regex matches the URL."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)

    assert re.compile(pattern).match(url)
    assert not iinstance._pattern_matches_canonical_url(re.compile(pattern), url)


@pytest.mark.parametrize(
    ('pattern', 'url'),
    [
        (r'^https://[^/]+(?:/|$)', 'https://api.example.com:443/data'),
        (r'^https://[^/]{1,20}(?:/|$)', 'https://api.example.com/data'),
        (r'^https://[^/]+(?:/|$)', 'https://192.0.2.10/data'),
        (r'^https://[^/]+(?:/|$)', 'https://[2001:db8::10]:443/data'),
        (r'^https://api\.example\.com(?:/|$)', 'https://api.example.com/data'),
        (r'^https://api\.example\.com:443(?:/|$)', 'https://api.example.com:443/data'),
        (r'^https://api\.example\.com(?::443)?(?:/|$)', 'https://api.example.com:443/data'),
        (r'^https://api\.example\.com(?::443)?(?:/|$)', 'https://api.example.com/data'),
        (r'^https://\[2001:db8::1\]:443/', 'https://[2001:db8::1]:443/data'),
        (r'^https://api\.example\.com/files/escaped\.json$', 'https://api.example.com/files/escaped.json'),
        (r'^https://api\.example\.com/files/.+?$', 'https://api.example.com/files/a/b'),
        (r'^https://api\.example\.com/files/[a-z]{1,10}$', 'https://api.example.com/files/abc'),
        (r'^https://api\.example\.com/[]a]$', 'https://api.example.com/]'),
        (r'^https://api\.example\.com/x{,}$', 'https://api.example.com/xxx'),
        pytest.param(
            r'^https://api\.example\.com/files/.++$',
            'https://api.example.com/files/abc',
            marks=pytest.mark.skipif(sys.version_info < (3, 11), reason='possessive quantifiers require Python 3.11'),
        ),
        (r'^https://api\.example\.com(?=/|$)', 'https://api.example.com/data'),
        (r'^https://api\.example\.com:[0-9]+(?:/|$)', 'https://api.example.com:443/data'),
        (r'^https://api\.example\.com:[0-9]{3,4}(?:/|$)', 'https://api.example.com:443/data'),
        (r'^https://api\.example\.com(?::[0-9]{3,4})?(?:/|$)', 'https://api.example.com:443/data'),
        (r'^https://api\.example\.com(?::[0-9]{3,4})?(?:/|$)', 'https://api.example.com/data'),
        (r'^https://192\.0\.2\.10(?:/|$)', 'https://192.0.2.10/data'),
        (r'^https://\[2001:db8::10\](?:/|$)', 'https://[2001:db8::10]/data'),
        (r'^https://api\.example\.com\?key=[a-z]+$', 'https://api.example.com?key=value'),
        (r'^https://api\.example\.com$', 'https://api.example.com'),
        (r'^https://api\.example\.com\Z', 'https://api.example.com'),
    ],
)
def test_canonical_match_preserves_safe_full_url_patterns(monkeypatch, pattern, url):
    """Authority-safe URL, path, escaped, lazy, and bounded patterns still work."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)

    assert iinstance._pattern_matches_canonical_url(re.compile(pattern), url)


def test_canonical_match_rejects_multiline_authority_boundary(monkeypatch):
    """MULTILINE must not turn a line end into an authority boundary."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    pattern = re.compile(r'^https://api\.example\.com$', re.MULTILINE)

    assert pattern.match('https://api.example.com\n.evil')
    assert not iinstance._pattern_matches_canonical_url(pattern, 'https://api.example.com\n.evil')


def test_canonical_match_allows_multiline_after_consuming_path_boundary(monkeypatch):
    """Post-boundary regex flags do not weaken a consumed authority delimiter."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    pattern = re.compile(r'^https://api\.example\.com/data$', re.MULTILINE)

    assert iinstance._pattern_matches_canonical_url(pattern, 'https://api.example.com/data')


@pytest.mark.parametrize(
    ('pattern', 'url'),
    [
        (r'^https://[^/]+(?:/|$)', 'https://api.example.com:443/data'),
        (r'^https://api\.example\.com/public/', 'https://api.example.com/public/data'),
        (r'^https://api\.example\.com(?::[0-9]+)?(?:/|$)', 'https://api.example.com:443/data'),
        (r'^https://api\.example\.com:443(?:/|$)', 'https://api.example.com:443/data'),
        (r'^https://\[2001:db8::1\]:443(?:/|$)', 'https://[2001:db8::1]:443/data'),
    ],
)
def test_whitelist_allows_matches_ending_at_authority_boundaries(monkeypatch, pattern, url):
    """Host-agnostic, path, port, and IPv6 boundary patterns remain valid."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(pattern)],
    )

    assert instance._validate_guardrails({'url': url, 'method': 'GET'}) == url


@pytest.mark.parametrize('encoded_segment', ['%2e%2e', '%252e%252e', '%2e%2e%5cadmin'])
def test_whitelist_rejects_encoded_dot_segments(monkeypatch, encoded_segment):
    """Requests cannot decode traversal syntax after the whitelist approves it."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(r'^https://service\.example/public/')],
    )

    with pytest.raises(ValueError, match='dot segments'):
        instance._validate_guardrails(
            {
                'url': f'https://service.example/public/{encoded_segment}/admin',
                'method': 'GET',
            }
        )


@pytest.mark.parametrize(
    'url',
    [
        'https://attacker.example/?next=https://service.example/public/data',
        'https://attacker.example/#https://service.example/public/data',
    ],
)
def test_whitelist_pattern_cannot_match_inside_query_or_fragment(monkeypatch, url):
    """Only the request URL prefix—not embedded URL-shaped data—can satisfy a pattern."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(r'https://service\.example/public/')],
    )

    with pytest.raises(ValueError, match='does not match'):
        instance._validate_guardrails({'url': url, 'method': 'GET'})


def test_whitelist_checks_url_without_fragment(monkeypatch):
    """A fragment that is never sent cannot change allowlist matching."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(r'https://service\.example/public/data$')],
    )

    resolved_url = instance._validate_guardrails(
        {'url': 'https://service.example/public/data#client-only', 'method': 'GET'}
    )

    assert resolved_url == 'https://service.example/public/data'


@pytest.mark.parametrize(
    'url',
    [
        'https://username@service.example/data',
        'https://username:password@service.example/data',
        'https://@service.example/data',
    ],
)
def test_guardrails_reject_userinfo_urls(monkeypatch, url):
    """Instance validation rejects URL credentials before whitelist matching."""
    _http_client, _iglobal, iinstance = _load_node_modules(monkeypatch)
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = types.SimpleNamespace(enabled_methods={'GET'}, url_patterns=[])

    with pytest.raises(ValueError, match='userinfo'):
        instance._validate_guardrails({'url': url, 'method': 'GET'})
