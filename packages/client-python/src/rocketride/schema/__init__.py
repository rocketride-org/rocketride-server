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
Data Schema Definitions for RocketRide Client.

This module provides Pydantic model classes for structured data used in RocketRide operations:
    - Question models for AI chat and document analysis
    - Document models for providing context to AI
    - Filter and metadata models for document organization

These models ensure type safety, validate input data, and provide clear documentation
of the expected data structures for various RocketRide operations.

Question Models:
    Question: Main class for asking questions to RocketRide's AI
    QuestionType: Enum defining question types (TEXT or JSON)
    QuestionText: Individual question text with optional metadata
    QuestionExample: Example answers to guide AI response formatting
    QuestionHistory: Conversation history for contextual AI responses
    Answer: Structured response from AI containing answer and metadata

Document Models:
    Doc: Represents a document or text to provide as context
    DocGroup: Collection of related documents
    DocMetadata: Metadata attributes for documents
    DocFilter: Filtering criteria for document selection

Usage:
    from rocketride.schema import Question, Doc, DocFilter
    
    # Create a question with document context
    question = Question()
    question.addQuestion('What are the main themes?')
    question.addDocument(Doc(page_content='Your text here'))
    
    # Use filtering to select specific documents
    filter = DocFilter(where={'category': 'financial'})
"""

from .doc import Doc
from .doc_group import DocGroup
from .doc_filter import DocFilter
from .doc_metadata import DocMetadata
from .question import (
    Answer,
    Question,
    QuestionExample,
    QuestionHistory,
    QuestionText,
    QuestionType,
)

__all__ = [
    'Answer',
    'Question',
    'QuestionExample',
    'QuestionHistory',
    'QuestionText',
    'QuestionType',
    'DocFilter',
    'DocMetadata',
    'Doc',
    'DocGroup',
]
