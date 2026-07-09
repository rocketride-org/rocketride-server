# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide Contributors
# =============================================================================
import copy
from rocketlib import IInstanceBase, Entry
from ai.common.schema import Answer
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def open(self, obj: Entry):
        pass

    def _process(self, text: str) -> str:
        if self.IGlobal.preprocessor is not None:
            return self.IGlobal.preprocessor.process(text)
        return text

    def writeAnswers(self, answer: Answer):
        """Process answer text through sklearn model and forward downstream."""
        if not answer:
            return
        answer = copy.deepcopy(answer)
        text = answer.getText()
        result = self._process(text)
        answer.setAnswer(result)
        self.instance.writeAnswers(answer)
