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
from ai.common.schema import Doc
from ai.common.schema import Question
from ai.common.schema import QuestionHistory
from ai.common.schema import QuestionText


def blank_budgeted_fields(question: Question) -> Question:
    """Return a copy of *question* with the four budgeted fields emptied.

    The optimizer budgets ``role``, ``questions``, ``documents`` and
    ``history``; ``Question.getPrompt()`` renders those *plus* ``instructions``
    (including the boilerplate ``expectJson`` injects), ``examples``,
    ``context``, ``goals`` and a ``### ...`` skeleton of section headers,
    ``Document N) Content:`` / ``role:`` prefixes and CRLF joins.  Emptying
    only the four budgeted fields -- while keeping one placeholder entry per
    document / history message / question, so the per-entry markup survives --
    leaves exactly the part of the prompt this node cannot trim.

    Copies are shallow and the placeholders are minimal (``Doc(page_content='')``
    rather than a copy of a document that may carry an embedding), because the
    result is rendered once and thrown away, never mutated or forwarded.
    """
    return question.model_copy(
        update={
            'role': '',
            'history': [QuestionHistory(role=h.role, content='') for h in (question.history or [])],
            'documents': [Doc(page_content='') for _ in (question.documents or [])],
            'questions': [QuestionText(text='') for _ in (question.questions or [])],
        }
    )


# Tokens reserved for the line break ``getPrompt()`` appends after a non-empty
# role, which the blanked rendering cannot see (real BPE tokenizers spend up to
# two tokens on it)
_ROLE_BREAK_MARGIN = 2


def prompt_overhead_tokens(optimizer, question: Question) -> int:
    """Count the tokens ``getPrompt()`` spends outside the budgeted fields.

    Measured from the real rendering (see :func:`blank_budgeted_fields`) with
    the optimizer's own tokenizer, rather than guessed at.

    The figure is deliberately conservative: it keeps the markup of every
    document, history message and question entry even though pass 2 may drop
    some of them, and a history message's role is counted both by the
    optimizer's message envelope and by the rendered ``role:`` prefix.  The one
    thing the blanked rendering cannot see is the line break ``getPrompt()``
    appends after a non-empty role; a BPE tokenizer may spend up to two tokens
    on it, so that margin is added to keep the figure erring high.
    """
    return optimizer.count_tokens(blank_budgeted_fields(question).getPrompt()) + _ROLE_BREAK_MARGIN


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

        # Gather every question text.  ``entry_texts`` stays index-aligned with
        # ``question.questions`` so each entry can be rewritten in place below;
        # ``query_str`` is the merged view the optimizer budgets against.
        entry_texts = [(q.text or '') for q in (question.questions or [])]
        query_str = ' '.join(text for text in entry_texts if text)

        # Convert documents to optimizer format, preserving all fields (e.g. score)
        docs = []
        for doc in question.documents or []:
            doc_dict = doc.model_dump() if hasattr(doc, 'model_dump') else doc.dict()
            docs.append(
                {
                    **doc_dict,
                    'content': doc_dict.get('content', doc_dict.get('page_content', '')),
                    '_original': doc,
                }
            )

        # Convert history to optimizer format
        history = [{'role': h.role, 'content': h.content} for h in (question.history or [])]

        # Everything getPrompt() renders that this node does not budget --
        # instructions, examples, context, goals and the section markup -- still
        # occupies the window, so measure it and let the optimizer subtract it
        # before allocating the four budgets.
        overhead_tokens = prompt_overhead_tokens(optimizer, question)

        # ---- Run optimization ----
        result = optimizer.optimize(
            question=query_str,
            system_prompt=system_prompt,
            documents=docs,
            history=history,
            overhead_tokens=overhead_tokens,
        )

        # ---- Rebuild the Question with optimized content ----

        # Update role / system prompt
        question.role = result['system_prompt'] or ''

        # Update questions -- rewrite each entry's text in place.
        #
        # Every QuestionText entry is preserved: downstream embedding nodes
        # embed each entry and the document stores read per-entry embedding
        # metadata, so collapsing the list here would silently drop both.  A
        # single entry takes the optimizer's merged result directly; several
        # entries share the query budget, each keeping a slice proportional to
        # its own size (see ``ContextOptimizer.truncate_each_to_budget``).
        if question.questions:
            if len(question.questions) == 1:
                question.questions[0].text = result['question'] or ''
            elif result['question'] != query_str:
                # The merged query was truncated, so the entries have to be
                # trimmed to the same shared allowance.
                meta = result.get('metadata') or {}
                budget = (meta.get('budget') or {}).get('query')
                if not isinstance(budget, int) or isinstance(budget, bool):
                    # Older/foreign result shapes: fall back to the size the
                    # optimizer actually produced for the merged query.
                    budget = optimizer.count_tokens(result['question'] or '', meta.get('encoding'))
                trimmed = optimizer.truncate_each_to_budget(entry_texts, budget, meta.get('encoding'))
                debug(
                    f'context_optimizer: query truncated; {len(question.questions)} question entries '
                    f'share a {budget}-token budget'
                )
                for entry, text in zip(question.questions, trimmed):
                    entry.text = text
            # else: nothing was truncated -- every entry keeps its text as-is.
        elif result['question']:
            debug(
                f'context_optimizer: optimized question text produced but question.questions is empty, discarding: {result["question"][:200]}'
            )

        # Update documents -- keep only the selected ones
        if question.documents is not None:
            selected_originals = [d['_original'] for d in result['documents'] if '_original' in d]
            question.documents = selected_originals

        # Update history -- always apply optimizer result (empty list clears history)
        question.history = [QuestionHistory(role=m['role'], content=m['content']) for m in result['history']]

        # ---- Attach optimization metadata as context ----
        meta = result['metadata']
        meta_text = f'[Context optimization: tokens_used={meta["tokens_used"]}, tokens_saved={meta["tokens_saved"]}, overhead_tokens={meta.get("overhead_tokens", 0)}, components_truncated={meta["components_truncated"]}, model={meta["model"]}, total_limit={meta["total_limit"]}]'
        debug(meta_text)

        # Forward the optimized question
        self.instance.writeQuestions(question)
