from rocketride.schema import Answer, Question


def test_question_accepts_pipeline_metadata():
    question = Question()
    question.metadata['expected'] = 'reference answer'

    assert question.metadata['expected'] == 'reference answer'
    assert 'reference answer' not in question.getPrompt()


def test_answer_accepts_pipeline_metadata():
    answer = Answer()
    answer.metadata['expected'] = 'reference answer'

    assert answer.metadata['expected'] == 'reference answer'
