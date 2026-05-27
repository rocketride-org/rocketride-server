# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide Contributors
# =============================================================================
import os
import joblib


class PreProcessor:
    """Wraps a scikit-learn model/pipeline for text inference."""

    def __init__(self, config: dict):
        model_path = config.get('model_path', '')

        self._model = None
        if model_path and os.path.exists(model_path):
            self._model = joblib.load(model_path)

    def process(self, text: str) -> str:
        """
        Run sklearn inference on input text.
        Returns prediction as string.
        Falls back to original text if no model loaded or inference fails.
        """
        if self._model is None:
            return text

        try:
            value = float(text)
            prediction = self._model.predict([[value]])
            return str(prediction[0])
        except (ValueError, TypeError):
            return text
        except Exception:
            return text
