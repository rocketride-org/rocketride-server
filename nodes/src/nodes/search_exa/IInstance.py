# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

from ai.common.schema import Question
from rocketlib import IInstanceBase

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeQuestions(self, question: Question) -> None:
        search = self.IGlobal.search
        if search is None:
            raise RuntimeError('search_exa: search backend not initialized')

        answer = search.chat(question)
        if self.instance.hasListener('answers'):
            self.instance.writeAnswers(answer)
        if self.instance.hasListener('text'):
            self.instance.writeText(answer.getText())
        if self.instance.hasListener('questions'):
            self.instance.writeQuestions(question)
