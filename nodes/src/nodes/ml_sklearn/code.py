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
        if model_path:
            # SECURITY WARNING: Loading pickle/joblib files can execute arbitrary code.
            # Ensure model_path is strictly controlled and only loads models from trusted sources.
            # TODO: Consider migrating to `skops` for secure serialization of scikit-learn models.
            resolved_path = os.path.abspath(model_path)
            
            # Allowlist directory to prevent path traversal attacks
            allowed_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "models"))
            
            if os.path.exists(resolved_path) and resolved_path.startswith(allowed_dir):
                self._model = joblib.load(resolved_path)
            else:
                pass # Model path is invalid or outside allowed directory

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
