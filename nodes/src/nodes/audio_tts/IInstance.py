# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import os
from typing import Optional

from rocketlib import IInstanceBase, AVI_ACTION, warning
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeDocuments(self, documents):
        docs = documents if isinstance(documents, list) else [documents]
        text = '\n'.join(doc.page_content for doc in docs if doc.page_content)
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

        temp_path: Optional[str] = None
        try:
            payload = self.IGlobal.synthesize(value)
            temp_path = payload['path']
            with open(temp_path, 'rb') as fin:
                raw = fin.read()
            mime = payload['mime_type']
            self.instance.writeAudio(AVI_ACTION.BEGIN, mime)
            self.instance.writeAudio(AVI_ACTION.WRITE, mime, raw)
            self.instance.writeAudio(AVI_ACTION.END, mime)
        except Exception as e:
            warning(f'TTS synthesis failed: {e}')
            raise
        finally:
            if temp_path:
                try:
                    os.remove(temp_path)
                except OSError:
                    pass
