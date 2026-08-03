# ML Sklearn Prediction Node

This node performs predictions using a trained scikit-learn model.

## Input

- text (number as string)

## Output

- text (predicted value as string)

## Example

> [!WARNING]
> The `model_path` configuration parameter must point to a trusted model file. Loading untrusted scikit-learn model files (pickles) can result in arbitrary code execution on the server.

Input:
4.0

Output:
9.0
