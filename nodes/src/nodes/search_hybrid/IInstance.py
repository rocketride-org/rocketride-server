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

from rocketlib import IInstanceBase, debug
from ai.common.schema import Doc, Question, Answer

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Instance that performs hybrid search (vector + BM25) over question documents."""

    IGlobal: IGlobal

    def writeQuestions(self, question: Question):
        """
        Perform hybrid search over the question's documents.

        1. Extract query text and documents (with vector scores) from the question.
        2. Run BM25 keyword search on document texts.
        3. Merge vector + BM25 results via Reciprocal Rank Fusion.
        4. Emit reranked documents to the output.
        """
        if self.IGlobal.engine is None:
            raise RuntimeError('Hybrid search engine not initialized')

        # Deep copy to prevent mutation corruption in fan-out branches
        question = copy.deepcopy(question)

        # Extract query text from the first question
        query_text = ''
        if question.questions:
            query_text = question.questions[0].text or ''
        if not query_text:
            debug('No query text found in question; skipping hybrid search')
            return

        # Extract documents and their vector scores
        docs = question.documents or []
        if not docs:
            debug('No documents found in question; skipping hybrid search')
            return

        # Build document dicts for the search engine
        doc_dicts: list[dict] = []
        vector_scores: list[float] = []
        for i, doc in enumerate(docs):
            doc_dict = {
                'id': str(i),
                'text': doc.page_content or '',
                'original_index': i,
            }
            doc_dicts.append(doc_dict)
            # Use the document's score as the vector score (from upstream vector DB)
            vector_scores.append(float(doc.score) if doc.score is not None else 0.0)

        # Run hybrid search
        results = self.IGlobal.engine.search(
            query=query_text,
            documents=doc_dicts,
            vector_scores=vector_scores,
            top_k=self.IGlobal.top_k,
            rrf_k=self.IGlobal.rrf_k,
        )

        # Map results back to Doc objects, preserving original metadata
        reranked_docs: list[Doc] = []
        for result in results:
            orig_idx = result.get('original_index')
            if orig_idx is not None and 0 <= orig_idx < len(docs):
                reranked_doc = copy.deepcopy(docs[orig_idx])
                # Update score with whichever ranking signal was used
                ranking_score = result.get('rrf_score')
                if ranking_score is None:
                    ranking_score = result.get('bm25_score', result.get('vector_score'))
                if ranking_score is not None:
                    reranked_doc.score = ranking_score
                reranked_docs.append(reranked_doc)

        # Update the question with reranked documents
        question.documents = reranked_docs

        # Emit reranked documents
        if reranked_docs and self.instance.hasListener('documents'):
            debug(f'Hybrid search emitting {len(reranked_docs)} reranked documents')
            self.instance.writeDocuments(reranked_docs)

        # Emit structured answer if listener exists
        if reranked_docs and self.instance.hasListener('answers'):
            context_parts = []
            for i, doc in enumerate(reranked_docs):
                score = f'{doc.score:.4f}' if doc.score is not None else 'N/A'
                snippet = (doc.page_content or '')[:500]
                context_parts.append(f'[Document {i + 1}] (score: {score})\n{snippet}')
            answer_text = f'Hybrid search returned {len(reranked_docs)} results:\n\n' + '\n\n'.join(context_parts)
            ans = Answer()
            ans.setAnswer(answer_text)
            self.instance.writeAnswers([ans])
