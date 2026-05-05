# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide Contributors
# =============================================================================
import copy
from rocketlib import IInstanceBase, Entry
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Per-thread instance for the ml_sklearn node."""

    IGlobal: IGlobal

    def open(self, obj: Entry):
        pass

    def _process(self, text: str) -> str:
        """Run inference or passthrough."""
        if self.IGlobal.preprocessor is not None:
            return self.IGlobal.preprocessor.process(text)
        return text

    def writeText(self, question):
        """Called by engine when text lane input arrives."""
        question = copy.deepcopy(question)
        text = question.text if hasattr(question, 'text') else str(question)
        question.text = self._process(text)
        self.instance.writeAnswers(question)

    def writeAnswers(self, question):
        """Called by engine when answers lane input arrives."""
        question = copy.deepcopy(question)
        text = question.text if hasattr(question, 'text') else str(question)
        question.text = self._process(text)
        self.instance.writeAnswers(question)
