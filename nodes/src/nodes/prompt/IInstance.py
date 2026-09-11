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

from rocketlib import IInstanceBase
from .IGlobal import IGlobal
from ai.common.schema import Question
from rocketlib import debug, error, Entry


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def __init__(self):
        """Initialize the prompt node instance state."""
        super().__init__()
        self.has_output = False
        self._reset()

    def _reset(self):
        """
        A fresh question for a fresh turn.

        THE INSTANCE OUTLIVES THE TURN. A resident task keeps this object between
        turns, so a question that is merged but never replaced accumulates: every
        `addContext` from every turn stays on it, and `closing` re-adds the
        configured instructions on top of the ones it added last time. Left alone
        it grows without bound - and because a chat is not part of a task's
        identity, the turns it gathers are not even all from the same conversation.

        That is worse than noise. Context carries what the person said, so a
        request they made and that was answered turns ago is still sitting there
        in the imperative, indistinguishable from the one they just made. The
        agent reads it as live and does it again.

        Only the question: `has_output` is the turn's RESULT, and `closing` runs
        this on its way out, after setting it.
        """
        self.question = Question()

    def open(self, entry: Entry):
        # The turn starts here, so the question does too.
        self.has_output = False
        self._reset()

    def writeQuestions(self, question: Question):
        """
        Collect questions for merging.
        """
        for q in question.questions:
            self.question.addQuestion(q.text)

    def writeDocuments(self, documents):
        """
        Collect documents for merging.
        """
        # Create a question from documents
        self.question.addDocuments(documents)

    def writeText(self, text: str):
        """
        Collect text for merging.
        """
        # Create a question from text

        self.question.addContext(text)

    def writeTable(self, table: str):
        """
        Collect table data for merging.
        """
        # Create a question from table data
        self.question.addContext(table)

    def _received_input(self):
        """Whether anything at all was written to this node during the turn."""
        return any(getattr(self.question, lane, None) for lane in ('context', 'questions', 'documents'))

    def closing(self):
        """
        When the node is closing, merge all collected inputs into one question.

        SILENCE WHEN NOTHING ARRIVED. A pipe can hold several prompt nodes - one
        per intake lane - and a turn reaches exactly one of them. The others were
        still emitting, because closing does not otherwise ask whether anything
        was written, and a question carrying nothing but its own instructions is
        still a question: downstream an agent answers it, so one turn drew two
        answers, and whatever the empty lane produced was recorded as what the
        person asked. A node that heard nothing has nothing to ask.
        """
        # Decided by THIS close alone, even one driven without a matching open.
        self.has_output = False
        try:
            if not self._received_input():
                return

            # Get the instructions from configuration via IGlobal
            config = self.IGlobal.config
            instructions = config.get(
                'instructions', ['Please provide a detailed and helpful response to the following question:']
            )

            # Ensure instructions is a list
            if isinstance(instructions, str):
                instructions = [instructions]

            # Add each instruction to the question
            for i, instruction in enumerate(instructions):
                instruction_name = f'User Instruction {i + 1}' if len(instructions) > 1 else 'User Instruction'
                self.question.addInstruction(instruction_name, instruction)

            debug(f'Enhanced question: {self.question.getPrompt()}')

            # Output the single merged question
            self.instance.writeQuestions(self.question)
            self.has_output = True

        except Exception as e:
            # NOTHING IS EMITTED ON THE WAY OUT. What stood here recovered from
            # `self.collected_inputs`, a list nothing in the repo ever appended
            # to — it was written once in `__init__` and read here, so the
            # recovery could never fire and read as a safety net that was not
            # one. A half-built question is worse than none: downstream an agent
            # answers whatever is emitted, and an answer to a question the
            # person did not ask is recorded as what they wanted.
            #
            # AT ERROR LEVEL, because a turn was dropped: the person asked
            # something and nothing downstream will answer it, which looks from
            # the outside like the pipeline ignoring them. The exception TYPE is
            # named — a bare message reads the same for a missing config key as
            # for a broken collaborator.
            error(f'prompt node dropped a turn: {type(e).__name__}: {e}')
        finally:
            # Belt and braces with `open`: the next turn starts clean even if this
            # one raised on its way out, and even if the node is driven to close
            # without a matching open.
            self._reset()
