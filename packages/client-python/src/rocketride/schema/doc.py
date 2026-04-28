# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Document Model for RocketRide Search Results.

This module defines the Doc class which represents individual documents returned from
RocketRide search operations, AI queries, and data processing pipelines.

Usage:
    # Documents are typically returned from search operations
    results = await client.search(query="machine learning")
    for doc in results:
        print(f"Content: {doc.page_content}")
        print(f"Score: {doc.score}")
        print(f"File: {doc.metadata.parent}")

    # Convert to/from dictionaries for serialization
    doc_dict = doc.toDict()
    restored_doc = Doc.fromDict(doc_dict)
"""

from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field
from .doc_metadata import DocMetadata


class Doc(BaseModel):
    """
    Represents a document returned from RocketRide operations like search, AI chat, or data processing.

    Documents contain the actual content text, relevance scoring, embeddings for semantic search,
    and metadata about the source file and location. This is the primary data structure you'll
    work with when processing search results or AI responses.

    Attributes:
        page_content: The actual text content of this document chunk
        score: How relevant this document is to your query (higher = more relevant)
        highlight_score: Additional scoring for highlighted/featured content
        embedding: Vector representation used for semantic search (typically hidden from users)
        metadata: Information about the source file, chunk position, permissions, etc.
        context: Additional contextual information related to this document
        tokens: Number of tokens in this document (for AI processing limits)

    Example:
        # Working with search results
        for doc in search_results:
            print(f"Found content: {doc.page_content[:100]}...")
            print(f"From file: {doc.metadata.parent}")
            print(f"Relevance: {doc.score:.2f}")

            if doc.metadata.isTable:
                print("This is table data")
    """

    type: str = Field(default='Document', description='Type identifier of the document.')
    page_content: Optional[str] = Field(None, description='The main text content of this document chunk.')
    embedding_model: Optional[str] = Field(
        None, description='The AI model used to generate embeddings for this document.'
    )
    embedding: List[float] = Field(
        None, description='Vector representation for semantic search (usually hidden from end users).'
    )
    score: float = Field(None, description='Relevance score - higher numbers mean more relevant to your query.')
    highlight_score: float = Field(None, description='Additional score for highlighted or featured content.')
    context: Optional[List[str]] = Field(
        None, description='Additional contextual information related to this document.'
    )
    tokens: Optional[int] = Field(
        None, description='Number of tokens in this document (important for AI processing limits).'
    )
    metadata: Optional[DocMetadata] = Field(
        None, description='Information about the source file, location, permissions, and chunk details.'
    )

    def __repr__(self):
        """
        Create a readable string representation showing the key identifiers and relevance score.

        Returns:
            str: Format like "Document(objectId.chunkId=score)" for easy debugging
        """
        return f'Document({self.metadata.objectId}.{self.metadata.chunkId}={self.score})'

    def toDict(self) -> Dict[str, Any]:
        """
        Convert this document to a dictionary for serialization or storage.

        Useful when you need to save search results to files, send over networks,
        or store in databases. Excludes None/null values to keep the output clean.

        Returns:
            Dict[str, Any]: Dictionary representation of this document

        Example:
            doc_data = doc.toDict()
            json.dump(doc_data, file)  # Save to JSON file
        """
        return self.model_dump(exclude_none=True)

    @staticmethod
    def fromDict(dump: Dict[str, Any]) -> 'Doc':
        """
        Create a Document from a dictionary (reverse of toDict).

        Use this when loading saved search results, receiving data over networks,
        or reconstructing documents from stored data.

        Args:
            dump: Dictionary containing document data (from toDict())

        Returns:
            Doc: A new Document instance with the provided data

        Example:
            doc_data = json.load(file)  # Load from JSON file
            doc = Doc.fromDict(doc_data)
        """
        return Doc.model_validate(dump)
