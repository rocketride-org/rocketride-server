"""Per-request logic for hackjudge_engine.

Consumes a JSON job on the questions lane and emits the deterministic verdict on
the answers lane. Mirrors the deterministic half of the Hack Judge verify path
(gather -> evaluate -> det_note -> evidence_lines); the LLM prose stays a separate
llm_anthropic node downstream.
"""

from __future__ import annotations

import json

from ai.common.schema import Answer, Question
from rocketlib import IInstanceBase

from .IGlobal import IGlobal


def _job_text(question: Question) -> str:
    """Pull the raw job string out of a question envelope (mirrors search_exa)."""
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


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeQuestions(self, question: Question) -> None:
        engine = self.IGlobal.engine
        target_mod = self.IGlobal.target_mod
        fetch = self.IGlobal.fetch
        if engine is None or fetch is None:
            raise RuntimeError('hackjudge_engine: engine not initialized')

        raw = _job_text(question)
        if not raw:
            raise ValueError('hackjudge_engine: empty job (expected a JSON body)')
        try:
            job = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(f'hackjudge_engine: job is not valid JSON: {e}') from e
        if str(job.get('flow') or '') == 'verify' and str(job.get('next') or 'engine') != 'engine':
            return  # not addressed to this stage; lane delivery is broadcast-like

        url = str(job.get('repo_url') or job.get('github') or '').strip()
        if not url:
            raise ValueError('hackjudge_engine: job.repo_url is required')
        event_date = job.get('event_date')
        history_penalty = job.get('history_penalty', 0) or 0
        cfg = job.get('target_config')

        # None target => the legacy RocketRide-preset path (identical to the app's
        # fallback when no custom target is selected).
        target = None
        tname = 'RocketRide'
        if cfg:
            tname = str(job.get('target_name') or cfg.get('name') or 'Target')
            target = target_mod.Target.from_ui_config(tname, cfg)

        pr = fetch.parse_repo(url)
        project = str(job.get('project') or (pr[1] if pr else '') or '(unnamed)')

        result = self._verdict(engine, fetch, url, target, tname, event_date, history_penalty, project)
        is_flow = str(job.get('flow') or '') == 'verify'
        if result.get('deferred'):
            # a deferred repo must never continue down the verify flow: nothing to
            # persist, nothing to settle - the caller retries the repository
            self._emit(question, {**result, 'stage': 'engine'} if is_flow else result)
            return
        if is_flow and self.instance.hasListener('questions'):
            job['verdict'] = result
            job['next'] = 'store'
            self._forward(question, job)
        else:
            self._emit(question, result)

    def _verdict(self, engine, fetch, url, target, tname, event_date, history_penalty, project):
        if fetch.repo_missing(url):
            return {
                'project': project,
                'github': url,
                'repo_accessible': False,
                'tag': 'None',
                'backbone': 'No',
                'score': 0.0,
                'error': 'repository not found or not public',
                'target_name': tname,
                'engine_used': 'rocketride-node',
            }

        # meter the run: count every byte fetched (Rev 2 bills on KB processed)
        meter = {'chars': 0}

        def gh_metered(u):
            status, text = fetch._gh(u)
            if text:
                meter['chars'] += len(text)
            return status, text

        evidence = engine.gather(url, gh_metered, event_date, history_penalty, target)
        if evidence.get('fetch_incomplete'):
            # deferred, not scored: no tag/score keys at all, so this can never be
            # mistaken for a verdict downstream, and nothing is billed for the
            # thrown-away fetch work
            return {
                'project': project,
                'github': url,
                'repo_accessible': True,
                'deferred': True,
                'error': 'evidence fetch incomplete - '
                f'{evidence.get("note") or "file fetch(es) failed"}; retry this repository',
                'target_name': tname,
                'kb_processed': 0.0,
                'engine_used': 'rocketride-node',
            }
        if not evidence.get('accessible'):
            return {
                'project': project,
                'github': url,
                'repo_accessible': False,
                'tag': 'None',
                'backbone': 'No',
                'score': 0.0,
                'error': 'repository not accessible',
                'target_name': tname,
                'engine_used': 'rocketride-node',
            }

        ev = engine.evaluate(evidence, target)
        note = engine.det_note(ev)
        return {
            'project': project,
            'github': url,
            'repo_accessible': True,
            'fetch_incomplete': bool(evidence.get('fetch_incomplete')),
            'tag': ev['tag'],
            'backbone': ev['backbone'],
            'score': ev['score'],
            'pipelines': ev['pipelines'],
            'breakdown': ev['breakdown'],
            'pipelines_called': ev['pipelines_called'],
            'pipelines_total': ev.get('pipelines_total'),
            'other_platforms': ev.get('other_platforms', []),
            'event_window': ev.get('event_window'),
            'reused_pipelines': ev.get('reused_pipelines', []),
            'project_predates': ev.get('project_predates'),
            'history_tampered': ev.get('history_tampered', []),
            'earliest_commit': ev.get('earliest_commit', ''),
            'repo_created_at': ev.get('repo_created_at', ''),
            'history_penalty': ev.get('history_penalty'),
            'platform': ev.get('platform') or {},
            'target_name': tname,
            'tech': ev.get('tech', []),
            'notes': note,
            'evidence': engine.evidence_lines(ev),
            'explain_prompt': engine.explain_prompt(
                ev, project, url, '', readme_head=evidence.get('readme_head', ''), target_name=tname
            ),
            'kb_processed': round(meter['chars'] / 1024, 2),
            'engine_used': 'rocketride-node',
        }

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
