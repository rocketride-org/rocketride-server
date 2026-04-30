from typing import Optional
from .code import PreProcessor

class IGlobal:
    def __init__(self, IEndpoint):
        self.IEndpoint = IEndpoint
        self.glb = None
        self.preprocessor: Optional[PreProcessor] = None

    def beginGlobal(self):
        # Access endpoint global config
        self.glb = self.IEndpoint.endpoint.glb

        # Initialize PreProcessor
        try:
            self.preprocessor = PreProcessor()
        except Exception as e:
            raise RuntimeError(f"Failed to initialize ML PreProcessor: {str(e)}")

    def endGlobal(self):
        # Cleanup if needed
        self.preprocessor = None
