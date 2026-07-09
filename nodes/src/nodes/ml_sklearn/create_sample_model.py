# =============================================================================
# Run this once to generate a sample model.pkl for testing:
#   python nodes/src/nodes/ml_sklearn/create_sample_model.py
# =============================================================================
import joblib
import numpy as np
from sklearn.linear_model import LinearRegression

# Simple model: y = 2x + 1
X = np.array([[1.0], [2.0], [3.0], [4.0], [5.0]])
y = np.array([3.0, 5.0, 7.0, 9.0, 11.0])

model = LinearRegression()
model.fit(X, y)

import os

model_dir = os.path.join(os.path.dirname(__file__), 'models')
os.makedirs(model_dir, exist_ok=True)
save_path = os.path.join(model_dir, 'model.pkl')
joblib.dump(model, save_path)

print(f'✅ Model saved: {save_path}')
print(f'✅ predict(4.0) = {model.predict([[4.0]])[0]:.1f}  (expected 9.0)')
print(f'✅ predict(6.0) = {model.predict([[6.0]])[0]:.1f}  (expected 13.0)')
