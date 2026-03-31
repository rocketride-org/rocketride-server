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
from .template_engine import render
from ai.common.schema import Question
from rocketlib import debug, Entry


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def __init__(self):
        """Initialize the prompt template node instance state."""
        super().__init__()
        self.collected_text: list[str] = []
        self.question = Question()

    def open(self, entry: Entry):
        pass

    def _get_template_context(self) -> dict:
        """Build the context dictionary for template rendering."""
        config = self.IGlobal.config
        variables = config.get('variables', {})
        if not isinstance(variables, dict):
            variables = {}

        # Add collected text as 'input' if available
        if self.collected_text:
            variables.setdefault('input', '\n'.join(self.collected_text))

        return variables

    def writeQuestions(self, question: Question):
        config = self.IGlobal.config
        template = config.get('template', '{{input}}')
        context = self._get_template_context()

        for q in question.questions:
            context['question'] = q.text
            rendered = render(template, context)
            self.question.addQuestion(rendered)

    def writeText(self, text: str):
        self.collected_text.append(text)

    def closing(self):
        try:
            config = self.IGlobal.config
            template = config.get('template', '{{input}}')
            context = self._get_template_context()

            # If we have questions, output them
            if self.question.questions:
                self.instance.writeQuestions(self.question)
            # If we only have text input, render and output as text
            elif self.collected_text:
                rendered = render(template, context)
                self.instance.writeText(rendered)

        except Exception as e:
            debug(f'Error in prompt_template node: {e}')
