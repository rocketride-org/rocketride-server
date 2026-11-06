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
GitHub tool node - global (shared) state.

Reads auth config (PAT, GitHub App, or a credentialMap), default_repo, the
read_only flag, the tool allowlist, the GraphQL response cap and the rate-limit
retry policy from config, all validated at pipeline start. Which credential
serves a call, and the installation tokens it mints, live in ``credentials``.
"""

from __future__ import annotations

import json
import re

from ai.common.config import Config
from ai.common.utils import decode_data_url
from rocketlib import IGlobalBase, OPEN_MODE, warning

from . import credentials, github_client
from .IInstance import validate_tool_names

AUTH_TYPES = ('pat', 'app')
_INSTALLATION_ID_RE = re.compile(r'[0-9]+')
# A ${ROCKETRIDE_<name>} placeholder that no variable filled stays in the text as written.
# Only such a complete placeholder is named in a message; any other "${" is refused
# without printing what follows it, which may be the rest of the map, tokens included.
_PLACEHOLDER_RE = re.compile(r'\$\{(ROCKETRIDE_[A-Za-z0-9_]{1,120})\}')
# Text a message may repeat back: a plain identifier, never an arbitrary value.
_IDENTIFIER_RE = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,63}')
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


def _read_auth(cfg) -> dict:
    """Parse and validate the auth fields of a node config.

    Returns ``{'authType': 'pat', 'token': ...}`` or ``{'authType': 'app', 'appId': ...,
    'privateKeyPem': ..., 'installationId': ...}`` (installation ID ``''`` to find it per
    repository), plus ``'credentialMap': CredentialMap`` when one is set. With a map the
    node credential is optional: when given it serves the repositories no entry matches,
    and a map with its own ``*`` entry may not have one. Raises ``ValueError`` with a
    user-facing message on any missing or malformed field; ``beginGlobal`` and
    ``validateConfig`` share it so they can never disagree. No message holds a credential.
    """
    auth_type = str(cfg.get('authType') or 'pat').strip()
    if auth_type not in AUTH_TYPES:
        # Repeated back only when it is a plain name: the engine splits error text on '*'.
        shown = f' {auth_type!r}' if _IDENTIFIER_RE.fullmatch(auth_type) else ''
        raise ValueError(f'tool_github: unknown authType{shown}; expected "pat" or "app"')

    credential_map = _read_credential_map(cfg.get('credentialMap'))
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
        token = str(cfg.get('token') or '').strip()
        if not token:
            raise ValueError('tool_github: token is required')
        # A line break inside a token would be refused by requests with the header value in
        # its error text; refuse it here, without the value.
        if any(char.isspace() for char in token):
            raise ValueError('tool_github: token must not contain spaces or line breaks')
        return {'authType': 'pat', 'token': token}

    return {'authType': 'app', **_read_app(cfg.get('appId'), cfg.get('privateKey'), cfg.get('installationId'))}


def _text(value) -> str:
    """A config value as stripped text; zero is a value, not an absent field."""
    return '' if value is None else str(value).strip()


def _read_app(app_id, private_key, installation_id) -> dict:
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


def _read_credential_map(raw):
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
        app = _read_app(value.get('appId'), value.get('privateKey'), value.get('installationId'))
    except ValueError as exc:
        raise ValueError(f'tool_github: {where}: {str(exc).removeprefix("tool_github: ")}') from None
    return credentials.AppCredential(app['appId'], app['privateKeyPem'], app['installationId'], app['rawKey'])


# (config key, default, minimum, maximum) for the integer options.
_GRAPHQL_MAX_BYTES = ('graphqlMaxResponseBytes', github_client.DEFAULT_GRAPHQL_MAX_BYTES, 1024, 100 * 1024 * 1024)
# The call blocks for the whole wait, so the budget is capped at ten minutes.
_RETRY_BUDGET = ('rateLimitBudgetSeconds', github_client.DEFAULT_RETRY_BUDGET_SECONDS, 0, 600)
_MAX_RETRIES = ('rateLimitMaxRetries', github_client.DEFAULT_MAX_RETRIES, 0, 10)


def _read_int(cfg, option: tuple) -> int:
    """Read an integer option; blank means the default, anything else out of range fails."""
    key, default, minimum, maximum = option
    raw = cfg.get(key)
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return default
    value = None
    if isinstance(raw, int) and not isinstance(raw, bool):
        value = raw
    elif isinstance(raw, float) and raw.is_integer():
        value = int(raw)
    elif isinstance(raw, str) and raw.strip().isdecimal():
        value = int(raw.strip())
    if value is None or not minimum <= value <= maximum:
        raise ValueError(f'tool_github: {key} must be an integer from {minimum} to {maximum}')
    return value


def _read_flag(cfg, key: str, default: bool = False) -> bool:
    """Read a yes-or-no option; blank means the default, and the strings true and false are accepted."""
    raw = cfg.get(key)
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return default
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str) and raw.strip().lower() in ('true', 'false'):
        return raw.strip().lower() == 'true'
    raise ValueError(f'tool_github: {key} must be true or false')


def _read_tools(raw) -> frozenset:
    """Parse the ``tools`` allowlist into a set of names; empty means every tool.

    Only the shape is checked here; ``validate_tool_names`` checks the names.
    """
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return frozenset()
    if isinstance(raw, str):
        raw = raw.split(',')
    if not isinstance(raw, (list, tuple)) or not all(isinstance(name, str) for name in raw):
        raise ValueError('tool_github: tools must be a list of tool names')
    names = frozenset(name.strip() for name in raw if name.strip())
    if raw and not names:
        # Entries that are all blank are a mistake, not a request for every tool: fail closed.
        raise ValueError(
            'tool_github: tools has only blank entries; name the tools to publish, or leave tools empty to publish every tool'
        )
    return names


def _read_options(cfg) -> dict:
    """Parse the non-auth options; ``beginGlobal`` and ``validateConfig`` share it."""
    default_repo = _text(cfg.get('defaultRepo'))
    try:
        credentials.check_scope(default_repo, None)
    except github_client.CredentialError:
        raise ValueError('tool_github: defaultRepo must be a repository in owner/repo form') from None
    return {
        'defaultRepo': default_repo,
        'tools': validate_tool_names(_read_tools(cfg.get('tools'))),
        'graphqlAllowMutations': _read_flag(cfg, 'graphqlAllowMutations'),
        'graphqlMaxResponseBytes': _read_int(cfg, _GRAPHQL_MAX_BYTES),
        'rateLimitBudgetSeconds': _read_int(cfg, _RETRY_BUDGET),
        'rateLimitMaxRetries': _read_int(cfg, _MAX_RETRIES),
    }


class IGlobal(IGlobalBase):
    """Global state for tool_github."""

    # The configured authType field only. The node never reads it to serve a call: a
    # credentialMap can serve calls with the other kind, so every tool asks auth_type_for(repo).
    auth_type: str = 'pat'
    token: str = ''
    app_id: str = ''
    private_key_pem: str = ''
    installation_id: str = ''
    default_repo: str = ''
    read_only: bool = False
    tools: frozenset = frozenset()
    graphql_max_bytes: int = github_client.DEFAULT_GRAPHQL_MAX_BYTES
    graphql_allow_mutations: bool = False
    retry_policy: github_client.RetryPolicy = github_client.RetryPolicy()
    credential_map: credentials.CredentialMap | None = None

    # The node credential: a PatCredential or an AppCredential. With a credentialMap it is
    # the map's default (or None when the node has none of its own).
    _credential = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.read_only = bool(cfg.get('readOnly', False))

        options = _read_options(cfg)
        self.default_repo = options['defaultRepo']
        self.tools = options['tools']
        self.graphql_max_bytes = options['graphqlMaxResponseBytes']
        self.graphql_allow_mutations = options['graphqlAllowMutations']
        self.retry_policy = github_client.RetryPolicy(
            budget_seconds=options['rateLimitBudgetSeconds'],
            max_retries=options['rateLimitMaxRetries'],
        )

        auth = _read_auth(cfg)
        self.auth_type = auth['authType']
        self.credential_map = auth.get('credentialMap')
        self._credential = None
        if 'appId' in auth:
            self.app_id = auth['appId']
            self.private_key_pem = auth['privateKeyPem']
            self.installation_id = auth['installationId']
            self._credential = credentials.AppCredential(
                self.app_id, self.private_key_pem, self.installation_id, auth['rawKey']
            )
        elif 'token' in auth:
            self.token = auth['token']
            self._credential = credentials.PatCredential(self.token)

    def validateConfig(self) -> None:
        for read in (_read_auth, _read_options):
            try:
                read(Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig))
            except Exception as e:
                warning(str(e))

    def endGlobal(self) -> None:
        self.auth_type = 'pat'
        self.token = ''
        self.app_id = ''
        self.private_key_pem = ''
        self.installation_id = ''
        self.default_repo = ''
        self.read_only = False
        self.tools = frozenset()
        self.graphql_max_bytes = github_client.DEFAULT_GRAPHQL_MAX_BYTES
        self.graphql_allow_mutations = False
        self.retry_policy = github_client.RetryPolicy()
        self.credential_map = None
        self._credential = None
        # The compiled redaction patterns are keyed by the secret sets they were built from;
        # a reused engine process must not keep this pipeline's credentials in that cache.
        github_client._secret_pattern.cache_clear()

    # -----------------------------------------------------------------------
    # Per-call credentials. ``repo`` is the call's repository; ``owner`` is used
    # by organization tools, which have none. Each raises CredentialError, whose
    # message names the repository and never a credential, when nothing serves
    # the call.
    # -----------------------------------------------------------------------

    def _serving(self, repo: str | None, owner: str | None):
        """The credential for a call: the credentialMap's best match, else the node credential.

        When the repository chooses the credential (a map, or a GitHub App that finds its
        installation per repository), a repository that is not exactly ``owner/repo`` is
        refused, so a malformed name can never fall through to a less specific entry.
        """
        if self.credential_map is not None or credentials.finds_installations(self._credential):
            credentials.check_scope(repo, owner)
        if self.credential_map is not None:
            return self.credential_map.match(repo, owner, default=self._credential)
        return self._credential

    def get_token(self, repo: str | None = None, *, owner: str | None = None) -> str:
        """A token for a call on ``repo`` (or ``owner``): the PAT, or a cached or freshly minted installation token."""
        return self._serving(repo, owner).token(repo, owner=owner)

    def drop_token(self, token: str, repo: str | None = None, *, owner: str | None = None) -> bool:
        """Forget ``token`` after GitHub answered 401 to it; True when it was a cached installation token."""
        return self._serving(repo, owner).drop(token)

    def auth_type_for(self, repo: str | None = None, *, owner: str | None = None) -> str:
        """``'pat'`` or ``'app'``: the kind of credential that serves a call on ``repo``."""
        return self._serving(repo, owner).kind

    def app_jwt(self, repo: str | None = None) -> str:
        """A fresh App JWT for the GitHub App that serves ``repo`` (``GET /app`` takes no installation token)."""
        return self._serving(repo, None).jwt()

    def installation_id_for(self, repo: str | None = None) -> str:
        """The installation whose token serves ``repo``: the configured one, or the one found for it."""
        return self._serving(repo, None).installation_for(repo)

    def installation_of(self, token: str, repo: str | None = None) -> str | None:
        """The installation that minted ``token`` among the credentials serving ``repo``, if any."""
        return self._serving(repo, None).installation_of(token)

    def secrets(self) -> tuple[str, ...]:
        """Every credential the node holds or has minted, for redaction: tokens, keys, installation tokens."""
        found = [self.token, self.private_key_pem]
        for holder in (self._credential, self.credential_map):
            if holder is not None:
                found.extend(holder.secrets())
        return tuple(dict.fromkeys(secret for secret in found if secret))
