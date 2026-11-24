# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for HTTP-tool configuration and URL guardrails.

The node files come from the ``node_modules`` fixture in ``conftest.py``.
"""

from __future__ import annotations

import re
import sys
import types

import pytest

pytest.importorskip('requests')


@pytest.mark.parametrize(
    'whitelist,error',
    [
        ([{'whitelistPattern': '['}], 'Invalid URL whitelist regex'),
        ([{}], 'must be a string'),
        ([{'whitelistPattern': ['^https://service.example/$']}], 'must be a string'),
        ([{'whitelistPattern': True}], 'must be a string'),
        ([{'whitelistPattern': 123}], 'must be a string'),
        (['https://service.example'], 'must be an object'),
        ({}, 'must be a list of rows'),
        (False, 'must be a list of rows'),
        (0, 'must be a list of rows'),
    ],
)
def test_invalid_url_whitelist_fails_closed(node_modules, whitelist, error):
    """A malformed intended restriction cannot silently become allow-all."""
    _http_client, iglobal, _iinstance = node_modules

    with pytest.raises(ValueError, match=error):
        iglobal.IGlobal._build_guardrails({'urlWhitelist': whitelist})


def test_empty_url_whitelist_still_allows_all_public_urls(node_modules):
    """An intentionally empty whitelist keeps the documented public-only default."""
    _http_client, iglobal, _iinstance = node_modules

    _enabled, patterns = iglobal.IGlobal._build_guardrails({'urlWhitelist': []})

    assert patterns == []


@pytest.mark.parametrize(
    'whitelist',
    [
        [{'whitelistPattern': ''}],
        [{'whitelistPattern': ' \t '}],
    ],
)
def test_placeholder_only_url_whitelist_is_treated_as_empty(node_modules, whitelist):
    """Empty UI placeholder rows preserve the documented public-only default."""
    _http_client, iglobal, _iinstance = node_modules

    _enabled, patterns = iglobal.IGlobal._build_guardrails({'urlWhitelist': whitelist})

    assert patterns == []


def test_blank_url_whitelist_rows_are_ignored_alongside_valid_patterns(node_modules):
    """Placeholder rows never broaden a whitelist containing real patterns."""
    _http_client, iglobal, _iinstance = node_modules

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


def test_config_preserves_arbitrary_valid_python_regex_syntax(node_modules):
    """Config compilation does not reject or rewrite valid Python regex syntax."""
    _http_client, iglobal, _iinstance = node_modules
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


def test_whitelist_checks_path_resolved_url(node_modules):
    """The allowlist sees the exact path that will be sent on the wire."""
    _http_client, _iglobal, iinstance = node_modules
    instance = object.__new__(iinstance.IInstance)
    instance._http_guardrails = types.SimpleNamespace(
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


def test_whitelist_rejects_path_after_resolution(node_modules):
    """A template cannot be approved before its final path is known."""
    _http_client, _iglobal, iinstance = node_modules
    instance = object.__new__(iinstance.IInstance)
    instance._http_guardrails = types.SimpleNamespace(
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
def test_whitelist_rejects_final_query_mutations(node_modules, request_options, expected_url):
    """Exact URL patterns reject query data added after path substitution."""
    _http_client, _iglobal, iinstance = node_modules
    instance = object.__new__(iinstance.IInstance)
    instance._http_guardrails = types.SimpleNamespace(
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
def test_whitelist_checks_final_query_url(node_modules, request_options, expected_url):
    """Exact URL patterns see the canonical query string sent to transport."""
    _http_client, _iglobal, iinstance = node_modules
    instance = object.__new__(iinstance.IInstance)
    instance._http_guardrails = types.SimpleNamespace(
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
def test_whitelist_rejects_matches_ending_inside_authority(node_modules, pattern, url):
    """Whitelist matches must consume some authority without stopping inside a field."""
    _http_client, _iglobal, iinstance = node_modules
    instance = object.__new__(iinstance.IInstance)
    instance._http_guardrails = types.SimpleNamespace(
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
def test_whitelist_rejects_consuming_authority_prefixes(node_modules, pattern, url):
    """Full matches cannot hide hostname or port prefixes behind later syntax."""
    _http_client, _iglobal, iinstance = node_modules
    instance = object.__new__(iinstance.IInstance)
    instance._http_guardrails = types.SimpleNamespace(
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
def test_canonical_match_rejects_extended_hostnames_for_each_address_family(node_modules, pattern, url):
    """DNS, IPv4, and bracketed IPv6 prefixes are detected semantically."""
    _http_client, _iglobal, iinstance = node_modules

    assert not iinstance.url_matches_pattern(re.compile(pattern), url)


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
def test_canonical_match_rejects_forced_suffix_regex_constructs(node_modules, pattern, url):
    """Path/query suffixes and legal brace forms cannot conceal a hostname prefix."""
    _http_client, _iglobal, iinstance = node_modules

    assert not iinstance.url_matches_pattern(re.compile(pattern), url)


def test_canonical_match_rejects_python_314_terminal_z(node_modules):
    """Python 3.14's terminal z anchor cannot force an unsafe match past the host."""
    try:
        pattern = re.compile(r'^https://api\.example\.com.*\z')
    except re.error:
        pytest.skip(r'Python does not support \z')
    _http_client, _iglobal, iinstance = node_modules

    assert not iinstance.url_matches_pattern(pattern, 'https://api.example.com.evil.net/private')


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
def test_canonical_match_rejects_unsupported_authority_syntax(node_modules, pattern, url):
    """Ambiguous authority syntax fails closed even when the regex matches the URL."""
    _http_client, _iglobal, iinstance = node_modules

    assert re.compile(pattern).match(url)
    assert not iinstance.url_matches_pattern(re.compile(pattern), url)


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
def test_canonical_match_preserves_safe_full_url_patterns(node_modules, pattern, url):
    """Authority-safe URL, path, escaped, lazy, and bounded patterns still work."""
    _http_client, _iglobal, iinstance = node_modules

    assert iinstance.url_matches_pattern(re.compile(pattern), url)


