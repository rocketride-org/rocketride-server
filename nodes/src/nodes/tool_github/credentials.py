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
Which credential serves a tool call, and the installation tokens it mints.

A call is served by the node credential (a token, or a GitHub App) or, when
``credentialMap`` is set, by the entry that most specifically matches the call's
repository: the exact ``owner/repo``, then ``owner/*``, then ``*``. A GitHub App
without an installation ID finds the installation per repository with
``GET /repos/{owner}/{repo}/installation`` and the App JWT, and caches it for the run.
Each installation's token is cached and refreshed ``REFRESH_SKEW_SECONDS`` before it
expires; every map entry keeps its own caches.
"""

from __future__ import annotations

import re
import threading
import time
from typing import Callable

from rocketlib import warning

from . import github_client, repository_reads
from .github_client import CredentialError

# Refresh an installation token this many seconds before its actual expiry, so
# an in-flight request never races a token that dies mid-call.
REFRESH_SKEW_SECONDS = 60
# After a failed early refresh, wait this long before asking GitHub again, so parallel
# tool calls do not queue behind a hanging token request while the cached token is valid.
REFRESH_RETRY_SECONDS = 15
# Installation tokens a slot keeps for redaction after it replaces or drops them; a run
# mints about one per installation per hour, so this covers days of tokens still in flight.
MINTED_KEPT = 64

_KEY_RE = re.compile(r'\*|[A-Za-z0-9_.-]+/(?:\*|[A-Za-z0-9_.-]+)')

NO_REPOSITORY = (
    'This call names no repository, so the GitHub App installation cannot be found from one. '
    'Pass repo where the tool takes it, set defaultRepo, or set installationId (on the node or on '
    'the credentialMap entry).'
)
# Organization tools name an organization, not a repository, and the node does not look
# installations up by organization.
NO_ORGANIZATION_INSTALLATION = (
    'This call names an organization, not a repository, and the GitHub App installation is found '
    'from a repository. Set installationId on the node, or on the credentialMap entry this '
    'organization matches.'
)
BAD_REPOSITORY = (
    'The repository is not in owner/repo form (one slash, no empty or dot-only parts), so no '
    'credential was chosen for it.'
)
BAD_OWNER = 'The organization is not a plain owner name, so no credential was chosen for it.'
_OWNER_RE = re.compile(r'[A-Za-z0-9_.-]+')


def check_scope(repo: str | None, owner: str | None) -> None:
    """Refuse a repository that is not exactly owner/repo, or an owner that is not a plain name.

    Called before the repository chooses a credential, so ``acme/app/`` or ``/acme/app``
    cannot fall through to a less specific credentialMap entry. The messages never repeat
    the value.
    """
    if repo:
        try:
            repository_reads.repository_path(repo.strip())
        except ValueError:
            raise CredentialError(BAD_REPOSITORY) from None
    elif owner is not None:
        name = owner.strip()
        if not _OWNER_RE.fullmatch(name) or name in ('.', '..'):
            raise CredentialError(BAD_OWNER)


def finds_installations(credential) -> bool:
    """Whether ``credential`` is a GitHub App that finds its installation per repository."""
    return isinstance(credential, AppCredential) and not credential.installation_id


def map_key(key) -> str | None:
    """Normalise a credentialMap key (``owner/repo``, ``owner/*`` or ``*``); ``None`` when it is none of them.

    GitHub owner and repository names are not case sensitive, so keys are lowercased.
    """
    if not isinstance(key, str):
        return None
    key = key.strip()
    if not _KEY_RE.fullmatch(key) or any(part in ('.', '..') for part in key.split('/')):
        return None
    return key.lower()


class _TokenSlot:
    """One installation's token: cached, refreshed early, kept through a failed early refresh.

    ``minted`` holds every token the slot has minted (the last ``MINTED_KEPT``): neither a
    refresh nor a drop removes one, since a request sent with it may still be in flight and
    its answer must still be redacted. It is replaced, never changed in place, so readers
    need no lock.
    """

    def __init__(self) -> None:
        self.token = ''
        self.minted: tuple[str, ...] = ()
        self.expiry = 0.0
        self.failed_at = 0.0
        self.lock = threading.Lock()

    def get(self, mint: Callable[[], tuple[str, float]]) -> str:
        with self.lock:
            now = time.time()
            still_valid = bool(self.token) and now < self.expiry
            needs_refresh = not still_valid or now >= self.expiry - REFRESH_SKEW_SECONDS
            backing_off = still_valid and now < self.failed_at + REFRESH_RETRY_SECONDS
            if needs_refresh and not backing_off:
                try:
                    token, expiry = mint()
                except Exception:
                    # Re-read the clock: the request may have hung for DEFAULT_TIMEOUT.
                    # A failed early refresh must not discard a token GitHub still accepts.
                    failed_at = time.time()
                    if not self.token or failed_at >= self.expiry:
                        raise
                    self.failed_at = failed_at
                    warning('tool_github: token refresh failed; using the cached token until it expires')
                else:
                    if token not in self.minted:
                        self.minted = (*self.minted, token)[-MINTED_KEPT:]
                    self.token, self.expiry = token, expiry
            return self.token

    def drop(self, token: str) -> bool:
        """Forget ``token`` (GitHub answered 401 to it); True when this slot minted it.

        Several calls in flight can carry the same revoked token. The first to see the
        401 clears the slot; the others find a fresh token already cached (or mint one)
        and are retried too, so each of them answers True. The slot is cleared only
        while ``token`` is still its current token.
        """
        with self.lock:
            if not token or token not in self.minted:
                return False
            if self.token == token:
                # The token stays in ``minted``: a request sent with it may still be answered.
                self.token, self.expiry, self.failed_at = '', 0.0, 0.0
            return True


class PatCredential:
    """A token used as given (a personal access token, or any token GitHub accepts as Bearer)."""

    kind = 'pat'

    def __init__(self, token: str) -> None:
        self._token = token

    def token(self, repo: str | None = None, *, owner: str | None = None) -> str:
        return self._token

    def drop(self, token: str) -> bool:
        # A token used as given cannot be replaced by the node.
        return False

    def installation_of(self, token: str) -> str | None:
        return None

    def installation_for(self, repo: str | None = None) -> str:
        raise CredentialError('This call uses a token, not a GitHub App, so it has no installation.')

    def jwt(self) -> str:
        raise CredentialError('This call uses a token, not a GitHub App, so it has no App JWT.')

    def secrets(self) -> tuple[str, ...]:
        return (self._token,)


class AppCredential:
    """A GitHub App: a fixed installation, or one found per repository, with a token cache per installation."""

    kind = 'app'

    def __init__(self, app_id: str, private_key_pem: str, installation_id: str = '', raw_key: str = '') -> None:
        self.app_id = app_id
        self.private_key_pem = private_key_pem
        self.installation_id = installation_id
        # The key as configured (a data URL upload, say) is a secret too.
        self._raw_key = raw_key
        self._installations: dict[str, str] = {}
        self._slots: dict[str, _TokenSlot] = {}
        self._lock = threading.Lock()

    def installation_for(self, repo: str | None = None, *, owner: str | None = None) -> str:
        """The configured installation, or the one found for ``repo`` (cached for the run)."""
        return self._installation(repo, owner)[0]

    def _installation(self, repo: str | None, owner: str | None = None) -> tuple[str, bool]:
        """The installation for ``repo``, and whether it came from the cache."""
        if self.installation_id:
            return self.installation_id, False
        if not repo:
            raise CredentialError(NO_ORGANIZATION_INSTALLATION if owner else NO_REPOSITORY)
        check_scope(repo, None)
        repo = repo.strip()
        key = repo.lower()
        with self._lock:
            found = self._installations.get(key)
        if found is not None:
            return found, True
        # Not under the lock: a slow lookup must not hold up calls for other repositories.
        # Two calls racing for one repository both look it up, which is harmless.
        found = github_client.find_repo_installation(self.app_id, self.private_key_pem, repo)
        with self._lock:
            self._installations[key] = found
        return found, False

    def token(self, repo: str | None = None, *, owner: str | None = None) -> str:
        """A token for ``repo``; a cached installation GitHub no longer knows is looked up once more."""
        installation, cached = self._installation(repo, owner)
        repo = (repo or '').strip()
        try:
            return self._mint_for(installation)
        except github_client.GitHubAPIError as exc:
            # A configured installation is the user's to fix; keep GitHub's error.
            if exc.status_code != 404 or self.installation_id:
                raise
        # GitHub has no such installation any more (the App was reinstalled, or the
        # repository moved to another account): forget it and, if it was cached, look again once.
        self._forget(repo)
        if cached:
            installation, _ = self._installation(repo)
            try:
                return self._mint_for(installation)
            except github_client.GitHubAPIError as exc:
                if exc.status_code != 404:
                    raise
            self._forget(repo)
        raise CredentialError(
            f'GitHub no longer has the GitHub App installation found for {repo} (HTTP 404 on the token request). '
            'Install the App on the repository again, or check where it moved.'
        )

    def _mint_for(self, installation: str) -> str:
        with self._lock:
            slot = self._slots.get(installation)
            if slot is None:
                slot = self._slots[installation] = _TokenSlot()
        return slot.get(lambda: github_client.mint_installation_token(self.app_id, self.private_key_pem, installation))

    def _forget(self, repo: str) -> None:
        with self._lock:
            self._installations.pop(repo.lower(), None)

    def jwt(self) -> str:
        return github_client.sign_app_jwt(self.app_id, self.private_key_pem)

    def drop(self, token: str) -> bool:
        """Forget a cached installation token GitHub answered 401 to (an App uninstall revokes them)."""
        with self._lock:
            slots = list(self._slots.values())
        return any(slot.drop(token) for slot in slots)

    def installation_of(self, token: str) -> str | None:
        """The installation that minted ``token``, or None when none of this App's slots did."""
        with self._lock:
            slots = list(self._slots.items())
        return next((installation for installation, slot in slots if token in slot.minted), None)

    def secrets(self) -> tuple[str, ...]:
        with self._lock:
            slots = list(self._slots.values())
        tokens = (token for slot in slots for token in slot.minted)
        return (self.private_key_pem, self._raw_key, *tokens)


class CredentialMap:
    """credentialMap entries by normalised key; the most specific match for a call wins."""

    def __init__(self, entries: dict) -> None:
        self._entries = entries

    @property
    def has_default(self) -> bool:
        return '*' in self._entries

    def match(self, repo: str | None = None, owner: str | None = None, *, default=None):
        """The entry for ``repo`` (exact, then ``owner/*``, then ``*``), or for ``owner`` without a repo.

        ``default`` (the node's own credential) serves a call no entry matches. Without
        one, raises ``CredentialError`` naming the repository or owner, never the map or its keys.
        """
        # No asterisk in these messages: the engine splits error text on it.
        if repo:
            name = repo.strip()
            first = name.split('/', 1)[0]
            keys = (name.lower(), f'{first.lower()}/*', '*')
            missing = f'{name}: the map has no entry for {name}, none for the owner {first}, and no default entry'
        elif owner:
            name = owner.strip()
            keys = (f'{name.lower()}/*', '*')
            missing = f'the owner {name}: the map has no entry for that owner and no default entry'
        else:
            keys = ('*',)
            missing = (
                'a call without a repository: the map has no default entry. Give the call a repository '
                '(repo, or defaultRepo), or add a default entry'
            )
        for key in keys:
            credential = self._entries.get(key)
            if credential is not None:
                return credential
        if default is not None:
            return default
        raise CredentialError(f'No credentialMap entry matches {missing}.')

    def secrets(self) -> tuple[str, ...]:
        return tuple(secret for credential in self._entries.values() for secret in credential.secrets())
