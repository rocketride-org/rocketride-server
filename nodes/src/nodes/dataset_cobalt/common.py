# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

from typing import Any, Dict

from ai.common.schema import Question
from ai.common.utils import merge_metadata


def question_from_item(item: Dict[str, Any]) -> Question:
    """Build a Question from a dataset item.

    Args:
        item: Dataset item with an optional 'text' key holding the prompt and
            an optional 'metadata' dict carrying the reference answer. The
            metadata is attached to the Question but never rendered into the
            prompt, so a downstream LLM never sees the expected answer.

    Returns:
        A Question carrying the item's text and metadata.
    """
    question = Question()

    if 'text' in item:
        text = item['text']
    else:
        text = ''
    if text is not None and text != '':
        question.addQuestion(str(text))

    merge_metadata(question, item.get('metadata', {}))

    return question
