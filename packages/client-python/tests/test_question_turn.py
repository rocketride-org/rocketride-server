"""Turn mode on Question and Answer: a non-empty ``messages`` sends real provider turns.

The fixture in ``fixtures/turn_blocks.json`` holds every block type and is read by the
TypeScript tests too, so the two SDKs cannot drift apart on the wire shape.
"""

import json
import os

import pytest
from pydantic import ValidationError

from rocketride.schema import Answer, AssistantMessage, Question, QuestionHistory, ToolCallBlock, UserMessage
from rocketride.schema.doc import Doc

FIXTURE = json.load(open(os.path.join(os.path.dirname(__file__), 'fixtures', 'turn_blocks.json')))

LEGACY_PROMPT = (
    'You are an analyst.\r\n\r\n### System Instructions:\r\n    1) **JSON Response Format**:\r\n'
    '        - Respond **only** with a fenced, valid JSON structure.\r\n'
    '        - Properly escape all quotes within content strings.\r\n'
    '        - No additional text, comments, or explanations.\r\n'
    '        - Ensure your answer is strictly valid JSON format.\r\n'
    '        - Double check the JSON response to ensure it is valid.\r\n'
    '        - Enclose the json with ```json and ``` tags.\r\n\r\n    2) **CRITICAL**:\r\n'
    '        - Your previous response returned invalid JSON.\r\n'
    '        - Examine your JSON and ensure it is complete and follows the JSON standards.\r\n\r\n'
    '    3) **Focus**:\r\n        Look at revenue.\r\n          - keep nesting\r\n\r\n### Examples:\r\n'
    '    Example 1\r\n        **Given**: Q1?\r\n        **Expected output**: ```json\r\n{"Q1": 1}\r\n```\r\n\r\n'
    '### Conversation History:\r\n    user: hi\r\n    assistant: hello\r\n\r\n### Context:\r\n    1) ctx one\r\n\r\n'
    "    2) {'k': 'v'}\r\n\r\n\r\n### Documents:\r\n    Document 1) Content: doc body\r\n\r\n"
    '### Ultimate Goal:\r\n    1) Find trends\r\n\r\n### Current Task:\r\n    What changed?\r\n\r\n'
)


def _legacy_question() -> Question:
    q = Question(role='You are an analyst.', expectJson=True)
    q.addInstruction('Focus', 'Look at revenue.\n  - keep nesting')
    q.addExample('Q1?', {'Q1': 1})
    q.addHistory(QuestionHistory(role='user', content='hi'))
    q.addHistory(QuestionHistory(role='assistant', content='hello'))
    q.addContext(['ctx one', {'k': 'v'}])
    q.addDocuments([Doc(page_content='doc body')])
    q.addGoal('Find trends')
    q.addQuestion('What changed?')
    return q


def test_legacy_question_prompt_and_wire_are_unchanged():
    q = _legacy_question()

    assert q.getPrompt(has_previous_json_failed=True) == LEGACY_PROMPT
    assert not q.isTurn()
    dumped = json.loads(q.model_dump_json())
    assert 'messages' not in dumped and 'tools' not in dumped


def test_every_block_type_round_trips_through_the_fixture():
    q = Question.model_validate(FIXTURE['question'])

    assert q.isTurn()
    dumped = q.model_dump(include={'messages', 'tools'})
    assert dumped == {'messages': FIXTURE['question']['messages'], 'tools': FIXTURE['question']['tools']}


def test_answer_from_result_reads_the_turn_and_writes_the_same_entry():
    entry = FIXTURE['result']['answers'][0]
    answer = Answer.fromResult(FIXTURE['result'])

    assert answer.stopReason == 'tool_use'
    assert answer.getText() == 'Labelling #42.'
    assert [(c.id, c.name, c.args) for c in answer.toolCalls()] == [
        ('toolu_03', 'tool_github_1.create_issue', {'title': 'Flaky test', 'labels': ['bug']})
    ]
    assert answer.model_dump(exclude={'answer', 'expectJson'}) == entry


def test_answer_from_a_text_result_is_a_text_answer():
    answer = Answer.fromResult({'answers': ['plain text']})

    assert answer.getText() == 'plain text'
    assert answer.message is None and answer.toolCalls() == []


@pytest.mark.parametrize(
    'update, rule',
    [
        ({'messages': [], 'tools': [{'name': 'a'}]}, 'tools need messages'),
        ({'history': [{'role': 'user', 'content': 'x'}]}, 'history cannot be used with messages'),
        ({'questions': [{'text': 'x'}]}, 'questions cannot be used with messages'),
        ({'expectJson': True}, 'expectJson cannot be used with messages'),
        ({'tools': [{'name': 'a'}, {'name': 'a'}]}, 'tool names must be unique'),
        ({'messages': [{'role': 'user', 'content': 'x'}, {'role': 'assistant', 'content': 'y'}]}, 'last message'),
        (
            {'messages': [{'role': 'user', 'content': [{'type': 'tool_call', 'id': '1', 'name': 'a', 'args': {}}]}]},
            'tool_call',
        ),
    ],
)
def test_turn_rules_are_enforced_at_parse(update, rule):
    data = {**FIXTURE['question'], **update}

    with pytest.raises(ValidationError, match=rule):
        Question.model_validate(data)


def test_system_prompt_is_the_head_of_the_prompt_and_material_joins_the_last_user_message():
    q = Question(role='Persona.')
    q.addInstruction('Rule', 'Be brief.')
    q.addExample('hi', 'hello')
    q.addMessage(UserMessage(content='Do the task.'))
    q.addContext('The page is /home.')
    q.addGoal('Ship it')

    system = q.getSystemPrompt()
    assert system.startswith('Persona.') and 'Be brief.' in system and '**Given**: hi' in system
    assert q.getPrompt().startswith(system)
    assert 'The page is /home.' not in system

    *head, last = q.getTurnMessages()
    assert head == [] and last.role == 'user'
    assert last.content[0].text == 'Do the task.'
    assert '### Context:' in last.content[1].text and '### Ultimate Goal:' in last.content[1].text
    assert q.messages[-1].content == 'Do the task.'


def test_a_tool_loop_built_with_add_message_and_add_tool_result():
    q = Question(tools=FIXTURE['question']['tools'], messages=[UserMessage(content='File it.')])
    turn = AssistantMessage(
        content=[
            ToolCallBlock(id='c1', name='memory.peek', args={}),
            ToolCallBlock(id='c2', name='memory.peek', args='{'),
        ]
    )

    q.addMessage(turn)
    q.addToolResult('c1', 'empty')
    q.addToolResult('c2', 'bad arguments', isError=True)

    q.checkTurn()
    assert [(b.callId, b.isError) for b in q.messages[-1].content] == [('c1', False), ('c2', True)]
    with pytest.raises(ValueError, match='no tool call'):
        q.addToolResult('nope', 'x')


def test_add_message_refuses_a_question_already_using_history():
    q = Question()
    q.addHistory(QuestionHistory(role='user', content='old'))

    with pytest.raises(ValueError, match='history cannot be used with messages'):
        q.addMessage({'role': 'user', 'content': 'new'})
    assert q.messages == []
