import pickle
import os

class PreProcessor:
    def __init__(self, *args, **kwargs):
        model_path = os.path.join(os.path.dirname(__file__), 'model.pkl')
        try:
            with open(model_path, 'rb') as f:
                self.model = pickle.load(f)
        except Exception:
            self.model = None

    def process(self, text):
        try:
            # keep pipeline safe
            if not self.model:
                return text

            # convert input
            value = float(text)

            prediction = self.model.predict([[value]])

            # IMPORTANT: return same type (string)
            return str(prediction[0])

        except Exception:
            return text
