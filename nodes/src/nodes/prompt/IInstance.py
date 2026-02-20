# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
from rocketlib import debug, Entry


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def __init__(self):
        """Initialize the prompt node instance state."""
        super().__init__()
        self.collected_inputs = []
        self.has_output = False
        self.question = Question()

    def open(self, entry: Entry):
        pass

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

    def closing(self):
        """
        When the node is closing, merge all collected inputs into one question.
        """
        try:
            # Get the instructions from configuration via IGlobal
            config = self.IGlobal.config
            instructions = config.get('instructions', ['Please provide a detailed and helpful response to the following question:'])

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

        except Exception as e:
            debug(f'Error in prompt node: {e}')
            # If there's an error, output the first collected input
            if self.collected_inputs:
                self.instance.writeQuestions(self.collected_inputs[0][0])
