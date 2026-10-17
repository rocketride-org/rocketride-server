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

"""TEST-ONLY stand-in for the SaaS ``extension.saas`` account.

THIS IS A PROXY. It does not exercise the real SaaS authorizer (membership
tables, ``decide_db_access``, the audit log). It exists so ONE real hosted
engine (``--saas``) can serve two synthetic organisations and the engine's own
database logic - target authorization before issuance, the broker call, the
per-task DSN map, the child's environment, restart - can be driven end to end.
What it proves is therefore about the ENGINE; what the real authorizer decides
is proven (or not) by the SaaS repository's own tests.

* identities: two API keys map to two organisations, each with a team and a
  user (``key-orga`` -> ``org-aaa``, ``key-orgb`` -> ``org-bbb``);
* ``own-org`` mode (default): ``authorize_db_target`` OVERRIDES the permissive
  AccountBase default and allows the caller's OWN organisation database only;
  team and user databases are denied;
* ``inherit-default`` mode: does NOT override it, so a hosted engine's refusal
  of the single-tenant permissive default can be exercised;
* every authorization the engine asks for is appended to ``RR2203_AUTH_LOG``
  (JSON lines, no secrets) so tests can count and inspect them.
"""

import json
import os

from ai.account.base import DbDecision
from ai.account.oss import Account as _OssAccount

IDENTITIES = {
    'key-orga': ('org-aaa', 'team-aaa', 'user-aaa'),
    'key-orgb': ('org-bbb', 'team-bbb', 'user-bbb'),
    # A caller whose session carries no organisation at all (a malformed identity).
    'key-noorg': ('', 'team-zzz', 'user-zzz'),
}
MODE = os.environ.get('RR2203_STANDIN_MODE', 'own-org')
AUTH_LOG = os.environ.get('RR2203_AUTH_LOG', '')
CONTROL = os.environ.get('RR2203_CONTROL', '')


def _quirk() -> str:
    """A deliberately wrong answer for the next authorizations, switched by a test through a control file.

    ``org-with-owner``  allows the org database but names an owner (an org database has none)
    ``raises``          the authorizer itself fails
    ``deny-org``        denies the org database
    """
    if not CONTROL:
        return ''
    try:
        with open(CONTROL, encoding='utf-8') as f:
            return json.load(f).get('quirk', '')
    except (OSError, ValueError):
        return ''


class _Identities(_OssAccount):
    capabilities = ('oss',)

    async def authenticate(self, credential: str):
        info = await super().authenticate(credential)
        if isinstance(info, tuple) or credential not in IDENTITIES:
            return info
        org, team, user = IDENTITIES[credential]
        organization = dict(info.organization)
        organization['id'] = org
        organization['teams'] = [dict(organization['teams'][0], id=team)]
        info.organization = organization
        info.devTeam = team
        info.userId = user
        return info


class _OwnOrgOnly(_Identities):
    async def authorize_db_target(self, identity, target=None):
        scope = (target or {}).get('scope', 'org')
        org_id = (identity or {}).get('org_id') or ''
        quirk = _quirk()
        if quirk == 'raises':
            raise RuntimeError('stand-in authorizer failure')
        if quirk == 'org-with-owner' and scope == 'org':
            decision = DbDecision(True, 'standin_quirk', True, 'team-aaa')
        elif quirk == 'deny-org' and scope == 'org':
            decision = DbDecision(False, 'standin_quirk_denied')
        elif scope == 'org' and org_id in {org for org, _, _ in IDENTITIES.values() if org}:
            decision = DbDecision(True, 'standin_own_org', True, '')
        else:
            decision = DbDecision(False, f'standin_denies_{scope}_database')
        if AUTH_LOG:
            record = {
                'org_id': org_id,
                'user_id': (identity or {}).get('user_id', ''),
                'team_id': (identity or {}).get('team_id', ''),
                'task_id': (identity or {}).get('task_id', ''),
                'scope': scope,
                'allowed': decision.allowed,
                'reason': decision.reason,
            }
            with open(AUTH_LOG, 'a', encoding='utf-8') as log:
                log.write(json.dumps(record) + '\n')
        return decision


Account = _OwnOrgOnly if MODE == 'own-org' else _Identities
