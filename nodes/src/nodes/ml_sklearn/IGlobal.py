from .code import PreProcessor

class IGlobal:
    def __init__(self, IEndpoint):
        self.IEndpoint = IEndpoint
        self.glb = None
        self.preprocessor = None

    def beginGlobal(self):
        self.glb = self.IEndpoint.endpoint.glb
        try:
            self.preprocessor = PreProcessor()
        except Exception:
            self.preprocessor = None

    def endGlobal(self):
        self.preprocessor = None
