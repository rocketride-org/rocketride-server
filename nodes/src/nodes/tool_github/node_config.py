# =============================================================================
# RocketRide Engine
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

"""
GitHub tool node - reading the resolved node config.

The schema validates the scalars (types, ranges, the selector, the tool
allowlist's names); this module keeps the checks it cannot express: the PEM
upload decodes to an RSA key, the installation id is numeric, ``defaultRepo``
is ``owner/repo``, and the ``credentialMap`` rows parse into credentials.
``IGlobal.beginGlobal`` and ``IValidator.validateConfig`` share these readers so
they can never disagree. No message holds a credential.
"""

from __future__ import annotations

import json
import re

from ai.common.utils import decode_data_url

from . import credentials, github_client

_INSTALLATION_ID_RE = re.compile(r'[0-9]+')
# A ${ROCKETRIDE_<name>} placeholder that no variable filled stays in the text as written.
# Only such a complete placeholder is named in a message; any other "${" is refused
# without printing what follows it, which may be the rest of the map, tokens included.
_PLACEHOLDER_RE = re.compile(r'\$\{(ROCKETRIDE_[A-Za-z0-9_]{1,120})\}')
_APP_FIELDS = frozenset({'appId', 'privateKey', 'installationId'})
# The node credential's fields for each authType; any of them set means the node has one.
_NODE_FIELDS = {'pat': ('token',), 'app': ('appId', 'privateKey', 'installationId')}


def _decode_pem_blob(value: str) -> str:
    """Decode a ``data-url`` upload (or pasted raw PEM text) into PEM text."""
    value = (value or '').strip()
    if not value:
        return ''
    try:
        raw, _mime = decode_data_url(value)
        return raw.decode('utf-8')
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(f'tool_github: invalid GitHub App private key upload: {exc}') from exc


def _text(value) -> str:
    """A config value as stripped text; zero is a value, not an absent field."""
    return '' if value is None else str(value).strip()


# ==== Auth ===================================================================


def read_auth(cfg) -> dict:
    """Read the auth fields of the resolved config.

    ``cfg`` is the node's ``ConfigView``: the selected ``authType`` branch is
    flattened beside the options, so the other branch's leaves are absent and
    read as ``None``. Returns ``{'authType': 'pat', 'token': ...}`` or
    ``{'authType': 'app', 'appId': ..., 'privateKeyPem': ..., 'installationId': ...}``
    (installation ID ``''`` to find it per repository), plus
    ``'credentialMap': CredentialMap`` when one is set. With a map the node
    credential is optional: when given it serves the repositories no entry
    matches, and a map with its own ``*`` entry may not have one. Raises
    ``ValueError`` with a user-facing message on any missing or malformed field.
    """
    # The selector is validated by the schema: an unknown value never gets here.
    auth_type = cfg.authType

    credential_map = read_credential_map(cfg.get('credentialMap'))
    if credential_map is None:
        return _read_node_credential(cfg, auth_type)
    given = [name for name in _NODE_FIELDS[auth_type] if _text(cfg.get(name))]
    if not given:
        return {'authType': auth_type, 'credentialMap': credential_map}
    if credential_map.has_default:
        fields = ', '.join(given)
        raise ValueError(
            f'tool_github: credentialMap has a default entry and the node has its own credential ({fields}); '
            f'remove one of them: the default entry from credentialMap, or {fields} from the node settings'
        )
    return {**_read_node_credential(cfg, auth_type), 'credentialMap': credential_map}


def _read_node_credential(cfg, auth_type: str) -> dict:
    """The node's own credential: a PAT, or a GitHub App (installation ID optional)."""
    if auth_type == 'pat':
        token = _text(cfg.get('token'))
        if not token:
            raise ValueError('tool_github: token is required')
        # A line break inside a token would be refused by requests with the header value in
        # its error text; refuse it here, without the value.
        if any(char.isspace() for char in token):
            raise ValueError('tool_github: token must not contain spaces or line breaks')
        return {'authType': 'pat', 'token': token}

    return {'authType': 'app', **read_app(cfg.get('appId'), cfg.get('privateKey'), cfg.get('installationId'))}


