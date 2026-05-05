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

    def writeAnswers(self, question):
        """
        Receive a question from upstream, run sklearn inference on its text,
        and forward the result downstream.
        """
        if self.IGlobal.preprocessor is None:
            raise RuntimeError('sklearn PreProcessor not initialized')

        question = copy.deepcopy(question)

        # Text extract karo
        text = question.text if hasattr(question, 'text') else str(question)

        # Inference chalao — returns str directly
        result = self.IGlobal.preprocessor.process(text)

        # String result assign karo (list nahi!)
        question.text = result

        self.instance.writeAnswers(question)
