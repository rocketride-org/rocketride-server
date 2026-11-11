# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tasks, scorer and usage reader for the live tool catalog evaluation.

test_agent_rocketride_tool_catalog_full.py runs eight tasks against a stub MCP
server with 30 and 200 generated tools, with every schema in the prompt and with
schemas loaded on demand. This module holds everything that run needs that can be
tested without a model: the tasks, the scorer, the usage reader, the catalog and
the report. It uses the standard library only (test_live_eval_scoring.py).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class Task:
    id: int
    prompt: str
    # (bare stub tool name, arguments that must match) for each call that must run.
    expected: Tuple[Tuple[str, Dict[str, Any]], ...]
    # Groups of alternatives: one of each group must appear in the answer.
    markers: Tuple[Tuple[str, ...], ...]
    # False: each expected call matches a distinct log entry, in any order.
    ordered: bool = True
    # Names that must not appear anywhere in the log.
    forbidden: Tuple[str, ...] = ()
    # The node's verify_tool for this task, as a bare stub name ('' for none).
    verify_tool: str = ''


TASKS: Tuple[Task, ...] = (
    Task(1, 'Fetch CRM deal 42 and report its stage.', (('crm.get_deal', {'deal_id': 42}),), (('negotiation',),)),
    Task(
        2,
        'What is the current stage of deal 42?',
        (('crm.get_deal', {'deal_id': 42}),),
        (('negotiation',),),
        forbidden=('crm.get_deal_history',),
    ),
    Task(
        3,
        'List the invoices of the customer whose email is ana@example.com.',
        (
            ('crm.find_customer', {'email': 'ana@example.com'}),
            ('billing.list_invoices', {'customer_id': 'c-981'}),
        ),
        (('inv-1',), ('inv-2',)),
    ),
    Task(
        4,
        'Set the status of ticket T-7 to closed and make sure the checks pass.',
        (('support.update_ticket', {'ticket_id': 'T-7', 'status': 'closed'}), ('ci.run_checks', {})),
        (('closed',),),
        verify_tool='ci.run_checks',
    ),
    Task(
        5,
        'Get the weather in Zurich and the EUR to CHF rate.',
        (('geo.get_weather', {'city': 'Zurich'}), ('fx.get_rate', {'base': 'EUR', 'quote': 'CHF'})),
        (('sunny',), ('0.94',)),
        ordered=False,
    ),
    Task(
        6,
        "Search the internal docs for 'onboarding'.",
        (('docs.search', {'query': 'onboarding', 'scope': 'internal'}),),
        (('Onboarding checklist',),),
    ),
    Task(7, 'What is 2 + 2?', (), (('4',),)),
    Task(
        8,
        'Send an SMS to +41 79 000 00 00 saying hello.',
        (),
        (('cannot', "can't", 'unable', 'no tool', 'not available', "don't have"),),
    ),
)


def _same(expected: Any, actual: Any) -> bool:
    if isinstance(expected, str) and isinstance(actual, str):
        return expected.strip() == actual.strip()
    if isinstance(expected, int) and not isinstance(expected, bool) and isinstance(actual, str):
        return actual.strip() == str(expected)
    return expected == actual


def args_match(expected: Dict[str, Any], actual: Dict[str, Any]) -> bool:
    """Every expected key is in *actual* with an equal value; an int equals its decimal string."""
    actual = actual if isinstance(actual, dict) else {}
    return all(k in actual and _same(v, actual[k]) for k, v in expected.items())


