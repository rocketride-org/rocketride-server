# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Planning prompt tests for agent_rocketride (Wave bugs W1 and W2).

W2. AgentBase.run_agent adds the node's configured instructions to the question
before the driver runs. The driver also passed them to the planner, which added
them again, so every planning prompt carried two copies. Now the planner relies
on the copy the question already holds.

W1. Text in a tool result was cut to 80 characters before the planner saw it.
test_result_summary.py covers how a summary renders text at the top level. The
last test here covers text one level down, in a nested dict or a list row.

The modules come from the ``wave`` fixture in conftest.py. The model and the
tool list are small fakes, so no pipeline, model or key is involved.
"""

from types import SimpleNamespace

RULE = 'Use the colors defined in src/theme.css.'


def _question(wave):
    """Return a question as run_agent hands it to the driver, with RULE already added."""
    q = wave.planner.Question()
    q.addQuestion('Make the page header blue.')
    # The same call AgentBase.run_agent makes for each configured instruction.
    q.addInstruction('Additional Instruction', RULE)
    return q


def _context():
    return SimpleNamespace(run_id='run-1', tools=SimpleNamespace(list=[]), memory=None)


def test_planning_prompt_has_each_instruction_once(wave):
    """The planner does not add an instruction the question already carries."""
    q = wave.planner._build_wave_question(context=_context(), question=_question(wave), waves=[])

    assert q.getPrompt().count(RULE) == 1


def test_driver_sends_each_instruction_once(wave):
    """The prompt the model gets on the first step holds the configured instruction once."""
    driver = object.__new__(wave.rocketride_agent.RocketRideDriver)
    driver._instructions = [RULE]
    driver._max_waves = 1
    driver.sendSSE = lambda *args, **kwargs: None
    prompts = []

    def call_llm_json(context, question):
        prompts.append(question.getPrompt())
        return {'done': True, 'answer': 'OK'}

    driver.call_llm_json = call_llm_json

    answer, _ = driver._run(context=_context(), question=_question(wave))

    assert answer == 'OK'
    assert prompts[0].count(RULE) == 1


def test_nested_text_is_whole_but_row_text_is_cut(wave):
    """A nested result field shows its text whole. In the rows of a sampled list it is still cut at 80."""
    text = 'x' * 500

    nested = wave.executor._describe({'result': {'content': text}})
    in_row = wave.executor._describe([{'name': name, 'meta': {'note': text}} for name in 'abc'])

    assert f'"{text}"' in nested
    assert f'"{"x" * 80}..." (500 chars)' in in_row
