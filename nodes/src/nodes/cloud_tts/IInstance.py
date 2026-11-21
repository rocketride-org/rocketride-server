# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Instance handler for the cloud TTS nodes.

The model and the voice are this call's (``self.settings``): one control,
whose IGlobal holds only the vendor and its key, speaks each call with the
model and voice that call asked for. On Rime the model is a selector whose
branch carries the voice, so the settings of a call that switches the model
expose that model's own voice.
"""

from rocketlib import IInstanceBase, AVI_ACTION, warning
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Turns the text of one call into one MP3 clip on the audio lane."""

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
        """
        Synthesise one text with this call's model and voice and write the clip.

        Args:
            text: The text to speak; blank text is ignored.
        """
        value = (text or '').strip()
        if not value:
            return

        try:
            settings = self.settings
            raw, mime = self.IGlobal.synthesize(value, settings.model, settings.voice)
            self.instance.writeAudio(AVI_ACTION.BEGIN, mime)
            self.instance.writeAudio(AVI_ACTION.WRITE, mime, raw)
            self.instance.writeAudio(AVI_ACTION.END, mime)
        except Exception as e:
            warning(f'Cloud TTS synthesis failed: {e}')
            raise
