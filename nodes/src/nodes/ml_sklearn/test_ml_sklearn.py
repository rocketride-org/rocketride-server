# =============================================================================
# Standalone test for ml_sklearn — no pytest needed
# Run: python nodes/src/nodes/ml_sklearn/test_ml_sklearn.py
# =============================================================================
import os
import sys
import joblib
import numpy as np
from sklearn.linear_model import LinearRegression

# ---- Build a temp model ----
import tempfile
tmp = tempfile.mkdtemp()
model_path = os.path.join(tmp, "model.pkl")

X = np.array([[1.0], [2.0], [3.0], [4.0], [5.0]])
y = np.array([3.0, 5.0, 7.0, 9.0, 11.0])
model = LinearRegression()
model.fit(X, y)
joblib.dump(model, model_path)

# ---- Import PreProcessor directly ----
import importlib.util
spec = importlib.util.spec_from_file_location(
    "mlcode",  # 'mlcode' use karo — 'code' nahi, clash hoga
    os.path.join(os.path.dirname(__file__), "code.py")
    if "__file__" in dir()
    else "nodes/src/nodes/ml_sklearn/code.py"
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
PreProcessor = mod.PreProcessor

# ---- Tests ----
passed = 0
failed = 0

def check(name, condition):
    global passed, failed
    if condition:
        print(f"  PASS  {name}")
        passed += 1
    else:
        print(f"  FAIL  {name}")
        failed += 1

print("\nRunning ml_sklearn tests...\n")

# Test 1: Normal prediction
pp = PreProcessor({"model_path": model_path})
result = pp.process("4.0")
check("predict(4.0) ≈ 9.0", abs(float(result) - 9.0) < 0.1)

# Test 2: predict(6.0)
result2 = pp.process("6.0")
check("predict(6.0) ≈ 13.0", abs(float(result2) - 13.0) < 0.1)

# Test 3: No model fallback
pp2 = PreProcessor({"model_path": ""})
result3 = pp2.process("hello world")
check("no model → returns input unchanged", result3 == "hello world")

# Test 4: Bad input fallback
pp3 = PreProcessor({"model_path": model_path})
result4 = pp3.process("not a number")
check("bad input → returns input unchanged", result4 == "not a number")

# ---- Summary ----
print(f"\n{passed} passed, {failed} failed")
if failed == 0:
    print("All tests passed! ✅")
else:
    print("Some tests failed ❌")
    sys.exit(1)