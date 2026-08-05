# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

from rocketlib import IInstanceBase, AVI_ACTION, warning
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeDocuments(self, documents):
        docs = documents if isinstance(documents, list) else [documents]
        text = '\n'.join(
            doc.page_content for doc in docs if doc.page_content and doc.type not in ('Image', 'Audio', 'Video')
        )
        self.writeText(text)

    def writeQuestions(self, question):
        text = ' '.join(q.text for q in question.questions) if question.questions else ''
        self.writeText(text)

    def writeAnswers(self, answer):
        text = answer.getText() if hasattr(answer, 'getText') else str(answer)
        self.writeText(text)

    def writeText(self, text: str):
        value = (text or '').strip()
        if not value:
            return

        try:
            raw, mime = self.IGlobal.synthesize(value)
            self.instance.writeAudio(AVI_ACTION.BEGIN, mime)
            self.instance.writeAudio(AVI_ACTION.WRITE, mime, raw)
            self.instance.writeAudio(AVI_ACTION.END, mime)
        except Exception as e:
            warning(f'Cloud TTS synthesis failed: {e}')
            raise
