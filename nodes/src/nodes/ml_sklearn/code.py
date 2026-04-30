import pickle
import os

class PreProcessor:
    '''ML Sklearn Prediction Node'''

    def __init__(self, *args, **kwargs):
        '''Load trained sklearn model'''
        model_path = os.path.join(os.path.dirname(__file__), 'model.pkl')
        with open(model_path, 'rb') as f:
            self.model = pickle.load(f)

    def run(self, input_data):
        try:
            if not isinstance(input_data, dict):
                return {'error': 'Input must be a dictionary'}

            price = input_data.get('price')

            if price is None:
                return {'error': "Missing 'price'"}

            try:
                price = float(price)
            except (ValueError, TypeError):
                return {'error': 'Price must be a number'}

            prediction = self.model.predict([[price]])

            return {'prediction': float(prediction[0])}

        except Exception as e:
            return {'error': str(e)}
