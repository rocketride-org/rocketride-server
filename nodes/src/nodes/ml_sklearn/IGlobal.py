from .code import PreProcessor

class IGlobal:
    def __init__(self, IEndpoint):
        self.IEndpoint = IEndpoint
        self.glb = None
        self.preprocessor = None

    def beginGlobal(self):
        self.glb = self.IEndpoint.endpoint.glb
        self.preprocessor = PreProcessor()

    def endGlobal(self):
        self.preprocessor = None
