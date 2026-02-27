# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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
from rocketlib.types import IInvokeLLM
from ai.common.schema import Question, Answer


class IInstanceGenericLLM(IInstanceBase):
    def _question(self, question: Question) -> Answer:
        # Get the answer
        answer = self.IGlobal._chat.chat(question)

        # Return the answer
        return answer

    def writeQuestions(self, question: Question):
        # Get the answer
        answer = self._question(question)

        # Send off the answer
        self.instance.writeAnswers(answer)

    def invoke(self, param: IInvokeLLM) -> Answer:
        if not isinstance(param, IInvokeLLM):
            raise Exception(f'Invoke param should be IInvokeLLM, but found {type(param)}')
        match param.op:
            case 'getContextLength':
                return self.IGlobal._chat.getTotalTokens()
            case 'getOutputLength':
                return self.IGlobal._chat.getOutputTokens()
            case 'getTokenCounter':
                return self.IGlobal._chat.getTokens
            case 'ask':
                return self._question(param.question)
            case _:
                raise Exception(f'Invoke operation {param.op} is not defined')
