class Instance:
    '''ML Sklearn Instance Node'''

    def __init__(self, IGlobal):
        self.IGlobal = IGlobal

    def process(self, text):
        try:
            preprocessor = self.IGlobal.preprocessor
            if preprocessor:
                return preprocessor.process(text)
        except Exception:
            pass

        return text
