# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The live tool catalog evaluation's scorer and usage reader, on synthetic logs.

No engine, no model: live_eval.py uses the standard library only.
"""

import pytest
from live_eval import TASKS, generate_catalog, normalize_usage, score

T = {task.id: task for task in TASKS}


def L(name, **arguments):
    return {'name': name, 'arguments': arguments}


DEAL = L('crm.get_deal', deal_id=42)


def test_a_no_tool_task_fails_when_anything_ran():
    solved, reasons = score(T[7], [L('billing.create_invoice', customer_id='c-1')], 'done', 'The answer is 4.')

    assert not solved
    assert any('none expected' in r for r in reasons)


def test_a_no_tool_task_passes_with_an_empty_log():
    assert score(T[7], [], 'done', 'The answer is 4.') == (True, [])


def test_the_forbidden_tool_fails_the_ambiguous_task():
    solved, reasons = score(T[2], [DEAL, L('crm.get_deal_history', deal_id=42)], 'done', 'Stage: negotiation')

    assert not solved
    assert any('forbidden call crm.get_deal_history' in r for r in reasons)


def test_the_ambiguous_task_passes_with_only_the_right_tool():
    assert score(T[2], [DEAL], 'done', 'Stage: negotiation')[0]


def test_an_unordered_pair_passes_in_either_order():
    weather, rate = L('geo.get_weather', city='Zurich'), L('fx.get_rate', base='EUR', quote='CHF')
    answer = 'Sunny, and 1 EUR is 0.94 CHF.'

    assert score(T[5], [rate, weather], 'done', answer)[0]
    assert score(T[5], [weather, rate], 'done', answer)[0]


def test_an_unordered_pair_fails_with_one_call_missing():
    solved, reasons = score(T[5], [L('fx.get_rate', base='EUR', quote='CHF')], 'done', 'Sunny, 0.94')

    assert not solved
    assert any('geo.get_weather' in r for r in reasons)


def test_the_dependent_chain_requires_its_order():
    find, invoices = L('crm.find_customer', email='ana@example.com'), L('billing.list_invoices', customer_id='c-981')

    solved, reasons = score(T[3], [invoices, find], 'done', 'inv-1 and inv-2')
    assert not solved
    assert reasons[-1].endswith('in the expected order')
    assert score(T[3], [find, invoices], 'done', 'inv-1 and inv-2')[0]


def test_the_checked_write_requires_the_check_after_the_write():
    write, check = L('support.update_ticket', ticket_id='T-7', status='closed'), L('ci.run_checks')

    assert not score(T[4], [check, write], 'done', 'Ticket closed.')[0]
    assert score(T[4], [write, check], 'done', 'Ticket closed.')[0]


def test_arguments_must_match_on_the_expected_keys():
    assert not score(T[1], [L('crm.get_deal', deal_id=41)], 'done', 'negotiation')[0]
    assert score(T[1], [L('crm.get_deal', deal_id='42', fields='all')], 'done', 'negotiation')[0]


def test_stop_reason_and_markers_are_required():
    _, reasons = score(T[1], [DEAL], 'max_waves', 'negotiation')
    assert reasons == ["stop_reason 'max_waves'"]

    _, reasons = score(T[1], [DEAL], 'done', 'The deal exists.')
    assert reasons[0].startswith('answer lacks')


def test_extra_calls_are_allowed_unless_forbidden():
    assert score(T[1], [L('crm.list_deals'), DEAL], 'done', 'Stage: negotiation')[0]


def test_the_missing_tool_task_accepts_a_refusal_and_rejects_other_calls():
    assert score(T[8], [], 'done', 'I cannot send SMS messages with the tools available.')[0]
    assert not score(T[8], [L('crm.find_customer')], 'done', 'There is no tool for SMS.')[0]


def test_normalize_usage_treats_a_single_record_as_one_call():
    usage = {'input': 100, 'output': 10, 'cache_read': 0, 'cache_creation': 5000, 'model': 'fake'}

    assert normalize_usage(usage) == {
        'calls': 1,
        'input': 100,
        'output': 10,
        'cache_read': 0,
        'cache_creation': 5000,
        'prompt_tokens': 5100,
    }


def test_normalize_usage_keeps_the_aggregate_count():
    usage = {'input': 300, 'output': 30, 'cache_read': 1000, 'cache_creation': 200, 'calls': 3, 'breakdown': []}

    out = normalize_usage(usage)
    assert out['calls'] == 3
    assert out['prompt_tokens'] == 1500


@pytest.mark.parametrize('usage', [None, {}])
def test_normalize_usage_is_none_when_missing_or_empty(usage):
    assert normalize_usage(usage) is None


def test_prompt_tokens_count_cache_creation():
    compact = normalize_usage({'input': 100, 'cache_read': 0, 'cache_creation': 5000})
    eager = normalize_usage({'input': 400, 'cache_read': 1000, 'cache_creation': 0})

    assert (compact['prompt_tokens'], eager['prompt_tokens']) == (5100, 1400)
    assert not compact['prompt_tokens'] < eager['prompt_tokens']


@pytest.mark.parametrize('n', [30, 200])
def test_the_generated_catalog_has_every_task_tool_once(n):
    tools = generate_catalog(n)
    names = [t['name'] for t in tools]

    assert len(tools) == n
    assert len(set(names)) == n
    needed = {name for task in TASKS for name, _ in task.expected} | {'crm.get_deal_history'}
    assert needed <= set(names)
