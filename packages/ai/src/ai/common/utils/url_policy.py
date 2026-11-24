# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

r"""Fail-closed URL allow-list patterns (shared by URL-fetching nodes).

An allow-list regex is only trusted when its source *proves* which authority
it admits: an optional start anchor, a literal ``http://`` / ``https://``
scheme, then either an exact host (with an optional numeric-port policy) or a
whole-authority ``[^/]`` policy, then an authority boundary (``/``, ``\?``,
``(?=/|$)``, ``$`` ...). Regex syntax is unrestricted only after that
boundary. Unanchored patterns such as ``news\.ycombinator\.com`` are
rejected, because they also match ``https://evil.example/?u=news.ycombinator.com``
and ``https://news.ycombinator.com.evil.example/``.

* :func:`url_matches_pattern` — match a canonical URL and prove the policy;
* :func:`check_allow_pattern` — config-time check that a pattern follows the
  grammar at all (raises ``ValueError``), so a bad pattern fails loudly
  instead of silently matching nothing;
* :func:`canonicalize_url` — the exact URL ``requests`` will send, refusing
  dot segments. Match patterns against this form and send this same
  string: ``requests`` removes ``.`` / ``..`` before sending, so a pattern
  checked against the URL as given could be walked out of with ``/../``.

Moved from ``tool_http_request``. No engine imports: safe to load standalone
in node unit tests.
"""

from __future__ import annotations

import re
from urllib.parse import unquote, urlsplit

import requests


def _match(pattern, url):
    """Apply a configured regex without interpreting or rewriting its syntax."""
    try:
        return pattern.match(url)
    except (TypeError, ValueError):
        return None


def _take_literal_scheme(source):
    """Return an exact HTTP(S) scheme and the first authority-source index."""
    position = 2 if source.startswith(r'\A') else 1 if source.startswith('^') else 0
    for scheme in ('https', 'http'):
        prefix = f'{scheme}://'
        if source.startswith(prefix, position):
            return scheme, position + len(prefix)
    return None


def _take_exact_host(source, position):
    """Parse one literal/escaped DNS, IPv4, or bracketed-IPv6 host."""
    bracketed = source.startswith(r'\[', position)
    if bracketed:
        position += 2

    literal = []
    while position < len(source):
        if bracketed and source.startswith(r'\]', position):
            if not literal:
                return None
            return f'[{"".join(literal)}]', position + 2

        character = source[position]
        if character == '\\':
            if position + 1 < len(source) and source[position + 1] in '.-_':
                literal.append(source[position + 1])
                position += 2
                continue
            break

        allowed = character.isascii() and (character.isalnum() or character in '-_%')
        if bracketed:
            allowed = allowed or character == ':'
        if not allowed:
            break
        literal.append(character)
        position += 1

    if bracketed or not literal:
        return None
    return ''.join(literal), position


def _take_positive_numeric_quantifier(source, position):
    """Return a quantifier endpoint and its inclusive length bounds."""
    if position < len(source) and source[position] == '+':
        return position + 1, 1, None
    if position >= len(source) or source[position] != '{':
        return position, 1, 1

    end = source.find('}', position + 1)
    if end < 0:
        return None
    fields = source[position + 1 : end].split(',')
    if len(fields) > 2 or not fields[0].isdigit():
        return None
    if len(fields) == 2 and fields[1] and not fields[1].isdigit():
        return None
    try:
        minimum = int(fields[0])
        maximum = int(fields[1]) if len(fields) == 2 and fields[1] else None
    except (ValueError, OverflowError):
        return None
    if minimum < 1 or maximum is not None and maximum < minimum:
        return None
    if len(fields) == 1:
        maximum = minimum
    return end + 1, minimum, maximum


def _take_numeric_port(source, position):
    """Parse an exact port or a nonempty decimal-digit language."""
    digit_start = position
    while position < len(source) and source[position].isdigit():
        position += 1
    if position > digit_start:
        return position, source[digit_start:position], None, None
    if not source.startswith('[0-9]', position):
        return None
    quantifier = _take_positive_numeric_quantifier(source, position + len('[0-9]'))
    if quantifier is None:
        return None
    end, minimum, maximum = quantifier
    return end, None, minimum, maximum


def _take_port_policy(source, position):
    """Parse no port, a required numeric port, or an optional numeric port."""
    if source.startswith('(?::', position):
        port_policy = _take_numeric_port(source, position + len('(?::'))
        if port_policy is not None and source.startswith(')?', port_policy[0]):
            return port_policy[0] + 2, True, port_policy[1:]
        return None
    if position < len(source) and source[position] == ':':
        port_policy = _take_numeric_port(source, position + 1)
        if port_policy is None:
            return None
        return port_policy[0], False, port_policy[1:]
    return position, False, None


