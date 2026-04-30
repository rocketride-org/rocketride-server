from typing import Any

class Instance:
    def __init__(self, IGlobal):
        self.IGlobal = IGlobal

    def open(self, obj: Any):
        # Called when new object starts
        pass

    def process(self, data: Any):
        # Run ML prediction
        if not self.IGlobal.preprocessor:
            return {'error': 'PreProcessor not initialized'}

        try:
            result = self.IGlobal.preprocessor.run({'price': data})
            return result
        except Exception as e:
            return {'error': str(e)}

    def close(self):
        # Called when processing ends
        pass