def test_canonical_match_rejects_multiline_authority_boundary(node_modules):
    """MULTILINE must not turn a line end into an authority boundary."""
    _http_client, _iglobal, iinstance = node_modules
    pattern = re.compile(r'^https://api\.example\.com$', re.MULTILINE)

    assert pattern.match('https://api.example.com\n.evil')
    assert not iinstance.url_matches_pattern(pattern, 'https://api.example.com\n.evil')


def test_canonical_match_allows_multiline_after_consuming_path_boundary(node_modules):
    """Post-boundary regex flags do not weaken a consumed authority delimiter."""
    _http_client, _iglobal, iinstance = node_modules
    pattern = re.compile(r'^https://api\.example\.com/data$', re.MULTILINE)

    assert iinstance.url_matches_pattern(pattern, 'https://api.example.com/data')


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
def test_whitelist_allows_matches_ending_at_authority_boundaries(node_modules, pattern, url):
    """Host-agnostic, path, port, and IPv6 boundary patterns remain valid."""
    _http_client, _iglobal, iinstance = node_modules
    instance = object.__new__(iinstance.IInstance)
    instance._http_guardrails = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(pattern)],
    )

    assert instance._validate_guardrails({'url': url, 'method': 'GET'}) == url


@pytest.mark.parametrize('encoded_segment', ['%2e%2e', '%252e%252e', '%2e%2e%5cadmin'])
def test_whitelist_rejects_encoded_dot_segments(node_modules, encoded_segment):
    """Requests cannot decode traversal syntax after the whitelist approves it."""
    _http_client, _iglobal, iinstance = node_modules
    instance = object.__new__(iinstance.IInstance)
    instance._http_guardrails = types.SimpleNamespace(
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
def test_whitelist_pattern_cannot_match_inside_query_or_fragment(node_modules, url):
    """Only the request URL prefix—not embedded URL-shaped data—can satisfy a pattern."""
    _http_client, _iglobal, iinstance = node_modules
    instance = object.__new__(iinstance.IInstance)
    instance._http_guardrails = types.SimpleNamespace(
        enabled_methods={'GET'},
        url_patterns=[re.compile(r'https://service\.example/public/')],
    )

    with pytest.raises(ValueError, match='does not match'):
        instance._validate_guardrails({'url': url, 'method': 'GET'})


def test_whitelist_checks_url_without_fragment(node_modules):
    """A fragment that is never sent cannot change allowlist matching."""
    _http_client, _iglobal, iinstance = node_modules
    instance = object.__new__(iinstance.IInstance)
    instance._http_guardrails = types.SimpleNamespace(
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
def test_guardrails_reject_userinfo_urls(node_modules, url):
    """Instance validation rejects URL credentials before whitelist matching."""
    _http_client, _iglobal, iinstance = node_modules
    instance = object.__new__(iinstance.IInstance)
    instance._http_guardrails = types.SimpleNamespace(enabled_methods={'GET'}, url_patterns=[])

    with pytest.raises(ValueError, match='userinfo'):
        instance._validate_guardrails({'url': url, 'method': 'GET'})
