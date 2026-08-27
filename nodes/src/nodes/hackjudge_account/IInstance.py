"""Per-request logic for hackjudge_account: app-owned authentication.

The app owns its user accounts (no marketplace accounts for app users).
JSON job on the questions lane -> JSON result on the answers lane:

  signup   {op, email, password, company, name?} -> {ok, session_token, tenant_id, user_id}
  signin   {op, email, password}                 -> {ok, session_token, tenant_id, user_id}
  validate {op, session_token}                   -> {ok, tenant_id, user_id, email, name, company, tier}
  signout  {op, session_token}                   -> {ok}
  profile.get    {op, session_token}             -> {ok, profile}
  profile.update {op, session_token, name?, company?} -> {ok}

Passwords: hashlib.scrypt (stdlib, no external hash dependency).
Sessions: secrets token returned once; only its SHA-256 hash is stored,
TTL-expired and revocable by row delete (DB-backed, not JWT, so a B2B
account can kill a session instantly). Phase 1: one user per tenant.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from ai.common.schema import Answer, Question
from rocketlib import IInstanceBase

from .IGlobal import IGlobal

_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 16384, 8, 1


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


def _hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode('utf-8'), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P)
    return f'scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${digest.hex()}'


def _verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_hex, digest_hex = str(stored or '').split('$')
        if algo != 'scrypt':
            return False
        digest = hashlib.scrypt(password.encode('utf-8'), salt=bytes.fromhex(salt_hex), n=int(n), r=int(r), p=int(p))
        return secrets.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


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

    def _op_signup(self, job: dict) -> dict:
        email = str(job.get('email') or '').strip().lower()
        password = str(job.get('password') or '')
        company = str(job.get('company') or '').strip()
        name = str(job.get('name') or '').strip() or email.split('@')[0]
        if '@' not in email or '.' not in email.split('@')[-1]:
            return {'ok': False, 'error': 'a valid email is required'}
        if len(password) < 8:
            return {'ok': False, 'error': 'password must be at least 8 characters'}
        if not company:
            return {'ok': False, 'error': 'company name is required'}

        pw = _hash_password(password)
        tenant_id, user_id = uuid.uuid4().hex, uuid.uuid4().hex

        def tx(cur):
            cur.execute(
                'SELECT id FROM users WHERE lower(email) = %s AND password_hash IS NOT NULL',
                (email,),
            )
            if cur.fetchone():
                return {'ok': False, 'error': 'an account with this email already exists'}
            cur.execute(
                'INSERT INTO tenants (id, name, created_at) VALUES (%s, %s, now())',
                (tenant_id, company),
            )
            cur.execute(
                'INSERT INTO users (id, external_id, tenant_id, name, email, role,'
                ' password_hash, is_active, created_at)'
                ' VALUES (%s, %s, %s, %s, %s, %s, %s, TRUE, now())',
                (user_id, 'app:' + email, tenant_id, name, email, 'admin', pw),
            )
            cur.execute(
                'INSERT INTO balances (tenant_id) VALUES (%s) ON CONFLICT DO NOTHING',
                (tenant_id,),
            )
            return None

        err = self.IGlobal.db.run(tx)
        if err:
            return err
        return self._create_session(user_id, tenant_id)

    def _op_signin(self, job: dict) -> dict:
        email = str(job.get('email') or '').strip().lower()
        password = str(job.get('password') or '')

        def q(cur):
            cur.execute(
                'SELECT id, tenant_id, password_hash, is_active FROM users'
                ' WHERE lower(email) = %s AND password_hash IS NOT NULL',
                (email,),
            )
            return cur.fetchone()

        row = self.IGlobal.db.run(q)
        if not row or not row['is_active'] or not _verify_password(password, row['password_hash']):
            return {'ok': False, 'error': 'invalid email or password'}
        return self._create_session(row['id'], row['tenant_id'])

    def _op_validate(self, job: dict) -> dict:
        row = self._session_row(job)
        if isinstance(row, dict) and row.get('ok') is False:
            return row
        return {
            'ok': True,
            'tenant_id': row['tenant_id'],
            'user_id': row['user_id'],
            'email': row['email'],
            'name': row['name'],
            'company': row['company'],
            'tier': row['tier'] or 'developer',
        }

    def _op_signout(self, job: dict) -> dict:
        token = str(job.get('session_token') or '')
        if not token:
            return {'ok': False, 'error': 'session_token is required'}
        th = _token_hash(token)

        def tx(cur):
            cur.execute('DELETE FROM sessions WHERE token_hash = %s', (th,))
            return cur.rowcount

        self.IGlobal.db.run(tx)
        return {'ok': True}

    def _op_profile_get(self, job: dict) -> dict:
        row = self._session_row(job)
        if isinstance(row, dict) and row.get('ok') is False:
            return row
        return {
            'ok': True,
            'profile': {
                'email': row['email'],
                'name': row['name'],
                'company': row['company'],
                'tier': row['tier'] or 'developer',
            },
        }

    def _op_profile_update(self, job: dict) -> dict:
        row = self._session_row(job)
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

    def _session_row(self, job: dict):
        """Resolve a session_token to its user/tenant row, or an error result."""
        token = str(job.get('session_token') or '')
        if not token:
            return {'ok': False, 'error': 'session_token is required'}
        th = _token_hash(token)

        def q(cur):
            cur.execute(
                'SELECT s.user_id, s.tenant_id, s.expires_at, u.email, u.name, u.is_active,'
                ' t.tier, t.name AS company'
                ' FROM sessions s'
                ' JOIN users u ON u.id = s.user_id'
                ' JOIN tenants t ON t.id = s.tenant_id'
                ' WHERE s.token_hash = %s',
                (th,),
            )
            return cur.fetchone()

        row = self.IGlobal.db.run(q)
        if not row or not row['is_active']:
            return {'ok': False, 'error': 'invalid session'}
        if row['expires_at'] <= datetime.now(timezone.utc):
            return {'ok': False, 'error': 'session expired'}
        return row

    def _create_session(self, user_id: str, tenant_id: str) -> dict:
        token = secrets.token_urlsafe(32)
        expires = datetime.now(timezone.utc) + timedelta(hours=self.IGlobal.session_ttl_hours)
        sid = uuid.uuid4().hex

        def tx(cur):
            cur.execute(
                'INSERT INTO sessions (id, token_hash, user_id, tenant_id, expires_at) VALUES (%s, %s, %s, %s, %s)',
                (sid, _token_hash(token), user_id, tenant_id, expires),
            )

        self.IGlobal.db.run(tx)
        return {
            'ok': True,
            'session_token': token,
            'tenant_id': tenant_id,
            'user_id': user_id,
            'expires_at': expires.isoformat(),
        }

    # ---- verify-flow stage (full-pipeline wiring) -----------------------------

    def _stage_flow(self, question: Question, job: dict) -> None:
        """Pipeline stage: resolve the session to a tenant and enrich the envelope."""
        if str(job.get('next') or 'account') != 'account':
            return  # not addressed to this stage; lane delivery is broadcast-like
        row = self._session_row(job)
        if isinstance(row, dict) and row.get('ok') is False:
            self._emit(question, {**row, 'stage': 'account'})
            return
        job['auth'] = {
            'tenant_id': row['tenant_id'],
            'user_id': row['user_id'],
            'tier': row['tier'] or 'developer',
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
