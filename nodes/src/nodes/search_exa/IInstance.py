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

        try:
            answer = search.chat(question)
        except TimeoutError as e:
            raise RuntimeError('search_exa: Exa request timed out') from e
        except ConnectionError as e:
            raise RuntimeError('search_exa: Unable to reach Exa') from e
        except ValueError as e:
            raise RuntimeError(f'search_exa: {e}') from e
        except Exception as e:
            raise RuntimeError(f'search_exa: Unexpected Exa error: {e}') from e

        if self.instance.hasListener('answers'):
            self.instance.writeAnswers(answer)
        if self.instance.hasListener('text'):
            self.instance.writeText(answer.getText())
        if self.instance.hasListener('questions'):
            self.instance.writeQuestions(question)