def _explicit_port_text(netloc):
    """Return the canonical authority's explicit port without normalizing it."""
    if netloc.startswith('['):
        close = netloc.find(']')
        suffix = netloc[close + 1 :]
        return suffix[1:] if suffix.startswith(':') else None
    separator = netloc.rfind(':')
    return netloc[separator + 1 :] if separator >= 0 else None


def _port_policy_matches(port_policy, optional, actual_port):
    """Return whether an explicit port satisfies a recognized source policy."""
    if port_policy is None:
        return actual_port is None
    if actual_port is None:
        return optional
    literal, minimum, maximum = port_policy
    if literal is not None:
        return actual_port == literal
    return actual_port.isdigit() and len(actual_port) >= minimum and (maximum is None or len(actual_port) <= maximum)


def _take_authority_boundary(source, position):
    """Return the boundary endpoint, semantics, and accepted URL delimiter."""
    if position < len(source) and source[position] == '/':
        return position + 1, False, frozenset({'/'})
    if source.startswith(r'\?', position):
        return position + 2, False, frozenset({'?'})
    boundaries = {
        '(?=/|$)': frozenset({'/', ''}),
        '(?:/|$)': frozenset({'/', ''}),
        r'(?=\?|$)': frozenset({'?', ''}),
        r'(?:\?|$)': frozenset({'?', ''}),
        '(?=/|\\?|$)': frozenset({'/', '?', ''}),
        '(?:/|\\?|$)': frozenset({'/', '?', ''}),
    }
    for boundary, delimiters in boundaries.items():
        if source.startswith(boundary, position):
            return position + len(boundary), True, delimiters
    if source[position:] in ('$', r'\Z', r'\z'):
        return len(source), source[position:] == '$', frozenset({''})
    return None


def _inline_flag_group(source, position, verbose):
    """Return an inline-flag group endpoint, scope kind, and verbose mode."""
    if not source.startswith('(?', position):
        return None
    flag_end = position + 2
    while flag_end < len(source) and source[flag_end] in 'aiLmsux-':
        flag_end += 1
    flag_text = source[position + 2 : flag_end]
    if not flag_text or flag_end >= len(source) or source[flag_end] not in ':)':
        return None

    enabled, separator, disabled = flag_text.partition('-')
    if 'x' in enabled:
        verbose = True
    if separator and 'x' in disabled:
        verbose = False
    return flag_end + 1, source[flag_end] == ':', verbose


def _tail_has_no_outer_alternation(source, position, flags):
    """Allow arbitrary post-boundary regex syntax, but not an outer branch."""
    depth = 0
    index = position
    verbose_modes = [bool(flags & re.VERBOSE)]
    while index < len(source):
        if source[index] == '\\':
            index += 2
            continue
        if source.startswith('(?#', index):
            comment_end = source.find(')', index + 3)
            if comment_end < 0:
                return False
            index = comment_end + 1
            continue
        if verbose_modes[-1] and source[index] == '#':
            newline = source.find('\n', index + 1)
            index = len(source) if newline < 0 else newline + 1
            continue
        if source[index] == '[':
            index += 1
            if index < len(source) and source[index] == '^':
                index += 1
            if index < len(source) and source[index] == ']':
                index += 1
            while index < len(source) and source[index] != ']':
                index += 2 if source[index] == '\\' else 1
            if index >= len(source):
                return False
            index += 1
            continue
        if source[index] == '(':
            inline_flags = _inline_flag_group(source, index, verbose_modes[-1])
            if inline_flags is not None:
                index, scoped, verbose = inline_flags
                if scoped:
                    depth += 1
                    verbose_modes.append(verbose)
                else:
                    verbose_modes[-1] = verbose
                continue
            depth += 1
            verbose_modes.append(verbose_modes[-1])
        elif source[index] == ')':
            if depth == 0:
                return False
            depth -= 1
            verbose_modes.pop()
        elif source[index] == '|' and depth == 0:
            return False
        index += 1
    return depth == 0


def _recognizes_authority_policy(pattern, canonical_url):
    """Recognize the documented fail-closed authority-policy source grammar.

    The grammar is an optional start anchor, a literal HTTP(S) scheme, either
    an exact host with an optional numeric-port policy or a whole-authority
    ``[^/]`` policy, and a proven authority boundary. Regex syntax is otherwise
    unrestricted only after that boundary.
    """
    source = pattern.pattern
    scheme_result = _take_literal_scheme(source)
    if scheme_result is None:
        return False
    source_scheme, position = scheme_result

    parsed = urlsplit(canonical_url)
    if parsed.scheme.lower() != source_scheme or not parsed.hostname or parsed.username is not None:
        return False

    if source.startswith('[^/]', position):
        quantifier_start = position + len('[^/]')
        quantifier = _take_positive_numeric_quantifier(source, quantifier_start)
        if quantifier is None or quantifier[0] == quantifier_start:
            return False
        position, minimum, maximum = quantifier
        authority_length = len(parsed.netloc)
        if authority_length < minimum or maximum is not None and authority_length > maximum:
            return False
    else:
        host_result = _take_exact_host(source, position)
        if host_result is None:
            return False
        source_host, position = host_result
        actual_host = f'[{parsed.hostname}]' if parsed.netloc.startswith('[') else parsed.hostname
        if source_host.lower() != actual_host.lower():
            return False
        port_result = _take_port_policy(source, position)
        if port_result is None:
            return False
        position, optional_port, port_policy = port_result
        if not _port_policy_matches(port_policy, optional_port, _explicit_port_text(parsed.netloc)):
            return False

    boundary = _take_authority_boundary(source, position)
    if boundary is None:
        return False
    boundary_end, uses_dollar, delimiters = boundary
    if uses_dollar and pattern.flags & re.MULTILINE:
        return False
    authority_end = len(parsed.scheme) + len('://') + len(parsed.netloc)
    actual_delimiter = canonical_url[authority_end : authority_end + 1]
    if actual_delimiter not in delimiters:
        return False
    return _tail_has_no_outer_alternation(source, boundary_end, pattern.flags)


