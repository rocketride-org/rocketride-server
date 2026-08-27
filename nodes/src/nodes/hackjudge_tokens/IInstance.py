"""Per-request logic for hackjudge_tokens: the token gate + settle (Blueprint Rev 2).

One node, two pipeline positions. The gate's first job is continuity, not
blocking: check the balance against a threshold; when low, trigger the
auto-recharge; halt only when recharge fails or is not configured. Settlement
deducts what a run actually consumed (KB processed), after the work.

JSON job on the questions lane -> JSON result on the answers lane:

  gate    {op, tenant_id}                       -> {ok, allow, balance_kb, recharged?}
  settle  {op, tenant_id, run_id?, kb_processed} -> {ok, balance_kb, clamped?}
  credit  {op, tenant_id, kb, kind?}            -> {ok, balance_kb}
  config  {op, tenant_id, threshold_kb?, refill_to_kb?, auto_recharge?} -> {ok}
  balance {op, tenant_id}                       -> {ok, balance}

STRIPE PLACEHOLDER: _stripe_recharge() below simulates a successful Stripe
auto-recharge (credits up to refill_to_kb). At deployment it is replaced by the
real Stripe trigger + confirmation; the gate's contract does not change.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from decimal import Decimal

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


def _num(value) -> float:
    if isinstance(value, Decimal):
        return float(value)
    return float(value or 0)


def _stripe_recharge(cur, tenant_id: str, balance_kb: float, refill_to_kb: float) -> float:
    """PLACEHOLDER for the Stripe auto-recharge trigger.

    Simulates Stripe validating and executing the recharge: credits the balance
    up to refill_to_kb and writes a ledger row (kind='recharge'). The real
    integration replaces the body of this function only: trigger Stripe, await
    confirmation, then apply the credited amount.
    """
    credit = round(refill_to_kb - balance_kb, 2)
    if credit <= 0:
        return 0.0
    cur.execute(
        'UPDATE balances SET balance_kb = %s, updated_at = now() WHERE tenant_id = %s',
        (refill_to_kb, tenant_id),
    )
    cur.execute(
        "INSERT INTO usage_events (id, tenant_id, kind, kb_processed) VALUES (%s, %s, 'recharge', %s)",
        (uuid.uuid4().hex, tenant_id, credit),
    )
    return credit


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeQuestions(self, question: Question) -> None:
        if self.IGlobal.db is None:
            raise RuntimeError('hackjudge_tokens: database not initialized')

        raw = _job_text(question)
        if not raw:
            raise ValueError('hackjudge_tokens: empty job (expected a JSON body)')
        try:
            job = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(f'hackjudge_tokens: job is not valid JSON: {e}') from e

        if str(job.get('flow') or '') == 'verify' and not str(job.get('op') or '').strip():
            self._stage_flow(question, job)
            return

        op = str(job.get('op') or '').strip().lower()
        handler = getattr(self, '_op_' + op, None) if op else None
        if handler is None:
            result = {'ok': False, 'error': f'unknown op: {job.get("op")}'}
        elif not str(job.get('tenant_id') or '').strip():
            result = {'ok': False, 'error': 'tenant_id is required'}
        else:
            try:
                result = handler(job)
            except Exception as e:  # noqa: BLE001 - fail as a structured result, not a dead lane
                result = {'ok': False, 'error': f'tokens error: {type(e).__name__}: {e}'}
        self._emit(question, result)

    # ---- ops -----------------------------------------------------------------

    def _op_gate(self, job: dict) -> dict:
        """Rev 2 gate: healthy -> allow; low -> trigger recharge, re-validate;
        halt only when recharge fails or is not configured and the balance is empty.
        """
        tenant = job['tenant_id']

        def tx(cur):
            cur.execute(
                'SELECT balance_kb, threshold_kb, refill_to_kb, auto_recharge'
                ' FROM balances WHERE tenant_id = %s FOR UPDATE',
                (tenant,),
            )
            row = cur.fetchone()
            if not row:
                return {
                    'ok': True,
                    'allow': False,
                    'balance_kb': 0.0,
                    'reason': 'no balance configured for this account',
                }
            balance = _num(row['balance_kb'])
            threshold = _num(row['threshold_kb'])
            refill_to = _num(row['refill_to_kb'])
            recharged = 0.0

            if balance <= threshold and row['auto_recharge'] and refill_to > balance:
                recharged = _stripe_recharge(cur, tenant, balance, refill_to)
                balance += recharged

            if balance <= 0:
                return {
                    'ok': True,
                    'allow': False,
                    'balance_kb': balance,
                    'reason': 'balance is empty and auto-recharge is off or failed',
                }
            out = {'ok': True, 'allow': True, 'balance_kb': balance}
            if recharged:
                out['recharged_kb'] = recharged
            if balance <= threshold:
                out['low'] = True
            return out

        return self.IGlobal.db.run(tx)

    def _op_settle(self, job: dict) -> dict:
        """Deduct actual consumption after a run; the balance never goes negative
        (a shortfall is clamped to zero and reported, matching prepaid-only).
        """
        tenant = job['tenant_id']
        try:
            kb = float(job.get('kb_processed') or 0)
        except (TypeError, ValueError):
            return {'ok': False, 'error': 'kb_processed must be a number'}
        if kb < 0:
            return {'ok': False, 'error': 'kb_processed must be >= 0'}

        def tx(cur):
            cur.execute('SELECT balance_kb FROM balances WHERE tenant_id = %s FOR UPDATE', (tenant,))
            row = cur.fetchone()
            if not row:
                return {'ok': False, 'error': 'no balance configured for this account'}
            balance = _num(row['balance_kb'])
            new_balance = round(balance - kb, 2)
            clamped = new_balance < 0
            if clamped:
                new_balance = 0.0
            cur.execute(
                'UPDATE balances SET balance_kb = %s, updated_at = now() WHERE tenant_id = %s',
                (new_balance, tenant),
            )
            cur.execute(
                'INSERT INTO usage_events (id, tenant_id, run_id, kind, kb_processed) VALUES (%s, %s, %s, %s, %s)',
                (uuid.uuid4().hex, tenant, job.get('run_id'), str(job.get('kind') or 'verify')[:40], kb),
            )
            out = {'ok': True, 'balance_kb': new_balance}
            if clamped:
                out['clamped'] = True
            return out

        return self.IGlobal.db.run(tx)

    def _op_credit(self, job: dict) -> dict:
        """Add prepaid balance (top-up). The Stripe webhook lands here later."""
        tenant = job['tenant_id']
        try:
            kb = float(job.get('kb') or 0)
        except (TypeError, ValueError):
            return {'ok': False, 'error': 'kb must be a number'}
        if kb <= 0:
            return {'ok': False, 'error': 'kb must be > 0'}

        def tx(cur):
            cur.execute(
                'INSERT INTO balances (tenant_id, balance_kb, updated_at)'
                ' VALUES (%s, %s, now())'
                ' ON CONFLICT (tenant_id) DO UPDATE'
                ' SET balance_kb = balances.balance_kb + %s, updated_at = now()',
                (tenant, kb, kb),
            )
            cur.execute(
                'INSERT INTO usage_events (id, tenant_id, kind, kb_processed) VALUES (%s, %s, %s, %s)',
                (uuid.uuid4().hex, tenant, str(job.get('kind') or 'credit')[:40], kb),
            )
            cur.execute('SELECT balance_kb FROM balances WHERE tenant_id = %s', (tenant,))
            return {'ok': True, 'balance_kb': _num(cur.fetchone()['balance_kb'])}

        return self.IGlobal.db.run(tx)

    def _op_config(self, job: dict) -> dict:
        """Set the gate parameters: threshold, refill target, auto-recharge flag."""
        tenant = job['tenant_id']
        sets, vals = [], []
        for col in ('threshold_kb', 'refill_to_kb'):
            if job.get(col) is not None:
                try:
                    vals.append(float(job[col]))
                except (TypeError, ValueError):
                    return {'ok': False, 'error': f'{col} must be a number'}
                sets.append(f'{col} = %s')
        if job.get('auto_recharge') is not None:
            sets.append('auto_recharge = %s')
            vals.append(bool(job['auto_recharge']))
        if not sets:
            return {'ok': False, 'error': 'nothing to configure'}

        def tx(cur):
            cur.execute('INSERT INTO balances (tenant_id) VALUES (%s) ON CONFLICT DO NOTHING', (tenant,))
            cur.execute(
                f'UPDATE balances SET {", ".join(sets)}, updated_at = now()'  # noqa: S608
                ' WHERE tenant_id = %s',
                (*vals, tenant),
            )

        self.IGlobal.db.run(tx)
        return {'ok': True}

    def _op_balance(self, job: dict) -> dict:
        tenant = job['tenant_id']

        def q(cur):
            cur.execute('SELECT * FROM balances WHERE tenant_id = %s', (tenant,))
            return cur.fetchone()

        row = self.IGlobal.db.run(q)
        if not row:
            return {
                'ok': True,
                'balance': {
                    'tenant_id': tenant,
                    'balance_kb': 0.0,
                    'threshold_kb': 0.0,
                    'refill_to_kb': 0.0,
                    'auto_recharge': False,
                },
            }
        out = {}
        for k, v in dict(row).items():
            if isinstance(v, Decimal):
                out[k] = float(v)
            elif isinstance(v, datetime):
                out[k] = v.isoformat()
            else:
                out[k] = v
        return {'ok': True, 'balance': out}

    # ---- verify-flow stages (full-pipeline wiring) ----------------------------

    def _stage_flow(self, question: Question, job: dict) -> None:
        """Gate or settle, selected by the envelope address and this instance's role."""
        role = getattr(self.IGlobal, 'role', 'auto')
        nxt = str(job.get('next') or '')
        if role in ('gate', 'settle') and nxt != role:
            return  # not addressed to this instance; lane delivery is broadcast-like
        if role == 'auto' and nxt not in ('', 'gate', 'settle'):
            return
        auth = job.get('auth') or {}
        tenant = str(auth.get('tenant_id') or '')
        if not tenant:
            self._emit(question, {'ok': False, 'stage': 'tokens', 'error': 'missing auth in envelope'})
            return
        do_settle = nxt == 'settle' or (not nxt and 'verdict' in job)
        if not do_settle:
            res = self._op_gate({'tenant_id': tenant})
            if not (res.get('ok') and res.get('allow')):
                self._emit(question, {**res, 'ok': False, 'stage': 'gate'})
                return
            job['gate'] = {k: res[k] for k in ('balance_kb', 'recharged_kb', 'low') if k in res}
            job['next'] = 'engine'
            self._forward(question, job)
            return
        verdict = job.get('verdict') or {}
        kb = float(verdict.get('kb_processed') or 0)
        run_id = (job.get('persisted') or {}).get('run_id')
        res = self._op_settle({'tenant_id': tenant, 'run_id': run_id, 'kb_processed': kb})
        billing = {'kb_processed': kb, 'balance_kb': res.get('balance_kb')}
        if res.get('clamped'):
            billing['clamped'] = True
        if (job.get('gate') or {}).get('recharged_kb'):
            billing['recharged_kb'] = job['gate']['recharged_kb']
        final = {'ok': bool(res.get('ok')), 'verdict': verdict, 'run_id': run_id, 'billing': billing}
        if not res.get('ok'):
            final['error'] = res.get('error')
        self._emit(question, final)

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
