from __future__ import annotations

from typing import Any, Dict, Optional

from ..types import AgentEnvelope
from .utils import safe_str


def to_envelope(
    *,
    framework: str,
    agent_id: str,
    run_id: str,
    task_id: Optional[str],
    started_at: str,
    ended_at: str,
    continuation: Optional[Dict[str, Any]],
    raw_result: Any,
) -> AgentEnvelope:
    """Normalize a framework adapter return value into a canonical AgentEnvelope."""
    envelope: AgentEnvelope = {
        'status': 'completed',
        'error': None,
        'control': {'signal': 'continue', 'reason': ''},
        'result': {'type': 'agent_output', 'data': {}},
        'artifacts': [],
        'meta': {
            'framework': framework,
            'agent_id': agent_id,
            'run_id': run_id,
            'state_ref': safe_str((continuation or {}).get('state_ref', '')),
            'started_at': started_at,
            'ended_at': ended_at,
        },
    }
    if task_id:
        envelope['meta']['task_id'] = task_id

    if isinstance(raw_result, dict):
        status = raw_result.get('status')
        if isinstance(status, str) and status:
            envelope['status'] = status
            if status == 'paused':
                envelope['control']['signal'] = 'request_input'
            elif status == 'failed':
                envelope['control']['signal'] = 'halt'

        err = raw_result.get('error')
        if isinstance(err, dict) or err is None:
            envelope['error'] = err

        ctrl = raw_result.get('control')
        if isinstance(ctrl, dict):
            envelope['control'] = {**envelope.get('control', {}), **ctrl}

        result = raw_result.get('result')
        if isinstance(result, dict):
            envelope['result'] = result
        elif result is not None:
            envelope['result'] = {'type': 'agent_output', 'data': result}

        artifacts = raw_result.get('artifacts')
        if isinstance(artifacts, list):
            envelope['artifacts'] = artifacts

        meta = raw_result.get('meta')
        if isinstance(meta, dict):
            envelope_meta = envelope.get('meta', {})
            envelope['meta'] = {**meta, **envelope_meta}

        return envelope

    envelope['result'] = {'type': 'agent_output', 'data': raw_result}
    return envelope


def failed_envelope(
    *,
    framework: str,
    agent_id: str,
    run_id: str,
    task_id: Optional[str],
    started_at: str,
    ended_at: str,
    error_type: str,
    error_message: str,
) -> AgentEnvelope:
    """Create a canonical failure AgentEnvelope."""
    envelope: AgentEnvelope = {
        'status': 'failed',
        'error': {'message': error_message, 'type': error_type, 'details': {}},
        'control': {'signal': 'halt', 'reason': error_message},
        'result': {'type': 'error', 'data': None},
        'artifacts': [],
        'meta': {
            'framework': framework,
            'agent_id': agent_id,
            'run_id': run_id,
            'state_ref': '',
            'started_at': started_at,
            'ended_at': ended_at,
        },
    }
    if task_id:
        envelope['meta']['task_id'] = task_id
    return envelope
