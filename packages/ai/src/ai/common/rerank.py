"""
Reranks grouped search results by examining the entire group.

The group is then assigned a ranking score
"""

import re
from typing import List
from rank_bm25 import BM25Okapi  # type: ignore

from .schema import Doc, DocGroup


class ReRank:
    @classmethod
    def rerankDocuments(cls, query: str, documents: List[Doc]) -> List[Doc]:
        """
        Use the BM25 reranker to rerank the result documents.

        It does this by passing the page content over to the reranker
        """
        # Gather up all the text
        docList: List[List[str]] = []

        # Append all the chunks text from each document group
        for doc in documents:
            # Gather up all the chunks
            docList.append(re.split(r'\s|\|', doc.page_content.lower()))

        # Create the BM25 reranker based on this document
        bm25 = BM25Okapi(docList)

        # Token the question
        tokenQuestion = query.lower().split()

        # Get the scores on each group
        scores = bm25.get_scores(tokenQuestion)

        for index in range(0, len(scores)):
            documents[index].score = documents[index].score + scores[index]

        # Sort the grouped document list by it's aggregated score
        documents.sort(key=lambda document: document.score, reverse=True)
        return documents

    @classmethod
    def rerankGroups(cls, query: str, groups: List[DocGroup]) -> List[DocGroup]:
        """
        Use the BM25 reranker to rerank the result document groups.

        It does this by combining all the document chunks within a group together and
        ranking them all as a group. The score is saved in SearchGroup.score.
        """
        # Gather up all the text
        groupList = []
        for group in groups:
            # Sort them by chunk
            group.documents.sort(key=lambda doc: doc.metadata.chunkId)

            # Rerank all the documents within the group
            group.documents = ReRank.rerankDocuments(query, group.documents)

            # Create the text list
            textList: List[str] = []

            # Append all the chunks text from each document group
            for chunk in group.documents:
                textList.append(chunk.page_content)

            # Get the total text
            text = '\n'.join(textList)

            # Gather up all the chunks
            groupList.append(re.split(r'\s|\|', text.lower()))

        # Create the BM25 reranker based on this document
        bm25 = BM25Okapi(groupList)

        # Tokenize the question
        tokenQuestion = query.split()

        # Get the scores on each group
        scores = bm25.get_scores(tokenQuestion)

        results: List[DocGroup] = []
        for index in range(0, len(scores)):
            groups[index].score = scores[index]
            results.append(groups[index])

        # Sort the grouped document list by it's aggregated score
        results.sort(key=lambda group: group.score, reverse=True)
        return results
