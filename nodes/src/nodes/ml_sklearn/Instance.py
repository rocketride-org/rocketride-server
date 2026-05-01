# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide Contributors
# =============================================================================

# ------------------------------------------------------------------------------
# This class controls the data for each thread of the task
# ------------------------------------------------------------------------------
import copy

from rocketlib import IInstanceBase, Entry

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Per-thread instance for the ml_sklearn node."""

    IGlobal: IGlobal

    def open(self, obj: Entry):
        """Called before each new pipeline object — nothing to reset for this node."""
        pass

    def writeAnswers(self, question):
        """
        Receive a question from upstream, run sklearn inference on its text,
        and forward the result to the answers output lane.

        The question is deep-copied to prevent mutation in fan-out pipelines.
        """
        if self.IGlobal.preprocessor is None:
            raise RuntimeError('sklearn PreProcessor not initialized')

        question = copy.deepcopy(question)

        # Get the text to process
        text = question.text if hasattr(question, 'text') else str(question)

        # Run inference
        result = self.IGlobal.preprocessor.process(text)

        # Write result back to the question object and forward downstream
        question.text = result
        self.instance.writeAnswers(question)