def read_app(app_id, private_key, installation_id) -> dict:
    """Validate one GitHub App credential; the installation ID may be empty (found per repository)."""
    app_id = _text(app_id)
    private_key_pem = _decode_pem_blob(private_key)
    installation_id = _text(installation_id)
    missing = [name for name, value in (('App ID', app_id), ('private key', private_key_pem)) if not value]
    if missing:
        raise ValueError(f'tool_github: {", ".join(missing)} required for GitHub App auth')
    # GitHub also accepts a client ID as the JWT issuer, so retain nonnumeric IDs.
    if re.fullmatch(r'[+-]?[0-9]+', app_id) and int(app_id) <= 0:
        raise ValueError('tool_github: numeric App ID must be greater than zero for GitHub App auth')
    # The installation ID is a path segment of the token URL; only ASCII digits may reach it.
    if installation_id and not _INSTALLATION_ID_RE.fullmatch(installation_id):
        raise ValueError('tool_github: installation ID must be numeric for GitHub App auth')
    if installation_id and int(installation_id) <= 0:
        raise ValueError('tool_github: installation ID must be greater than zero for GitHub App auth')
    # Parse the PEM now so a malformed key surfaces at pipeline open, not on the first tool call.
    github_client.load_app_private_key(private_key_pem)
    return {
        'appId': app_id,
        'privateKeyPem': private_key_pem,
        'installationId': installation_id,
        'rawKey': private_key if isinstance(private_key, str) else '',
    }


# ==== credentialMap ==========================================================


def _entry_name(pattern: str) -> str:
    """Name a credentialMap entry in a message without the asterisk the engine splits error text on."""
    if pattern == '*':
        return 'the credentialMap default entry'
    owner, _, repo = pattern.partition('/')
    if repo == '*':
        return f'the credentialMap entry for owner {owner}'
    return f'the credentialMap entry for {pattern}'


def _check_filled(where: str, value: str, *, in_text: bool = False) -> None:
    """Refuse a placeholder no variable filled, printing only a variable name, never the value.

    ``in_text`` is set for values of a map given as JSON text: the pipeline's placeholders
    are resolved in one pass, so a placeholder inside a variable's own text stays as written.
    """
    found = _PLACEHOLDER_RE.search(value)
    if found is not None:
        name = '${' + found.group(1) + '}'
        if in_text:
            raise ValueError(
                f'tool_github: {where} still holds the placeholder {name}. Placeholders inside a credentialMap '
                'given as JSON text (one variable that holds the whole map) are not resolved, because the '
                "variable's own text is not scanned again; put literal values in that variable, or write the "
                'map as an object in the pipeline to use a placeholder per value'
            )
        how = 'is set to' if found.group(0) == value.strip() else 'uses the placeholder'
        raise ValueError(
            f'tool_github: {where} {how} {name}, but no variable of that name was found. Add it to '
            'the org, team or user environment variables; in a user-owned run your own variables apply'
        )
    if '${' in value:
        raise ValueError(
            f'tool_github: {where} has a "${{" that does not start a complete ${{ROCKETRIDE_<name>}} placeholder '
            '(only ROCKETRIDE_ variables resolve); check the braces and the variable name'
        )
    if '<REDACTED>' in value:
        raise ValueError(
            f'tool_github: {where} uses a variable whose name does not start with ROCKETRIDE_; '
            'only ROCKETRIDE_<name> variables resolve in a pipeline'
        )


