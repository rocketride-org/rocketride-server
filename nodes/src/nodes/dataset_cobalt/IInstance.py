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

from rocketlib import Entry, IInstanceBase, debug, warning
from ai.common.utils import merge_metadata

from .common import plain_metadata, question_from_item, question_text, skipped_rows_warning
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Instance handler for the Cobalt Dataset node.

    Emits each dataset item as an individual Question into the pipeline,
    using deep copy to prevent mutation between emitted questions.

    Both emission lanes end in ``preventDefault()``. The engine forwards a lane
    handler's incoming argument after the handler returns unless the handler
    prevented it (``__checkCallParent``, ``engLib/python/call.hpp``), and the
    question this node receives in filter mode is only a trigger: it carries no
    dataset row, so letting the engine pass it on put one extra, promptless
    question downstream next to the N real ones.
    """

    IGlobal: IGlobal

    def writeQuestions(self, question):
        """Load dataset items and emit each as an individual question.

        For every item in the loaded Cobalt dataset, a deep copy of the
        incoming question is created, its text is set to the dataset item's
        input text, and metadata is enriched with expected output, dataset ID,
        and cobalt source flag. Each question is then written downstream.

        A row carrying no prompt text is skipped rather than emitted. Emitting
        it produced a question with no prompt at all but a populated
        ``metadata['expected']``, so downstream the LLM answered an empty
        prompt and eval_cobalt scored that reply against the reference - a low
        score indistinguishable from a weak model. The skipped rows are
        reported once, after the loop.

        Exactly ``N`` questions leave this node for ``N`` emittable rows. Every
        exit - including the no-dataset one - suppresses the engine's default
        forward: the incoming question is a template, not content, and passing
        it on unchanged would add a promptless question to the lane. When no
        dataset loaded there is nothing to ask at all, so that exit stays
        silent rather than forwarding the bare trigger, which is the same rule
        ``renderObject`` applies in source mode.

        Args:
            question: Incoming Question object used as a template.

        Returns:
            The ``preventDefault()`` result, suppressing the engine's
            post-handler forward of the template question.
        """
        questions = getattr(self.IGlobal, '_questions', None)
        if not questions:
            debug('Cobalt Dataset Instance: No dataset questions available, skipping')
            return self.preventDefault()

        debug(f'Cobalt Dataset Instance: Emitting {len(questions)} questions from dataset')

        skipped = 0
        for item in questions:
            # Set the question text from the dataset item, replacing any
            # prompt carried by the incoming template so emitted items
            # contain only the dataset's prompt.
            text = question_text(item)
            if text is None:
                skipped += 1
                continue

            # Deep copy prevents mutation between emitted questions
            q = copy.deepcopy(question)

            if hasattr(q, 'questions'):
                with contextlib.suppress(ValueError, AttributeError):
                    q.questions = []
            q.addQuestion(text)

            # Attach metadata to the question without injecting expected
            # answers into the prompt context (which the LLM would see).
            merge_metadata(q, item.get('metadata', {}))

            self.instance.writeQuestions(q)

        if skipped:
            warning(f'Cobalt Dataset Instance: {skipped_rows_warning(skipped)}')

        debug(f'Cobalt Dataset Instance: Finished emitting {len(questions) - skipped} questions')

        return self.preventDefault()

    def renderObject(self, object: Entry):
        """Render a dataset scan entry as a Question from source mode."""
        tags = getattr(object, 'objectTags', None)
        if not tags:
            debug('Cobalt Dataset Instance: Source entry has no objectTags, skipping')
            return self.preventDefault()

        item = {
            'text': tags.get('text', ''),
            # objectTags is an engine IJson handle, so its 'metadata' member is
            # another IJson rather than the dict scanObjects stored; see
            # common.plain_metadata for what that cost before it was converted.
            'metadata': plain_metadata(tags.get('metadata', {})),
        }
        # Same rule as filter mode: a row with no prompt is dropped, not sent
        # on as a promptless question. scanObjects already filters these out,
        # so this covers an entry that reached the instance by another route.
        emitted = question_from_item(item)
        if emitted is None:
            warning(f'Cobalt Dataset Instance: {skipped_rows_warning(1)}')
            return self.preventDefault()

        self.instance.sendQuestions(emitted)
        return self.preventDefault()
