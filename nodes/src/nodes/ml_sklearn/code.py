import pickle
import os

class PreProcessor:
    '''ML Sklearn Prediction Node'''

    def __init__(self, *args, **kwargs):
        model_path = os.path.join(os.path.dirname(__file__), 'model.pkl')
        try:
            with open(model_path, 'rb') as f:
                self.model = pickle.load(f)
        except Exception:
            self.model = None

    def process(self, text):
        try:
            if not self.model or text is None:
                return text

            value = float(str(text).strip())

            prediction = self.model.predict([[value]])

            return str(prediction[0])

        except Exception:
            return text