def read_credential_map(raw):
    """Parse and validate ``credentialMap``; ``None`` when unset.

    The canvas form edits it as rows of ``credentialRepository`` and ``credentialValue``; a
    hand-written pipeline may write a JSON object of repository to credential instead, or
    JSON text of either form from a placeholder. Every key must be an exact ``owner/repo``,
    an owner entry or the default entry, and every value a token, the JSON text of an App
    credential (``appId``, ``privateKey``, optional ``installationId``) or, in a hand-written
    pipeline, that App credential as an object. Messages name a bad key by its position and
    a bad value by its entry, never the value, and never contain an asterisk.
    """
    if raw is None:
        return None
    in_text = isinstance(raw, str)
    if in_text:
        text = raw.strip()
        if not text:
            return None
        # The whole map is one placeholder that no variable filled.
        if _PLACEHOLDER_RE.fullmatch(text) or text == '<REDACTED>':
            _check_filled('credentialMap', text)
        try:
            # strict=False: a PEM's line breaks may stand in a string as they are.
            raw = json.loads(text, strict=False)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f'tool_github: credentialMap is not valid JSON (line {exc.lineno}, column {exc.colno})'
            ) from None
    if isinstance(raw, list):
        raw = _rows_to_map(raw)
    if not isinstance(raw, dict):
        raise ValueError(
            'tool_github: credentialMap must be a list of rows (credentialRepository and credentialValue) or a '
            'JSON object that maps repositories, owners or the default entry to credentials'
        )
    entries: dict = {}
    for position, (key, value) in enumerate(raw.items(), 1):
        pattern = credentials.map_key(key)
        if pattern is None:
            # By position: a value pasted where its key belongs must not be echoed.
            raise ValueError(
                f'tool_github: credentialMap key {position} is not a repository (owner/repo), an owner entry '
                '(the owner, a slash and an asterisk) or the default entry (a single asterisk)'
            )
        if pattern in entries:
            raise ValueError(f'tool_github: {_entry_name(pattern)} appears twice (keys are not case sensitive)')
        entries[pattern] = _map_credential(_entry_name(pattern), value, in_text=in_text)
    return credentials.CredentialMap(entries) if entries else None


_ROW_FIELDS = ('credentialRepository', 'credentialValue')


def _rows_to_map(rows: list) -> dict:
    """The canvas form's rows as the map; messages name a row by its position, never a value."""
    entries: dict = {}
    for position, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            raise ValueError(
                f'tool_github: credentialMap row {position} must be an object with credentialRepository and credentialValue'
            )
        unknown = sum(1 for name in row if name not in _ROW_FIELDS)
        if unknown:
            # Counted, not named: a token pasted as a field name must not be printed.
            raise ValueError(
                f'tool_github: credentialMap row {position} has {unknown} unknown field(s); only credentialRepository '
                'and credentialValue are allowed'
            )
        key = row.get('credentialRepository')
        value = row.get('credentialValue')
        if key is not None and not isinstance(key, str):
            raise ValueError(f'tool_github: credentialMap row {position}: credentialRepository must be text')
        if value is not None and not isinstance(value, (str, dict)):
            raise ValueError(
                f'tool_github: credentialMap row {position}: credentialValue must be text or an App credential object'
            )
        key = (key or '').strip()
        blank = value is None or (isinstance(value, str) and not value.strip())
        if not key and blank:
            continue  # a row the form added and nobody filled
        if not key:
            raise ValueError(f'tool_github: credentialMap row {position} has a credential but no repository')
        if blank:
            raise ValueError(f'tool_github: credentialMap row {position} has no credential')
        if credentials.map_key(key) is None:
            raise ValueError(
                f'tool_github: credentialMap row {position}: credentialRepository is not a repository (owner/repo), '
                'an owner entry (the owner, a slash and an asterisk) or the default entry (a single asterisk)'
            )
        if key in entries:
            raise ValueError(f'tool_github: credentialMap row {position} repeats the repository of an earlier row')
        entries[key] = value
    return entries


