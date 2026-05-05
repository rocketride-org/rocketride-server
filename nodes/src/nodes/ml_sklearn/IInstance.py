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
        If no model is loaded, forward input unchanged.
        """
        question = copy.deepcopy(question)

        # Text extract karo
        text = question.text if hasattr(question, 'text') else str(question)

        # Inference — model nahi hai toh passthrough
        if self.IGlobal.preprocessor is not None:
            result = self.IGlobal.preprocessor.process(text)
        else:
            result = text  # fallback — input unchanged forward karo

        question.text = result
        self.instance.writeAnswers(question)