def _pattern_matches_canonical_url(pattern, canonical_url):
    """Match the canonical URL, then prove the regex authority policy."""
    if not isinstance(pattern.pattern, str):
        return False

    match = _match(pattern, canonical_url)
    if match is None:
        return False
    return _recognizes_authority_policy(pattern, canonical_url)


def url_matches_pattern(pattern: re.Pattern, canonical_url: str) -> bool:
    """Return whether ``canonical_url`` matches ``pattern`` *and* the pattern proves its authority.

    A pattern outside the authority-policy grammar never matches (fail closed).
    """
    return bool(_pattern_matches_canonical_url(pattern, canonical_url))


def _has_authority_policy(pattern: re.Pattern) -> bool:
    """URL-independent half of :func:`_recognizes_authority_policy`."""
    source = pattern.pattern
    if not isinstance(source, str):
        return False
    scheme_result = _take_literal_scheme(source)
    if scheme_result is None:
        return False
    position = scheme_result[1]

    if source.startswith('[^/]', position):
        quantifier_start = position + len('[^/]')
        quantifier = _take_positive_numeric_quantifier(source, quantifier_start)
        if quantifier is None or quantifier[0] == quantifier_start:
            return False
        position = quantifier[0]
    else:
        host_result = _take_exact_host(source, position)
        if host_result is None:
            return False
        port_result = _take_port_policy(source, host_result[1])
        if port_result is None:
            return False
        position = port_result[0]

    boundary = _take_authority_boundary(source, position)
    if boundary is None:
        return False
    boundary_end, uses_dollar, _delimiters = boundary
    if uses_dollar and pattern.flags & re.MULTILINE:
        return False
    return _tail_has_no_outer_alternation(source, boundary_end, pattern.flags)


def check_allow_pattern(pattern: re.Pattern) -> None:
    """Raise ``ValueError`` unless ``pattern`` follows the authority-policy grammar."""
    if not _has_authority_policy(pattern):
        raise ValueError(
            f'Allow-list pattern {pattern.pattern!r} must start with a literal http:// or https:// scheme '
            r'and an exact host (or [^/]+), followed by "/", "\?", "(?=/|$)" or "$", e.g. '
            r'^https://news\.ycombinator\.com/'
        )


def url_has_dot_segments(url: str) -> bool:
    """Whether the URL path has a ``.`` / ``..`` segment, however many times it is percent-encoded.

    Backslashes count as separators. More than five encoding layers fail
    closed (counted as a dot segment).
    """
    path = urlsplit(url).path
    for _decode_attempt in range(5):
        normalized_separators = path.replace('\\', '/')
        if any(segment in {'.', '..'} for segment in normalized_separators.split('/')):
            return True
        decoded = unquote(path)
        if decoded == path:
            return False
        path = decoded
    return True


def canonicalize_url(url: str) -> str:
    """Return the stable URL form ``requests`` will put on the wire.

    The fragment is dropped (it never reaches the server). Raises
    ``ValueError`` for userinfo in the URL, an explicit port zero, a dot
    segment, or a URL whose normalization does not settle. Call it on the URL
    as given, before anything else prepares it: preparing drops a ``:0`` port,
    which would send the request to the scheme's default port instead.
    """
    parsed = urlsplit(url)
    if parsed.username is not None:
        raise ValueError('URL must not include userinfo')
    try:
        explicit_port = parsed.port
    except ValueError:
        explicit_port = None  # out of range or not a number: preparing the URL rejects it
    if explicit_port == 0:
        raise ValueError('URL port is invalid')
    prepared_url = parsed._replace(fragment='').geturl()
    for _attempt in range(3):
        if url_has_dot_segments(prepared_url):
            raise ValueError('URL path must not contain dot segments')
        normalized_url = requests.Request('GET', prepared_url).prepare().url
        if normalized_url == prepared_url:
            return normalized_url
        prepared_url = normalized_url
    raise ValueError('URL normalization did not stabilize')
