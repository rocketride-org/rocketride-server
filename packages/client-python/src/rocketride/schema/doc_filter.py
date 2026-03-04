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
Document Filtering and Search Controls.

This module provides the DocFilter class for controlling search behavior, pagination,
and result processing in RocketRide operations. Use filters to refine your searches,
control how documents are grouped, and configure AI chat behavior.

Usage:
    from rocketride.schema import DocFilter, Question

    # Basic search with pagination
    filter = DocFilter(limit=50, offset=0)

    # Search only tables
    filter = DocFilter(isTable=True, limit=25)

    # Get complete documents instead of chunks
    filter = DocFilter(fullDocuments=True)

    # Use with questions/chat
    question = Question(filter=filter)
    question.addQuestion("What are the sales figures?")
"""

from pydantic import BaseModel, Field
from typing import Optional, List


class DocFilter(BaseModel):
    """
    Controls how RocketRide searches, processes, and returns documents in your queries.

    Use DocFilter to customize search behavior, pagination, content grouping,
    and AI processing options. This gives you fine-grained control over what
    documents are returned and how they're processed.

    Common Use Cases:
    - Pagination: Control which results to return (offset/limit)
    - Content grouping: Get full documents vs individual chunks
    - File type filtering: Search only tables, exclude deleted files
    - Permission filtering: Respect access controls
    - AI enhancements: Enable reranking, follow-up questions, context

    Example:
        # Paginated search for tables only
        filter = DocFilter(
            isTable=True,      # Only return table data
            limit=20,          # Return up to 20 results
            offset=0,          # Start from beginning
            useQuickRank=True  # Use AI to improve relevance
        )

        # Get complete documents instead of chunks
        filter = DocFilter(
            fullDocuments=True,  # Combine all chunks from same file
            limit=10
        )
    """

    fullTables: Optional[bool] = Field(False, description='Combine all chunks from the same table into one result. Useful when you need complete table data rather than individual rows.')

    fullDocuments: Optional[bool] = Field(False, description='Combine all chunks from the same document into one result. Use this when you need complete document content rather than fragments.')

    offset: Optional[int] = Field(0, description='Skip this many results for pagination. Use with limit to page through large result sets.')

    limit: Optional[int] = Field(25, description='Maximum number of results to return. Higher numbers give more comprehensive results but slower performance.')

    minChunkId: Optional[int] = Field(None, description='Only return chunks with ID >= this value. Used for filtering specific document sections.')

    maxChunkId: Optional[int] = Field(None, description='Only return chunks with ID <= this value. Used for filtering specific document sections.')

    nodeId: Optional[str] = Field(None, description='Filter results to documents from a specific RocketRide node/server. Useful in multi-node deployments.')

    parent: Optional[str] = Field(None, description='Filter to documents from a specific parent file or folder path.')

    name: Optional[str] = Field(None, description='Filter to documents with names matching this pattern.')

    permissions: Optional[List[int]] = Field(None, description='Only return documents the user has these permission levels for. Respects access controls.')

    isDeleted: Optional[bool] = Field(None, description='Include (True) or exclude (False) deleted documents. None includes both.')

    objectIds: Optional[List[str]] = Field(None, description='Only return documents with these specific object IDs. Useful for targeted queries.')

    chunkIds: Optional[List[int]] = Field(None, description='Only return these specific document chunks by ID.')

    isTable: Optional[bool] = Field(None, description='Filter to only table data (True) or exclude tables (False). None includes both.')

    tableIds: Optional[List[int]] = Field(None, description='Only return data from these specific table IDs.')

    # AI and processing enhancements
    useQuickRank: Optional[bool] = Field(False, description='Use AI to rerank results for better relevance. Improves quality but adds processing time.')

    useGroupRank: Optional[bool] = Field(False, description='Use AI to rank groups of related documents. Useful for finding the best document among similar ones.')

    followUpQuestions: Optional[int] = Field(5, description='Number of follow-up questions to generate for AI chat. Helps users explore topics further.')

    context: Optional[bool] = Field(False, description='Include additional context information with search results. Useful for understanding document relationships.')
