# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide Contributors
# =============================================================================
import copy
from rocketlib import IInstanceBase, Entry
from . import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def open(self, obj: Entry):
        pass

    def _process(self, text: str) -> str:
        if self.IGlobal.preprocessor is not None:
            return self.IGlobal.preprocessor.process(text)
        return text

    def writeText(self, text: str):
        """Engine calls this with plain string from text lane."""
        result = self._process(text)
        self.instance.writeAnswers(result)

    def writeAnswers(self, question):
        """Engine calls this with question object from answers lane."""
        question = copy.deepcopy(question)
        text = getattr(question, 'text', '') or str(question)
        question.text = self._process(text)
        self.instance.writeAnswers(question)
