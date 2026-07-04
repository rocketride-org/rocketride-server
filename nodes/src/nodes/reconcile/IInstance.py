# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import json
from typing import List
from rocketlib import IInstanceBase, Entry
from ai.common.schema import Doc, DocMetadata, Question, QuestionType, Answer
from ai.common.util import normalize
from .IGlobal import IGlobal
from rocketlib.types import IInvokeLLM


class IInstance(IInstanceBase):
    IGlobal: IGlobal
    collected_answers: List = []

    def open(self, obj: Entry):
        """
        Initialize the instance for a new object.
        """
        self.collected_answers = []

    def writeAnswers(self, answer: Answer):
        """
        Collect incoming answers to be reconciled in the closing phase.
        """
        answer_json = answer.getJson()
        if isinstance(answer_json, list):
            self.collected_answers.extend(answer_json)
        else:
            self.collected_answers.append(answer_json)

        # Do not pass the answer downstream immediately, we will reconcile at the end
        self.preventDefault()

    def closing(self):
        """
        Perform the reconciliation when the data stream is complete.
        """
        if not self.collected_answers:
            return

        question: Question = Question(
            type=QuestionType.QUESTION, 
            expectJson=True, 
            role='You are an expert financial auditor.'
        )

        question.addInstruction(
            'Reconciliation Task',
            normalize("""
            Examine the provided structured data from multiple sources (e.g., extracted from a PDF and an official filing).
            Identify any discrepancies, mismatches, or disagreements in the data points.
            """)
        )

        question.addInstruction(
            'Output Format',
            normalize("""
            Return a JSON object containing a detailed reconciliation report. Include a list of discrepancies found, 
            showing the field name, the value from the first source, the value from the second source, and an 
            explanation of the difference. If no discrepancies are found, report that they match perfectly.
            """)
        )

        question.addContext(self.collected_answers)

        # Invoke the LLM to perform reconciliation
        result = self.instance.invoke(IInvokeLLM.Ask(question=question))
        reconciled_report = result.getJson()

        if self.instance.hasListener('answers'):
            # Send the reconciliation report downstream as an answer
            answer = Answer(expectJson=True)
            answer.setAnswer(reconciled_report)
            self.instance.writeAnswers(answer)

        if self.instance.hasListener('documents'):
            # Also send it as a document (e.g. for indexing)
            metadata = DocMetadata(
                self,
                chunkId=0,
                isTable=False,
                tableId=0,
                isDeleted=False,
            )
            doc = Doc(page_content=json.dumps(reconciled_report), metadata=metadata)
            self.instance.writeDocuments([doc])