def _map_credential(where: str, value, *, in_text: bool = False):
    """One credentialMap value: a token, the JSON text of an App credential, or that object."""
    if isinstance(value, str):
        _check_filled(where, value, in_text=in_text)
        if value.lstrip().startswith('{'):
            # The JSON text of an App credential: the canvas form edits every value as text.
            try:
                value = json.loads(value, strict=False)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f'tool_github: {where} is not valid JSON (line {exc.lineno}, column {exc.colno})'
                ) from None
            if not isinstance(value, dict):
                raise ValueError(
                    f'tool_github: {where} must be a token or the JSON text of an object with appId, '
                    'privateKey and an optional installationId'
                )
            return _map_credential(where, value, in_text=in_text)
        token = value.strip()
        if not token or any(char.isspace() for char in token):
            raise ValueError(f'tool_github: {where} must be a non-empty token without spaces or line breaks')
        return credentials.PatCredential(token)
    if not isinstance(value, dict):
        raise ValueError(
            f'tool_github: {where} must be a token string or an object with appId, privateKey '
            'and an optional installationId'
        )
    unknown = sum(1 for name in value if name not in _APP_FIELDS)
    if unknown:
        # Counted, not named: a token pasted as a field name must not be printed.
        raise ValueError(
            f'tool_github: {where} has {unknown} unknown field(s); '
            'expected appId, privateKey and an optional installationId'
        )
    for name in sorted(_APP_FIELDS & set(value)):
        field = value[name]
        if field is None:
            continue
        # An App ID or installation ID may be written as a number; the key is text.
        allowed = (str,) if name == 'privateKey' else (str, int)
        if isinstance(field, bool) or not isinstance(field, allowed):
            kinds = 'a string' if name == 'privateKey' else 'a string or a number'
            raise ValueError(f'tool_github: {where}: {name} must be {kinds}')
        if isinstance(field, str):
            _check_filled(f'{where}: {name}', field, in_text=in_text)
    try:
        app = read_app(value.get('appId'), value.get('privateKey'), value.get('installationId'))
    except ValueError as exc:
        raise ValueError(f'tool_github: {where}: {str(exc).removeprefix("tool_github: ")}') from None
    return credentials.AppCredential(app['appId'], app['privateKeyPem'], app['installationId'], app['rawKey'])


# ==== Options ================================================================


def read_tools(raw) -> frozenset:
    """Parse the ``tools`` allowlist into a set of names; empty means every tool.

    The schema types the stored value as an array of the known names; this
    turns it into the set the instance publishes and fails closed on a list
    of blank entries. ``IInstance.validate_tool_names`` checks the names.
    """
    if raw is None:
        return frozenset()
    if not isinstance(raw, (list, tuple)) or not all(isinstance(name, str) for name in raw):
        raise ValueError('tool_github: tools must be a list of tool names')
    names = frozenset(name.strip() for name in raw if name.strip())
    if raw and not names:
        # Entries that are all blank are a mistake, not a request for every tool: fail closed.
        raise ValueError(
            'tool_github: tools has only blank entries; name the tools to publish, or leave tools empty to publish every tool'
        )
    return names


def read_options(cfg) -> dict:
    """Read the non-auth options of the resolved config (the scalars arrive typed and ranged)."""
    default_repo = _text(cfg.get('defaultRepo'))
    try:
        credentials.check_scope(default_repo, None)
    except github_client.CredentialError:
        raise ValueError('tool_github: defaultRepo must be a repository in owner/repo form') from None
    return {
        'defaultRepo': default_repo,
        'tools': read_tools(cfg.get('tools')),
        'graphqlAllowMutations': cfg.graphqlAllowMutations,
        'graphqlMaxResponseBytes': cfg.graphqlMaxResponseBytes,
        'rateLimitBudgetSeconds': cfg.rateLimitBudgetSeconds,
        'rateLimitMaxRetries': cfg.rateLimitMaxRetries,
    }
