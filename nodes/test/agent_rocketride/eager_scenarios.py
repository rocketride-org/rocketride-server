# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Planning prompts that send every tool's full schema, rendered through the real driver.

``render(wave, name)`` runs the Wave driver on one scenario and returns the planning
prompt it would send to the model. test_eager_prompts.py compares each one with the
prompt stored in fixtures/eager_prompts.json, recorded before the tool catalog budget
existed, so a change to that prompt shows up byte for byte.
"""

from types import SimpleNamespace
from typing import Any, Callable, Dict, List

from bench_tool_catalog import synthetic_catalog

RULE = 'Use the colors defined in src/theme.css.'
CHECK = 'node.catalog.lookup_029'
CHECK_ARGS = {'id': 'build'}

SCENARIOS = (
    'first_30',
    'later_30',
    'check_args_30',
    'first_200_budget_0',
    'equal_to_budget_30',
    'empty_catalog',
    'non_ascii_30',
)


class DictMemory:
    """A dict-backed memory channel with the node's ``{ok, value}`` replies."""

    def __init__(self) -> None:
        self.store: Dict[str, Any] = {}

    def put(self, key: str, value: Any) -> Dict[str, Any]:
        self.store[key] = value
        return {'ok': True}

    def get(self, key: str) -> Dict[str, Any]:
        if key in self.store:
            return {'ok': True, 'value': self.store[key]}
        return {'ok': False}

    def clear(self, key: str = None) -> Dict[str, Any]:
        if key is None:
            self.store.clear()
        else:
            self.store.pop(key, None)
        return {'ok': True}

    def list(self) -> Dict[str, Any]:
        return {'ok': True, 'keys': list(self.store)}


def _non_ascii_catalog() -> List[Dict[str, Any]]:
    tools = synthetic_catalog(30)
    tools[3]['description'] = 'Lit la fiche créée par l’équipe.'
    tools[7]['description'] = '日本語の記録を読む。'
    tools[11]['description'] = 'Read the launch notes 🚀 by id.'
    return tools


def _tool_result(tool: str, args: Dict[str, Any]) -> Any:
    """What a tool returns in these scenarios: a nested dict, or a list of rows."""
    if tool.endswith('_001'):
        return [{'id': f'r{i}', 'city': f'City {i}', 'tags': ['a', 'b']} for i in range(12)]
    return {'id': args.get('id', ''), 'record': {'owner': {'name': 'Ana', 'team': 'core'}, 'size': 42}}


def build_driver(wave, *, budget: Any = None, verify_tool: str = '', verify_args: Any = None):
    """The driver with __init__ bypassed, as test_wave_prompt.py builds it. A budget of None keeps its default."""
    driver = object.__new__(wave.rocketride_agent.RocketRideDriver)
    driver._instructions = []
    driver._max_waves = 3
    driver.sendSSE = lambda *args, **kwargs: None
    if verify_tool:
        driver._verify_tool = verify_tool
        driver._verify_args = verify_args
    if budget is not None:
        driver._tool_catalog_budget = budget
    return driver


def build_context(wave, tools: List[Dict[str, Any]], *, invoke: Callable = None, memory=None, get=None):
    """A real AgentContext with these tools connected; the driver copies it per run."""
    catalog = SimpleNamespace(list=tools, invoke=invoke or (lambda tool, args: _tool_result(tool, args)))
    if get is not None:
        catalog.get = get
    return wave.rocketride_agent.AgentContext(
        invoker=None,
        llm=None,
        tools=catalog,
        memory=memory if memory is not None else DictMemory(),
        run_id='run-1',
        pipe_id=0,
        framework='wave',
        started_at='',
    )


def _question(wave, *, rich: bool):
    from ai.common.schema import Doc, QuestionHistory

    q = wave.planner.Question()
    q.addQuestion('Find the owner of item 000 and list the rows of item 001.')
    if rich:
        q.addInstruction('Additional Instruction', RULE)
        q.addHistory(QuestionHistory(role='user', content='Hello'))
        q.addHistory(QuestionHistory(role='assistant', content='Hi. What do you need?'))
        q.addContext('The team keeps its records in the catalog.')
        q.addDocuments(Doc(page_content='Item 000 belongs to the core team.', score=0.9))
    return q


def capture_prompts(wave, *, tools, replies: List[Dict[str, Any]], budget: Any = None, rich: bool = False, **check):
    """Run the driver once and return every planning prompt it built, in order."""
    driver = build_driver(wave, budget=budget, **check)
    prompts: List[str] = []
    script = list(replies)

    def call_llm_json(context, question):
        prompts.append(question.getPrompt())
        return script.pop(0) if script else {'done': True, 'answer': 'OK'}

    driver.call_llm_json = call_llm_json
    driver.call_llm = lambda context, question: 'OK'
    driver._run(context=build_context(wave, tools), question=_question(wave, rich=rich))
    return prompts


def render(wave, name: str) -> str:
    """The planning prompt of scenario *name* (see SCENARIOS)."""
    done = [{'done': True, 'answer': 'OK'}]
    if name == 'first_30':
        return capture_prompts(wave, tools=synthetic_catalog(30), replies=done)[0]
    if name == 'later_30':
        calls = {
            'scratch': 'Owner first, then the rows.',
            'tool_calls': [
                {'tool': 'node.catalog.lookup_000', 'args': {'id': '000'}},
                {'tool': 'node.catalog.lookup_001', 'args': {'id': '001', 'fields': ['city']}},
            ],
        }
        return capture_prompts(wave, tools=synthetic_catalog(30), replies=[calls, *done], rich=True)[1]
    if name == 'check_args_30':
        return capture_prompts(
            wave, tools=synthetic_catalog(30), replies=done, verify_tool=CHECK, verify_args=dict(CHECK_ARGS)
        )[0]
    if name == 'first_200_budget_0':
        return capture_prompts(wave, tools=synthetic_catalog(200), replies=done, budget=0)[0]
    if name == 'equal_to_budget_30':
        return capture_prompts(wave, tools=synthetic_catalog(30), replies=done, budget=8699)[0]
    if name == 'empty_catalog':
        return capture_prompts(wave, tools=[], replies=done)[0]
    if name == 'non_ascii_30':
        return capture_prompts(wave, tools=_non_ascii_catalog(), replies=done)[0]
    raise KeyError(name)
