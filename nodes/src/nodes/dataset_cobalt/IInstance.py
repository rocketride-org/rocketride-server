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

import contextlib
import copy

from rocketlib import Entry, IInstanceBase, debug

from .common import question_from_item
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Instance handler for the Cobalt Dataset node.

    Emits each dataset item as an individual Question into the pipeline,
    using deep copy to prevent mutation between emitted questions.
    """

    IGlobal: IGlobal

    def writeQuestions(self, question):
        """Load dataset items and emit each as an individual question.

        For every item in the loaded Cobalt dataset, a deep copy of the
        incoming question is created, its text is set to the dataset item's
        input text, and metadata is enriched with expected output, dataset ID,
        and cobalt source flag. Each question is then written downstream.

        Args:
            question: Incoming Question object used as a template.
        """
        questions = getattr(self.IGlobal, '_questions', None)
        if not questions:
            debug('Cobalt Dataset Instance: No dataset questions available, skipping')
            return

        debug(f'Cobalt Dataset Instance: Emitting {len(questions)} questions from dataset')

        for item in questions:
            # Deep copy prevents mutation between emitted questions
            q = copy.deepcopy(question)

            # Set the question text from the dataset item, replacing any
            # prompt carried by the incoming template so emitted items
            # contain only the dataset's prompt.
            if 'text' in item:
                text = item['text']
            else:
                text = ''
            if text is not None and text != '':
                if hasattr(q, 'questions'):
                    with contextlib.suppress(ValueError, AttributeError):
                        q.questions = []
                q.addQuestion(str(text))

            # Attach metadata to the question without injecting expected
            # answers into the prompt context (which the LLM would see).
            metadata = item.get('metadata', {})
            if metadata:
                existing = getattr(q, 'metadata', None)
                if isinstance(existing, dict):
                    existing.update(metadata)
                else:
                    q.metadata = dict(metadata)

            self.instance.writeQuestions(q)

        debug(f'Cobalt Dataset Instance: Finished emitting {len(questions)} questions')

    def renderObject(self, object: Entry):
        """Render a dataset scan entry as a Question from source mode."""
        tags = getattr(object, 'objectTags', None)
        if not tags:
            debug('Cobalt Dataset Instance: Source entry has no objectTags, skipping')
            return self.preventDefault()

        item = {
            'text': tags.get('text', ''),
            'metadata': tags.get('metadata', {}) or {},
        }
        self.instance.sendQuestions(question_from_item(item))
        return self.preventDefault()
