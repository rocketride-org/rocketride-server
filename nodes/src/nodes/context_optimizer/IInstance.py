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

import copy

from rocketlib import IInstanceBase, Entry, debug, warning
from .IGlobal import IGlobal
from ai.common.schema import Question
from ai.common.schema import QuestionHistory


class IInstance(IInstanceBase):
    IGlobal: IGlobal  # Reference to global context providing the optimizer

    def open(self, entry: Entry):
        pass

    def writeQuestions(self, question: Question):
        """Optimize the context window for an incoming question.

        Extracts the system prompt (role), question text, documents, and
        conversation history from the Question object.  Runs the optimizer to
        fit everything within the model's token budget, then rebuilds the
        question with optimized content and attaches metadata.
        """
        # Deep copy so we never mutate the upstream question
        question = copy.deepcopy(question)

        optimizer = self.IGlobal.optimizer
        if optimizer is None:
            # No optimizer available (e.g. config mode) -- pass through
            warning('context_optimizer: optimizer not initialized, passing question through unchanged')
            self.instance.writeQuestions(question)
            return

        # ---- Extract components from the Question ----
        system_prompt = question.role or ''

        # Gather all question texts into a single query string
        query_texts = [q.text for q in (question.questions or []) if q.text]
        query_str = ' '.join(query_texts)

        # Convert documents to optimizer format
        docs = []
        for doc in question.documents or []:
            doc_dict = doc.model_dump() if hasattr(doc, 'model_dump') else doc.dict()
            content = doc_dict.get('page_content', '')
            docs.append({'content': content, '_original': doc})

        # Convert history to optimizer format
        history = [{'role': h.role, 'content': h.content} for h in (question.history or [])]

        # ---- Run optimization ----
        result = optimizer.optimize(
            question=query_str,
            system_prompt=system_prompt,
            documents=docs,
            history=history,
        )

        # ---- Rebuild the Question with optimized content ----

        # Update role / system prompt
        question.role = result['system_prompt'] or ''

        # Update questions -- replace text with optimized version
        if question.questions and result['question']:
            # Keep the first question's embedding info but update text
            question.questions[0].text = result['question']
            # Remove any extra questions that were merged
            if len(question.questions) > 1:
                question.questions = [question.questions[0]]

        # Update documents -- keep only the selected ones
        if question.documents is not None:
            selected_originals = [d['_original'] for d in result['documents'] if '_original' in d]
            question.documents = selected_originals

        # Update history
        if result['history']:
            question.history = [QuestionHistory(role=m['role'], content=m['content']) for m in result['history']]

        # ---- Attach optimization metadata as context ----
        meta = result['metadata']
        meta_text = f'[Context optimization: tokens_used={meta["tokens_used"]}, tokens_saved={meta["tokens_saved"]}, components_truncated={meta["components_truncated"]}, model={meta["model"]}, total_limit={meta["total_limit"]}]'
        debug(meta_text)

        # Forward the optimized question
        self.instance.writeQuestions(question)
