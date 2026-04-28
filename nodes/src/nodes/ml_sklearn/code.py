import pickle
import os

class Node:
    def __init__(self):
        # Load model from same folder
        model_path = os.path.join(os.path.dirname(__file__), "model.pkl")
        self.model = pickle.load(open(model_path, "rb"))

    def run(self, input_data):
        try:
            # Expect input like {"price": 200}
            price = input_data.get("price")

            if price is None:
                return {"error": "Missing 'price'"}

            # Model prediction
            prediction = self.model.predict([[price]])

            return {
                "prediction": float(prediction[0])
            }

        except Exception as e:
            return {"error": str(e)}
