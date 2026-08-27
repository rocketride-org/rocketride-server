"""Per-request logic for hackjudge_account: marketplace identity -> app tenant.

Identity itself is the platform's job: a marketplace app declares
``authenticated: true`` in its manifest and the platform hands it the
signed-in user (see the app owner runbook). No passwords, no sessions, no
per-app OAuth live here. What the pipeline still needs, and what this node
does, is resolve that platform identity to the app's own tenant + tier and
stamp it into the verify-flow envelope, short-circuiting requests that
arrive without one.

JSON job on the questions lane -> JSON result on the answers lane:

  resolve  {op, platform_org_id, platform_user_id, org_name?, name?, email?}
           -> {ok, tenant_id, user_id, tier, company}
  profile.get    {op, platform_org_id, platform_user_id}        -> {ok, profile}
  profile.update {op, platform_org_id, platform_user_id, name?, company?} -> {ok}

First sight of a platform org creates the tenant (with its balances row);
first sight of a platform user creates the user row. Tier lives on the
tenant and is owned by entitlement (app_subscriptions -> tier), not by
this node.
"""

from __future__ import annotations

import json
import uuid

from ai.common.schema import Answer, Question
from rocketlib import IInstanceBase

from .IGlobal import IGlobal


def _job_text(question: Question) -> str:
    """Pull the raw job string out of a question envelope (mirrors hackjudge_engine)."""
    parts = []
    if hasattr(question, 'questions'):
        for item in getattr(question, 'questions') or []:
            text = str(getattr(item, 'text', None) or item).strip()
            if text:
                parts.append(text)
    if not parts and hasattr(question, 'text'):
        text = str(getattr(question, 'text', None) or '').strip()
        if text:
            parts.append(text)
    return '\n'.join(parts).strip()


