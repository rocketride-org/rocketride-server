# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

from rocketlib import IGlobalBase
from ai.common.config import Config


class IGlobal(IGlobalBase):
    # Faithfulness: are all claims in the answer grounded in the context?
    faithfulness: bool = True
    faithfulness_threshold: float = 0.7

    # Answer Relevancy: does the answer address the question?
    answer_relevancy: bool = True
    answer_relevancy_threshold: float = 0.7

    # Context Precision: is the retrieved context precisely relevant?
    context_precision: bool = False
    context_precision_threshold: float = 0.7

    # Context Recall: does the context contain everything needed?
    context_recall: bool = False
    context_recall_threshold: float = 0.7

    # Factual Correctness: is the answer factually correct vs ground truth?
    factual_correctness: bool = False
    factual_correctness_threshold: float = 0.7

    # Static ground truth for metrics that require it
    ground_truth: str = ''

    @staticmethod
    def _to_bool(value, default: bool) -> bool:
        # Config stores booleans as "true"/"false" strings (from the string enum field type)
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.lower() == 'true'
        return default

    def beginGlobal(self) -> None:
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        self.faithfulness = self._to_bool(config.get('faithfulness'), True)
        self.faithfulness_threshold = float(config.get('faithfulness_threshold', 0.7))

        self.answer_relevancy = self._to_bool(config.get('answer_relevancy'), True)
        self.answer_relevancy_threshold = float(config.get('answer_relevancy_threshold', 0.7))

        self.context_precision = self._to_bool(config.get('context_precision'), False)
        self.context_precision_threshold = float(config.get('context_precision_threshold', 0.7))

        self.context_recall = self._to_bool(config.get('context_recall'), False)
        self.context_recall_threshold = float(config.get('context_recall_threshold', 0.7))

        self.factual_correctness = self._to_bool(config.get('factual_correctness'), False)
        self.factual_correctness_threshold = float(config.get('factual_correctness_threshold', 0.7))

        self.ground_truth = config.get('ground_truth', '') or ''

    def endGlobal(self) -> None:
        pass
