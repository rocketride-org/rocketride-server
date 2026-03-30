# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

# ------------------------------------------------------------------------------
# This class controls the data for each thread of the task
# ------------------------------------------------------------------------------
import copy

from rocketlib import IInstanceBase
from ai.common.schema import Doc, Question
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeQuestions(self, question: Question):
        """
        Receive a question with retrieved documents and rerank them by relevance.

        The question's documents are reranked using the Cohere Rerank API,
        then filtered by the configured min_score threshold. The reranked
        documents are written to the documents output lane, and an answer
        with the reranked documents is written to the answers output lane.
        """
        # Deep copy to avoid mutating the shared question object in fan-out pipelines
        question = copy.deepcopy(question)

        reranker = self.IGlobal._reranker
        if reranker is None:
            raise Exception('Reranker not initialized')

        # Extract the query text from the question
        query_text = ''
        if question.questions:
            first_question = question.questions[0]
            if hasattr(first_question, 'text'):
                query_text = first_question.text
            elif isinstance(first_question, dict):
                query_text = first_question.get('text', '')

        if not query_text:
            raise ValueError('No query text found in question')

        # Extract document texts from the question's documents
        if not question.documents:
            raise ValueError('No documents found in question to rerank')

        doc_texts = []
        original_indices = []
        for idx, doc in enumerate(question.documents):
            if hasattr(doc, 'page_content') and doc.page_content:
                doc_texts.append(doc.page_content)
                original_indices.append(idx)
            elif isinstance(doc, dict) and doc.get('page_content'):
                doc_texts.append(doc['page_content'])
                original_indices.append(idx)

        if not doc_texts:
            raise ValueError('No document content found to rerank')

        # Rerank the documents with threshold filtering
        reranked = reranker.rerank_with_threshold(
            query=query_text,
            documents=doc_texts,
        )

        # Build reranked Doc objects preserving original metadata
        reranked_docs = []
        for result in reranked:
            # Map the rerank result index (into doc_texts) back to the
            # original question.documents index.
            original_idx = original_indices[result['index']]
            original_doc = question.documents[original_idx]

            # Build a new Doc with the updated score
            if hasattr(original_doc, 'metadata'):
                metadata = original_doc.metadata
            elif isinstance(original_doc, dict):
                metadata = original_doc.get('metadata')
            else:
                metadata = None

            reranked_doc = Doc(
                page_content=result['document'],
                score=result['relevance_score'],
                metadata=metadata,
            )
            reranked_docs.append(reranked_doc)

        # Write reranked documents to the documents output lane
        if reranked_docs:
            self.instance.writeDocuments(reranked_docs)

        # Always forward the question with reranked documents (possibly empty)
        # so downstream nodes can proceed even when min_score filters all docs.
        question.documents = reranked_docs
        self.instance.writeAnswers(question)