def score(task: Task, log: List[Dict[str, Any]], stop_reason: Any, answer: str) -> Tuple[bool, List[str]]:
    """Whether the run solved *task*, and why not. An empty reason list means solved.

    Extra calls to tools that are not forbidden are allowed.
    """
    reasons: List[str] = []
    if stop_reason != 'done':
        reasons.append(f'stop_reason {stop_reason!r}')
    # Models write typographic apostrophes ("can’t"); the markers use plain ones.
    text = (answer or '').replace('\u2019', "'").lower()
    for group in task.markers:
        if not any(m.lower() in text for m in group):
            reasons.append(f'answer lacks {" or ".join(repr(m) for m in group)}')
    names = [entry.get('name') for entry in log]
    for name in task.forbidden:
        if name in names:
            reasons.append(f'forbidden call {name}')
    if not task.expected:
        if log:
            reasons.append(f'{len(log)} call(s) ran where none expected: {", ".join(map(str, names))}')
        return not reasons, reasons
    if task.ordered:
        i = 0
        for entry in log:
            if i < len(task.expected):
                name, args = task.expected[i]
                if entry.get('name') == name and args_match(args, entry.get('arguments') or {}):
                    i += 1
        if i < len(task.expected):
            reasons.append(f'expected calls {[n for n, _ in task.expected]} did not run in the expected order')
    else:
        remaining = list(log)
        for name, args in task.expected:
            hit = next(
                (
                    k
                    for k, e in enumerate(remaining)
                    if e.get('name') == name and args_match(args, e.get('arguments') or {})
                ),
                None,
            )
            if hit is None:
                reasons.append(f'expected call {name} with {args} did not run')
            else:
                remaining.pop(hit)
    return not reasons, reasons


def normalize_usage(usage: Any) -> Optional[Dict[str, int]]:
    """The agent envelope's ``meta.usage`` as counts, or None when it is missing or empty.

    One model call is reported as the record itself (no ``calls`` key); more as a
    total with ``calls``. The three input counts are disjoint, so the prompt's size
    is their sum.
    """
    if not isinstance(usage, dict) or not usage:
        return None
    out = {k: int(usage.get(k) or 0) for k in ('input', 'output', 'cache_read', 'cache_creation')}
    out['calls'] = int(usage.get('calls') or 1)
    out['prompt_tokens'] = out['input'] + out['cache_read'] + out['cache_creation']
    return out


# Canned results for the task tools; every other generated tool returns {'ok': True}.
_RESULTS = {
    'crm.get_deal': {'deal_id': 42, 'stage': 'negotiation', 'amount': 12000},
    'crm.get_deal_history': {'deal_id': 42, 'events': [{'stage': 'qualified'}, {'stage': 'negotiation'}]},
    'crm.find_customer': {'customer_id': 'c-981'},
    'billing.list_invoices': {'invoices': [{'id': 'inv-1', 'total': 100}, {'id': 'inv-2', 'total': 250}]},
    'support.update_ticket': {'ok': True},
    'ci.run_checks': {'ok': True, 'passed': 12},
    'geo.get_weather': {'condition': 'sunny', 'temp_c': 21},
    'fx.get_rate': {'rate': 0.94},
    'docs.search': {'hits': [{'title': 'Onboarding checklist'}]},
}


def _prop(kind: str, description: str, **extra: Any) -> Dict[str, Any]:
    return {'type': kind, 'description': description, **extra}


_TASK_TOOLS: Dict[str, Tuple[str, Dict[str, Any], List[str]]] = {
    'crm.get_deal': (
        'Read one CRM deal by id: its stage, amount and owner.',
        {'deal_id': _prop('integer', 'Deal id')},
        ['deal_id'],
    ),
    'crm.get_deal_history': (
        'List the past stage changes of a CRM deal, oldest first.',
        {'deal_id': _prop('integer', 'Deal id')},
        ['deal_id'],
    ),
    'crm.find_customer': ('Find a customer by email address.', {'email': _prop('string', 'Email address')}, ['email']),
    'billing.list_invoices': (
        'List the invoices of a customer.',
        {'customer_id': _prop('string', 'Customer id from the CRM')},
        ['customer_id'],
    ),
    'billing.create_invoice': (
        'Create and send an invoice to a customer.',
        {'customer_id': _prop('string', 'Customer id'), 'total': _prop('number', 'Amount')},
        ['customer_id', 'total'],
    ),
    'billing.create_invoice_draft': (
        'Create an invoice draft that is not sent.',
        {'customer_id': _prop('string', 'Customer id'), 'total': _prop('number', 'Amount')},
        ['customer_id', 'total'],
    ),
    'support.update_ticket': (
        'Change the status of a support ticket.',
        {
            'ticket_id': _prop('string', 'Ticket id'),
            'status': _prop('string', 'New status', enum=['open', 'pending', 'closed']),
        },
        ['ticket_id', 'status'],
    ),
    'ci.run_checks': ('Run the project checks and report whether they pass.', {}, []),
    'geo.get_weather': ('Current weather for a city.', {'city': _prop('string', 'City name')}, ['city']),
    'fx.get_rate': (
        'Exchange rate between two currencies.',
        {
            'base': _prop('string', 'ISO code of the base currency'),
            'quote': _prop('string', 'ISO code of the quote currency'),
        },
        ['base', 'quote'],
    ),
    'docs.search': (
        'Search the documentation.',
        {'query': _prop('string', 'Search words'), 'scope': _prop('string', 'Which docs', enum=['public', 'internal'])},
        ['query', 'scope'],
    ),
}

