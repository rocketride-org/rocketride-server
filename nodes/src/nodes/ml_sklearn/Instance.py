class Instance:
    def __init__(self, IGlobal):
        self.IGlobal = IGlobal

    def process(self, text):
        try:
            if self.IGlobal.preprocessor:
                return self.IGlobal.preprocessor.process(text)
        except Exception:
            pass

        return text
