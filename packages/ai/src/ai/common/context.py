"""
Generates context information for both semantic search and keyword search.
"""

from typing import Dict, List
from itertools import groupby
from operator import attrgetter
from haystack import Document
from haystack.components.readers import ExtractiveReader

from .schema import Doc
from .config import Config


class Context:
    """
    This class creates context information around a document.
    """

    def __init__(self):
        """
        Create the context generator.
        """
        # Get our configuation
        config = Config.getConfig()

        # Get the model from our section
        self.modelContext = config['modelContext']
        self.reader = ExtractiveReader(model=config['modelContext'])
        self.reader.warm_up()

    def highlight_semantic_documents(self, query: str, h_documents: List[Document]) -> Dict:
        """
        Highlights relevant passages from a list of documents based on a user query using ExtractiveReader.

        This function utilizes a Haystack reader object to find the most relevant passages (answers)
        within a provided list of documents that correspond to a given user query.

        Args:
            query (str): The user's query to be used for highlighting.
            documents (List[Document]): List of relevant chunks wraped as Haystack Document objects

        Returns:
            None: returns a python dict with best context highlighting information
        """
        # Get the highlighted text spans for all the chunks
        highlights = self.reader.run(query=query, documents=h_documents, top_k=50, max_seq_length=512, no_answer=False)
        answers = highlights['answers']

        # If we did not get any results back
        if answers is None or not len(answers):
            raise Exception('No highlight results')

        # Sort contexts by 'document_id'
        answers.sort(key=lambda x: x.document.id)

        best_contexts = {}
        for doc_id, group in groupby(answers, key=lambda x: x.document.id):
            max_context = max(group, key=attrgetter('score'))  # select the answer span with the highest confidence score

            # Create the highlight and update the context
            highlight = [
                '...' + max_context.document.content[: max_context.document_offset.start],
                max_context.document.content[max_context.document_offset.start : max_context.document_offset.end],
                max_context.document.content[max_context.document_offset.end :] + '...',
            ]
            max_context.context = highlight

            # Find the corresponding document in the 'documents' list and update the meta
            corr_document = next(doc for doc in h_documents if doc.id == doc_id)
            max_context.meta = corr_document.meta  # Update the meta information

            # Store the max_context in the best_contexts dictionary
            best_contexts[doc_id] = max_context

        return best_contexts

    def convert_to_haystack_docs(self, docs: List[Doc]) -> List[Document]:
        """
        Convert a list of Doc objects into a list of Haystack Documents.

        Args:
            docs (List[str]): A list of chunks (Doc format) representing the document content.
        Returns:
            A list of Haystack Document objects.
        """
        return [Document(content=doc.page_content, meta=doc.metadata) for doc in docs]

    def __call__(self, query: str, useSemanticSearch: bool, documents: List[Doc]) -> List[Doc]:
        """
        Use a model to perform context marking within the document.

        Can be either keyword or semantic search results.
        """
        hys_docs = self.convert_to_haystack_docs(documents)
        best_contexts = self.highlight_semantic_documents(query, hys_docs)

        # preparing the final result
        for i in range(len(hys_docs)):
            if hys_docs[i].id in best_contexts:
                documents[i].context = best_contexts[hys_docs[i].id].context
                documents[i].highlight_score = best_contexts[hys_docs[i].id].score
            else:
                documents[i].context = None  # No feasible highlighted area found
                documents[i].highlight_score = 0.0

        # Sort contexts by 'highlight_score'
        documents.sort(key=lambda x: x.highlight_score, reverse=True)

        return documents