_NAMESPACES = ('crm', 'billing', 'support', 'ci', 'geo', 'fx', 'docs', 'hr', 'inventory', 'calendar')


def generate_catalog(n_tools: int) -> List[Dict[str, Any]]:
    """The stub server's tool list: the task tools, padded with filler tools to *n_tools*.

    200 tools are 10 namespaces of 20; 30 tools are the 11 task tools plus 19 fillers
    spread over the namespaces. Entries carry ``_stub_result``, which the stub strips
    from tools/list and returns from tools/call.
    """
    tools: List[Dict[str, Any]] = []
    for name, (description, props, required) in _TASK_TOOLS.items():
        tools.append(
            {
                'name': name,
                'description': description,
                'inputSchema': {'type': 'object', 'properties': props, 'required': required},
                '_stub_result': _RESULTS.get(name, {'ok': True}),
            }
        )
    i = 0
    while len(tools) < n_tools:
        ns = _NAMESPACES[i % len(_NAMESPACES)]
        tools.append(
            {
                'name': f'{ns}.lookup_{i:03d}',
                'description': f'Read {ns} record {i:03d} by id.',
                'inputSchema': {
                    'type': 'object',
                    'properties': {
                        'id': _prop('string', 'Record id'),
                        'fields': {'type': 'array', 'items': {'type': 'string'}},
                    },
                    'required': ['id'],
                },
                '_stub_result': {'ok': True},
            }
        )
        i += 1
    return tools[:n_tools]


def _mean(values: Sequence[float]) -> Optional[float]:
    return sum(values) / len(values) if values else None


def format_report(cells: List[Dict[str, Any]]) -> str:
    """One Markdown row per (tools, budget) cell.

    Each cell: ``tools``, ``budget``, ``model``, ``date`` and ``runs``, a list of per-task
    records with ``task``, ``solved``, ``reasons``, ``mode``, ``fallback_step``,
    ``planning_steps``, ``skipped`` and ``usage`` (normalized, or None).
    """
    lines = [
        '| tools | budget | mode | solved | failed (why) | steps | model calls | prompt tokens | fresh input '
        '| cache read | cache creation | skipped calls | runs with usage | model | date |',
        '|---:|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|',
    ]
    for cell in cells:
        runs = cell['runs']
        modes = sorted({str(r.get('mode')) for r in runs})
        fallbacks = sorted({r['fallback_step'] for r in runs if r.get('fallback_step')})
        mode = '/'.join(modes) + (f' (fallback at {fallbacks})' if fallbacks else '')
        solved = sum(1 for r in runs if r['solved'])
        failed = '; '.join(f'{r["task"]}: {", ".join(r["reasons"])}' for r in runs if not r['solved']) or '-'
        usages = [r['usage'] for r in runs if r.get('usage')]
        complete = len(usages) == len(runs)

        def col(key: str) -> str:
            if not complete:
                return 'unavailable'
            return f'{_mean([u[key] for u in usages]):,.0f}'

        steps = _mean([r.get('planning_steps') or 0 for r in runs])
        skipped = _mean([r.get('skipped') or 0 for r in runs])
        lines.append(
            f'| {cell["tools"]} | {cell["budget"]:,} | {mode} | {solved}/{len(runs)} | {failed} | {steps:.1f} | '
            f'{col("calls")} | {col("prompt_tokens")} | {col("input")} | {col("cache_read")} | '
            f'{col("cache_creation")} | {skipped:.1f} | {len(usages)}/{len(runs)} | {cell.get("model", "")} | '
            f'{cell.get("date", "")} |'
        )
    return '\n'.join(lines)


def dumps(cells: List[Dict[str, Any]]) -> str:
    return json.dumps(cells, ensure_ascii=False, indent=1)
