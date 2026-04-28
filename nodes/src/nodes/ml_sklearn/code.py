import pickle
import os

class Node:
    def __init__(self):
        # Load model safely
        model_path = os.path.join(os.path.dirname(__file__), "model.pkl")
        with open(model_path, "rb") as f:
            self.model = pickle.load(f)

    def run(self, input_data):
        try:
            # Validate input
            if not isinstance(input_data, dict):
                return {"error": "Input must be a dictionary"}

            price = input_data.get("price")

            if price is None:
                return {"error": "Missing 'price'"}

            # Convert to float safely
            try:
                price = float(price)
            except ValueError:
                return {"error": "Price must be a number"}

            # Prediction
            prediction = self.model.predict([[price]])

            return {
                "prediction": float(prediction[0])
            }

        except Exception:
            return {"error": "Prediction failed"}
