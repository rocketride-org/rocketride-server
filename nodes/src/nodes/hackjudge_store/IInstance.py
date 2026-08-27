"""Per-request logic for hackjudge_store: Hack Judge's tenant-scoped system of record.

JSON job on the questions lane -> JSON result on the answers lane. Every op takes
tenant_id (resolved upstream by hackjudge_account.validate) and every query is
tenant-scoped in SQL; cross-tenant ids come back as 'not found', matching the
isolation rule the Hack Judge app enforces today.

Ops:
  targets.list / targets.create / targets.update / targets.delete
  runs.create / runs.finish / runs.list / runs.get
  results.append
  balance.get
  usage.append   (raw ledger row; settlement itself is the token nodes' job)
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


def _plain(value):
    """Make a DB value JSON-serializable (datetimes -> iso, Decimal -> float)."""
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def _row(record) -> dict:
    return {k: _plain(v) for k, v in dict(record).items()}


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeQuestions(self, question: Question) -> None:
        if self.IGlobal.db is None:
            raise RuntimeError('hackjudge_store: database not initialized')

        raw = _job_text(question)
        if not raw:
            raise ValueError('hackjudge_store: empty job (expected a JSON body)')
        try:
            job = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(f'hackjudge_store: job is not valid JSON: {e}') from e

        if str(job.get('flow') or '') == 'verify' and not str(job.get('op') or '').strip():
            self._stage_flow(question, job)
            return

        op = str(job.get('op') or '').strip().lower().replace('.', '_')
        handler = getattr(self, '_op_' + op, None) if op else None
        if handler is None:
            result = {'ok': False, 'error': f'unknown op: {job.get("op")}'}
        elif not str(job.get('tenant_id') or '').strip():
            result = {'ok': False, 'error': 'tenant_id is required'}
        else:
            try:
                result = handler(job)
            except Exception as e:  # noqa: BLE001 - fail as a structured result, not a dead lane
                result = {'ok': False, 'error': f'store error: {type(e).__name__}: {e}'}
        self._emit(question, result)

    # ---- targets -------------------------------------------------------------

    def _op_targets_list(self, job: dict) -> dict:
        tenant = job['tenant_id']

        def q(cur):
            cur.execute(
                'SELECT id, slug, name, config, is_preset, created_at, updated_at'
                ' FROM targets WHERE tenant_id = %s ORDER BY created_at',
                (tenant,),
            )
            return [_row(r) for r in cur.fetchall()]

        return {'ok': True, 'targets': self.IGlobal.db.run(q)}

    def _op_targets_create(self, job: dict) -> dict:
        import psycopg2

        tenant = job['tenant_id']
        slug = str(job.get('slug') or '').strip().lower()
        name = str(job.get('name') or '').strip()
        config = job.get('config') or {}
        if not slug or not name:
            return {'ok': False, 'error': 'slug and name are required'}
        tid = uuid.uuid4().hex

        def tx(cur):
            import psycopg2.extras

            cur.execute(
                'INSERT INTO targets (id, tenant_id, slug, name, config, is_preset,'
                ' created_at, updated_at)'
                ' VALUES (%s, %s, %s, %s, %s, FALSE, now(), now())',
                (tid, tenant, slug, name, psycopg2.extras.Json(config)),
            )

        try:
            self.IGlobal.db.run(tx)
        except psycopg2.IntegrityError:
            return {'ok': False, 'error': f'a target with slug "{slug}" already exists'}
        return {'ok': True, 'id': tid}

    def _op_targets_update(self, job: dict) -> dict:
        tenant, tid = job['tenant_id'], str(job.get('id') or '')
        name = str(job.get('name') or '').strip()
        config = job.get('config')

        def tx(cur):
            import psycopg2.extras

            cur.execute('SELECT is_preset FROM targets WHERE id = %s AND tenant_id = %s', (tid, tenant))
            row = cur.fetchone()
            if not row:
                return {'ok': False, 'error': 'target not found'}
            if row['is_preset']:
                return {'ok': False, 'error': 'the preset target is read-only'}
            if name:
                cur.execute('UPDATE targets SET name = %s WHERE id = %s', (name, tid))
            if config is not None:
                cur.execute(
                    'UPDATE targets SET config = %s WHERE id = %s',
                    (psycopg2.extras.Json(config), tid),
                )
            cur.execute('UPDATE targets SET updated_at = now() WHERE id = %s', (tid,))
            return None

        import psycopg2  # noqa: F401 - psycopg2.extras used inside tx

        err = self.IGlobal.db.run(tx)
        return err if err else {'ok': True}

    def _op_targets_delete(self, job: dict) -> dict:
        tenant, tid = job['tenant_id'], str(job.get('id') or '')

        def tx(cur):
            cur.execute('SELECT is_preset FROM targets WHERE id = %s AND tenant_id = %s', (tid, tenant))
            row = cur.fetchone()
            if not row:
                return {'ok': False, 'error': 'target not found'}
            if row['is_preset']:
                return {'ok': False, 'error': 'the preset target cannot be deleted'}
            cur.execute('DELETE FROM targets WHERE id = %s', (tid,))
            return None

        err = self.IGlobal.db.run(tx)
        return err if err else {'ok': True}

    # ---- runs & results ------------------------------------------------------

    def _op_runs_create(self, job: dict) -> dict:
        tenant = job['tenant_id']
        rid = uuid.uuid4().hex

        def tx(cur):
            cur.execute(
                'INSERT INTO runs (id, tenant_id, target_id, name, event_date,'
                ' history_penalty, status, total, created_at)'
                " VALUES (%s, %s, %s, %s, %s, %s, 'running', %s, now())",
                (
                    rid,
                    tenant,
                    job.get('target_id'),
                    str(job.get('name') or 'Run'),
                    job.get('event_date'),
                    float(job.get('history_penalty') or 0),
                    job.get('total'),
                ),
            )

        self.IGlobal.db.run(tx)
        return {'ok': True, 'id': rid}

    def _op_runs_finish(self, job: dict) -> dict:
        tenant, rid = job['tenant_id'], str(job.get('id') or '')
        status = str(job.get('status') or 'done')

        def tx(cur):
            import psycopg2.extras

            cur.execute(
                'UPDATE runs SET status = %s, summary = %s, finished_at = now() WHERE id = %s AND tenant_id = %s',
                (status, psycopg2.extras.Json(job.get('summary') or {}), rid, tenant),
            )
            return cur.rowcount

        n = self.IGlobal.db.run(tx)
        return {'ok': True} if n else {'ok': False, 'error': 'run not found'}

    def _op_runs_list(self, job: dict) -> dict:
        tenant = job['tenant_id']
        limit = min(int(job.get('limit') or 50), 200)

        def q(cur):
            cur.execute(
                'SELECT r.id, r.name, r.event_date, r.status, r.total, r.created_at,'
                ' r.finished_at, r.target_id,'
                ' (SELECT count(*) FROM results x WHERE x.run_id = r.id) AS done_count,'
                " (SELECT count(*) FROM results x WHERE x.run_id = r.id AND x.tag = 'Significant')"
                '   AS significant_count,'
                ' (SELECT count(*) FROM results x WHERE x.run_id = r.id AND x.flagged)'
                '   AS flagged_count'
                ' FROM runs r WHERE r.tenant_id = %s ORDER BY r.created_at DESC LIMIT %s',
                (tenant, limit),
            )
            return [_row(r) for r in cur.fetchall()]

        return {'ok': True, 'runs': self.IGlobal.db.run(q)}

    def _op_runs_get(self, job: dict) -> dict:
        tenant, rid = job['tenant_id'], str(job.get('id') or '')

        def q(cur):
            cur.execute('SELECT * FROM runs WHERE id = %s AND tenant_id = %s', (rid, tenant))
            run = cur.fetchone()
            if not run:
                return None
            cur.execute('SELECT payload FROM results WHERE run_id = %s ORDER BY created_at', (rid,))
            return {'run': _row(run), 'results': [r['payload'] for r in cur.fetchall()]}

        got = self.IGlobal.db.run(q)
        if got is None:
            return {'ok': False, 'error': 'run not found'}
        return {'ok': True, **got}

    def _op_results_append(self, job: dict) -> dict:
        tenant, rid = job['tenant_id'], str(job.get('run_id') or '')
        payload = job.get('payload') or {}

        def tx(cur):
            import psycopg2.extras

            cur.execute('SELECT 1 FROM runs WHERE id = %s AND tenant_id = %s', (rid, tenant))
            if not cur.fetchone():
                return {'ok': False, 'error': 'run not found'}
            cur.execute(
                'INSERT INTO results (id, run_id, project, github, tag, backbone, score,'
                ' flagged, payload, created_at)'
                ' VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, now())',
                (
                    uuid.uuid4().hex,
                    rid,
                    str(payload.get('project') or '')[:300],
                    str(payload.get('github') or '')[:500],
                    str(payload.get('tag') or '')[:40],
                    str(payload.get('backbone') or '')[:20],
                    payload.get('score'),
                    bool(payload.get('flagged') or payload.get('project_predates')),
                    psycopg2.extras.Json(payload),
                ),
            )
            return None

        err = self.IGlobal.db.run(tx)
        return err if err else {'ok': True}

    # ---- balance & usage -----------------------------------------------------

    def _op_balance_get(self, job: dict) -> dict:
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
                    'auto_recharge': False,
                },
            }
        return {'ok': True, 'balance': _row(row)}

    def _op_usage_append(self, job: dict) -> dict:
        tenant = job['tenant_id']
        try:
            kb = float(job.get('kb_processed') or 0)
        except (TypeError, ValueError):
            return {'ok': False, 'error': 'kb_processed must be a number'}
        if kb < 0:
            return {'ok': False, 'error': 'kb_processed must be >= 0'}

        def tx(cur):
            cur.execute(
                'INSERT INTO usage_events (id, tenant_id, run_id, kind, kb_processed) VALUES (%s, %s, %s, %s, %s)',
                (
                    uuid.uuid4().hex,
                    tenant,
                    job.get('run_id'),
                    str(job.get('kind') or 'verify')[:40],
                    kb,
                ),
            )

        self.IGlobal.db.run(tx)
        return {'ok': True}

    # ---- emit ----------------------------------------------------------------

    # ---- verify-flow stage (full-pipeline wiring) -----------------------------

    def _stage_flow(self, question: Question, job: dict) -> None:
        """Persist the verdict from the envelope into a run, then pass it on."""
        if str(job.get('next') or 'store') != 'store':
            return  # not addressed to this stage; lane delivery is broadcast-like
        auth = job.get('auth') or {}
        tenant = str(auth.get('tenant_id') or '')
        verdict = job.get('verdict')
        if not tenant or verdict is None:
            self._emit(question, {'ok': False, 'stage': 'store', 'error': 'missing auth or verdict in envelope'})
            return
        run_id = str(job.get('run_id') or '')
        if not run_id:
            res = self._op_runs_create(
                {
                    'tenant_id': tenant,
                    'name': str(job.get('run_name') or 'Pipeline verify'),
                    'event_date': job.get('event_date'),
                    'history_penalty': job.get('history_penalty'),
                    'total': 1,
                }
            )
            if not res.get('ok'):
                self._emit(question, {**res, 'stage': 'store'})
                return
            run_id = res['id']
        res = self._op_results_append({'tenant_id': tenant, 'run_id': run_id, 'payload': verdict})
        if not res.get('ok'):
            self._emit(question, {**res, 'stage': 'store'})
            return
        self._op_runs_finish({'tenant_id': tenant, 'id': run_id, 'summary': {'tags': {str(verdict.get('tag')): 1}}})
        job['persisted'] = {'run_id': run_id}
        job['next'] = 'settle'
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
