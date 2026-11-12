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

Reads the resolved node config: the selected auth branch (PAT or GitHub App),
an optional credentialMap, default_repo, the read_only flag, the tool allowlist,
the GraphQL response cap and the rate-limit retry policy. The schema validates
the scalars; ``node_config`` keeps the semantic checks it cannot express and
``IValidator`` runs the same readers at save time. Which credential serves a
call, and the installation tokens it mints, live in ``credentials``.
"""

from __future__ import annotations

from rocketlib import IGlobalBase

from . import credentials, github_client, node_config
from .IInstance import validate_tool_names


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
        # The resolved config: the active authType branch flattened beside the
        # options, every scalar typed and ranged by the schema
        cfg = self.config
        self.read_only = cfg.readOnly

        options = node_config.read_options(cfg)
        self.default_repo = options['defaultRepo']
        self.tools = validate_tool_names(options['tools'])
        self.graphql_max_bytes = options['graphqlMaxResponseBytes']
        self.graphql_allow_mutations = options['graphqlAllowMutations']
        self.retry_policy = github_client.RetryPolicy(
            budget_seconds=options['rateLimitBudgetSeconds'],
            max_retries=options['rateLimitMaxRetries'],
        )

        auth = node_config.read_auth(cfg)
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
