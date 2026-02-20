# MIT License
#
# Copyright (c) 2026 RocketRide, Inc.
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
Document Grouping for Organized Search Results.

This module provides the DocGroup class for organizing related document chunks
that come from the same source file. When you search and get multiple chunks
from the same document, they can be grouped together for easier processing.

Usage:
    # Typically you receive DocGroups from search operations
    grouped_results = await client.search_grouped(query="financial reports")

    for group in grouped_results:
        print(f"File: {group.parent}")
        print(f"Overall relevance: {group.score}")
        print(f"Contains {len(group.documents)} chunks")

        for doc in group.documents:
            print(f"  Chunk {doc.metadata.chunkId}: {doc.page_content[:100]}...")
"""

import os
from typing import List
from pydantic import BaseModel, Field
from .doc import Doc


class DocGroup(BaseModel):
    """
    Groups related document chunks that come from the same source file.

    When you search RocketRide and multiple chunks are found from the same document,
    they can be organized into DocGroups for easier processing. This helps you
    understand which content comes from which files and work with complete documents
    rather than scattered fragments.

    This is especially useful when you want to:
    - See all relevant content from a specific file
    - Understand the context around found content
    - Process complete documents rather than individual chunks
    - Get a unified relevance score for entire files

    Attributes:
        score: Overall relevance score for this entire document/file
        objectId: Unique identifier for the source document object
        parent: File path or name of the source document
        documents: List of all document chunks from this file

    Example:
        for group in search_results:
            print(f"Found relevant content in: {group.parent}")
            print(f"File relevance score: {group.score:.2f}")
            print(f"Number of relevant sections: {len(group.documents)}")

            # Process all chunks from this file
            full_content = ""
            for doc in group.documents:
                full_content += doc.page_content + "(CRLF)"

            print(f"Complete relevant content: {full_content}")
    """

    score: float = Field(0.0, description='Overall relevance score for this entire document/file. Higher scores indicate the file is more relevant to your query.')
    objectId: str = Field('', description='Unique identifier for this document object in the RocketRide system.')
    parent: str = Field('', description='File path or name of the source document. This is typically the filename you would recognize.')
    documents: List[Doc] = Field(default_factory=list, description='List of all document chunks from this file that matched your query.')

    def __repr__(self):
        """
        Create a readable string representation showing the filename and relevance score.

        Returns:
            str: Format like "filename.pdf=0.85" for easy identification and debugging
        """
        filename = os.path.basename(self.parent)
        return f'{filename}={self.score}'