def _external_id(platform_user_id: str, platform_org_id: str) -> str:
    """App-side user key. Scoped per org so one person in two orgs is two
    app users (each org is a separate tenant with its own data and balance).
    """
    return f'mp:{platform_user_id}@{platform_org_id}'


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeQuestions(self, question: Question) -> None:
        if self.IGlobal.db is None:
            raise RuntimeError('hackjudge_account: database not initialized')

        raw = _job_text(question)
        if not raw:
            raise ValueError('hackjudge_account: empty job (expected a JSON body)')
        try:
            job = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(f'hackjudge_account: job is not valid JSON: {e}') from e

        if str(job.get('flow') or '') == 'verify' and not str(job.get('op') or '').strip():
            self._stage_flow(question, job)
            return

        op = str(job.get('op') or '').strip().lower().replace('.', '_')
        handler = getattr(self, '_op_' + op, None) if op else None
        if handler is None:
            result = {'ok': False, 'error': f'unknown op: {job.get("op")}'}
        else:
            try:
                result = handler(job)
            except Exception as e:  # noqa: BLE001 - fail as a structured result, not a dead lane
                result = {'ok': False, 'error': f'account error: {type(e).__name__}: {e}'}
        self._emit(question, result)

    # ---- ops -----------------------------------------------------------------

    def _op_resolve(self, job: dict) -> dict:
        row = self._resolve(job)
        if isinstance(row, dict) and row.get('ok') is False:
            return row
        return {
            'ok': True,
            'tenant_id': row['tenant_id'],
            'user_id': row['user_id'],
            'tier': row['tier'],
            'company': row['company'],
        }

    def _op_profile_get(self, job: dict) -> dict:
        row = self._resolve(job)
        if isinstance(row, dict) and row.get('ok') is False:
            return row
        return {
            'ok': True,
            'profile': {
                'email': row['email'],
                'name': row['name'],
                'company': row['company'],
                'tier': row['tier'],
            },
        }

    def _op_profile_update(self, job: dict) -> dict:
        row = self._resolve(job)
        if isinstance(row, dict) and row.get('ok') is False:
            return row
        name = str(job.get('name') or '').strip()
        company = str(job.get('company') or '').strip()
        if not name and not company:
            return {'ok': False, 'error': 'nothing to update'}

        def tx(cur):
            if name:
                cur.execute('UPDATE users SET name = %s WHERE id = %s', (name, row['user_id']))
            if company:
                cur.execute('UPDATE tenants SET name = %s WHERE id = %s', (company, row['tenant_id']))

        self.IGlobal.db.run(tx)
        return {'ok': True}

    # ---- helpers -------------------------------------------------------------

    def _resolve(self, job: dict):
        """Map platform identity to the app tenant/user, creating both on first
        sight. Validation runs before any DB work.
        """
        org = str(job.get('platform_org_id') or '').strip()
        user = str(job.get('platform_user_id') or '').strip()
        if not org or not user:
            return {'ok': False, 'error': 'platform identity is required (platform_org_id and platform_user_id)'}
        name = str(job.get('name') or '').strip() or 'Member'
        email = str(job.get('email') or '').strip().lower()
        org_name = str(job.get('org_name') or '').strip() or f'Org {org[:8]}'
        ext = _external_id(user, org)
        new_tenant_id, new_user_id = uuid.uuid4().hex, uuid.uuid4().hex

        def tx(cur):
            # first-sight creation is insert-first with ON CONFLICT + re-select,
            # so two concurrent requests for a new org/user converge on one row
            # instead of racing SELECT-then-INSERT (needs the unique indexes in
            # schema.sql on tenants.marketplace_org_id and users.external_id)
            cur.execute(
                'INSERT INTO tenants (id, name, marketplace_org_id, created_at)'
                ' VALUES (%s, %s, %s, now()) ON CONFLICT (marketplace_org_id) DO NOTHING',
                (new_tenant_id, org_name, org),
            )
            cur.execute('SELECT id, tier, name FROM tenants WHERE marketplace_org_id = %s', (org,))
            t = cur.fetchone()
            cur.execute(
                'INSERT INTO balances (tenant_id) VALUES (%s) ON CONFLICT DO NOTHING',
                (t['id'],),
            )
            cur.execute(
                'INSERT INTO users (id, external_id, tenant_id, name, email, role,'
                " is_active, created_at) VALUES (%s, %s, %s, %s, %s, 'member', TRUE, now())"
                ' ON CONFLICT (external_id) DO NOTHING',
                (new_user_id, ext, t['id'], name, email),
            )
            cur.execute('SELECT id, is_active, name, email FROM users WHERE external_id = %s', (ext,))
            u = cur.fetchone()
            if not u['is_active']:
                return {'ok': False, 'error': 'account is deactivated'}
            return {
                'tenant_id': t['id'],
                'user_id': u['id'],
                'tier': t['tier'] or 'developer',
                'company': t['name'],
                'name': u['name'],
                'email': u['email'],
            }

        return self.IGlobal.db.run(tx)

    # ---- verify-flow stage (full-pipeline wiring) -----------------------------

    def _stage_flow(self, question: Question, job: dict) -> None:
        """Pipeline stage: resolve platform identity to a tenant and enrich the envelope."""
        if str(job.get('next') or 'account') != 'account':
            return  # not addressed to this stage; lane delivery is broadcast-like
        row = self._resolve(job)
        if isinstance(row, dict) and row.get('ok') is False:
            self._emit(question, {**row, 'stage': 'account'})
            return
        job['auth'] = {
            'tenant_id': row['tenant_id'],
            'user_id': row['user_id'],
            'tier': row['tier'],
        }
        job['next'] = 'gate'
        self._forward(question, job)

    def _forward(self, question: Question, job: dict) -> None:
        """Send the enriched flow envelope to the downstream questions listener."""
        payload = json.dumps(job)
        fwd = None
        try:
            fwd = Question()
            fwd.addQuestion(payload)
        except Exception:  # noqa: BLE001 - schema differences: mutate the inbound envelope instead
            fwd = None
        if fwd is None:
            items = getattr(question, 'questions', None) or []
            if items:
                try:
                    items[0].text = payload
                except Exception:  # noqa: BLE001
                    question.text = payload
            fwd = question
        self.instance.writeQuestions(fwd)

    def _emit(self, question: Question, result: dict) -> None:
        body = json.dumps(result)
        if self.instance.hasListener('answers'):
            answer = Answer(expectJson=getattr(question, 'expectJson', False))
            answer.setAnswer(body)
            self.instance.writeAnswers(answer)
        if self.instance.hasListener('text'):
            self.instance.writeText(body)
