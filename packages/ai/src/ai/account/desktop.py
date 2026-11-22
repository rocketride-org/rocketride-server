# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

# =============================================================================
# DESKTOP — the OSS per-user desktop list (plan 9.1, B41)
#
# One JSON document per user in the account layer's raw store, beside the
# deployment registry the OSS defaults already keep there:
#
#     orgs/<org_id>/files/.desktop/<user_id>.json
#     {"version": 1, "apps": ["rocketride.chat", "rocketride.dropper"]}
#
# A missing document means "never written": the account layer seeds it with
# the caller's reachable inventory on the first read, so an existing user's
# first sign-in after the upgrade shows the same desktop as before. The
# document is the whole list, rewritten on every change (a desktop is a few
# dozen ids at most); the raw store's atomic write keeps a failed write from
# leaving a torn file. SaaS keeps the same list in its ``app_desktop`` table.
# =============================================================================

import json
import re
from typing import List, Optional

from rocketlib import error

from .store import IStore, StorageNotFoundError

# Document format, for a future shape change (a reader that meets a newer
# version re-seeds). A published pipe's address rides the list as one more
# name beside the app ids; its kind is looked up, never stored (plan 9.1, G2).
DESKTOP_FORMAT_VERSION = 1

# An id that is safe as ONE path segment of the store key: no separators,
# no traversal, no empty name. User ids are 'local' on OSS and opaque
# identity-provider ids elsewhere; org ids are slugs or UUIDs.
_SAFE_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$')


def _checked_id(kind: str, value: str) -> str:
    """
    ``value`` when it is safe as a store path segment.

    Args:
        kind:  'org' or 'user' — names the rejected id in the error.
        value: The id to check.

    Returns:
        The id unchanged.

    Raises:
        ValueError: An empty id, one with a path separator, or one that starts
            with a dot (``..`` and hidden names) is refused before it reaches
            the store.
    """
    if not isinstance(value, str) or not _SAFE_ID.match(value):
        raise ValueError(f'Invalid {kind} id for the desktop store: {value!r}')
    return value


class FileDesktopBackend:
    """
    The per-user desktop list over the raw ``IStore`` (filesystem, S3, Azure).

    Reads answer ``None`` for a user who has no document yet — the caller
    decides what the first desktop holds (the account layer seeds it with the
    inventory). Writes replace the document whole.
    """

    def __init__(self, store: IStore):
        """
        Args:
            store: The raw store backend (``Store.instance().raw_store()``).
        """
        self._store = store

    @staticmethod
    def path(org_id: str, user_id: str) -> str:
        """
        The store key of a user's desktop document.

        Args:
            org_id:  The organization the desktop belongs to ('local' on OSS).
            user_id: The user ('local' on OSS).

        Returns:
            ``orgs/<org_id>/files/.desktop/<user_id>.json``.
        """
        return f'orgs/{_checked_id("org", org_id)}/files/.desktop/{_checked_id("user", user_id)}.json'

    async def read(self, org_id: str, user_id: str) -> Optional[List[str]]:
        """
        The stored desktop app ids, in stored order.

        Args:
            org_id:  The organization.
            user_id: The user.

        Returns:
            The list of app ids, or ``None`` when no document exists yet. A
            corrupt or newer-format document also reads as ``None`` (logged),
            so the caller re-seeds instead of serving an empty desktop.
        """
        try:
            text = await self._store.read_file(self.path(org_id, user_id))
        except StorageNotFoundError:
            return None
        try:
            data = json.loads(text)
            if not isinstance(data, dict) or data.get('version') != DESKTOP_FORMAT_VERSION:
                raise ValueError(
                    f'unsupported desktop document version {data.get("version") if isinstance(data, dict) else data!r}'
                )
            apps = data.get('apps')
            if not isinstance(apps, list) or not all(isinstance(a, str) for a in apps):
                raise ValueError('desktop document "apps" is not a list of ids')
        except (ValueError, TypeError) as exc:
            error(f'desktop: corrupt document for {org_id}/{user_id}: {exc}')
            return None
        # Stored order, duplicates folded (a hand-edited file may repeat an id).
        return list(dict.fromkeys(apps))

    async def write(self, org_id: str, user_id: str, app_ids: List[str]) -> None:
        """
        Replace the user's desktop document.

        Args:
            org_id:  The organization.
            user_id: The user.
            app_ids: The complete desktop, in order; duplicates are folded.
        """
        payload = {'version': DESKTOP_FORMAT_VERSION, 'apps': list(dict.fromkeys(app_ids))}
        await self._store.write_file(self.path(org_id, user_id), json.dumps(payload, indent=2) + '\n')
