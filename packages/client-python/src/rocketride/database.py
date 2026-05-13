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
Database API namespace for the RocketRide Python SDK.

Exposes ``client.database.query(...)`` for issuing raw SQL or Cypher directly
against a database pipeline, bypassing the LLM translation layer that the
default ``client.chat(...)`` flow uses.

Usage:
    rows = await client.database.query(token=t, sql='SELECT 1 AS one')
"""

from __future__ import annotations

import json
from enum import Enum
from typing import TYPE_CHECKING, Optional

from .schema.question import Question, QuestionType
from .types.data import PIPELINE_RESULT

if TYPE_CHECKING:
    from .client import RocketRideClient


class DatabaseDialect(str, Enum):
    """
    Underlying database engine a pipeline is connected to.

    Returned by ``client.database.dialect(...)`` so applications can branch on
    dialect-specific behavior (e.g. SQL syntax differences, type coercion) and
    detect when they're talking to a graph DB instead of a relational one.
    """

    POSTGRES = 'postgres'
    MYSQL = 'mysql'
    NEO4J = 'neo4j'


class DatabaseApi:
    """
    Direct database-query namespace on RocketRideClient.

    Accessed via ``client.database`` -- not instantiated directly. Statements
    submitted through this namespace bypass the LLM translation layer and
    safety checks, so the caller is responsible for the SQL/Cypher they pass.
    """

    def __init__(self, client: 'RocketRideClient') -> None:
        self._client = client

    async def query(
        self,
        *,
        token: str,
        sql: str,
        on_sse: Optional[object] = None,
    ) -> PIPELINE_RESULT:
        """
        Execute a raw SQL or Cypher statement against a database pipeline.

        Sends a Question with ``type=QuestionType.EXECUTE`` so the database
        node treats ``sql`` as the literal statement to run -- no LLM call,
        no ``is_sql_safe`` / ``_is_cypher_safe`` gating.

        Args:
            token: Pipeline token for authentication and resource access.
            sql: Raw SQL or Cypher statement to execute.
            on_sse: Optional callback for streaming events (matches ``chat``).

        Returns:
            PIPELINE_RESULT: The pipeline response. The ``answers`` lane carries
            a JSON-encoded payload of shape ``{"rows": [...], "affected_rows": N}``.

        Raises:
            ValueError: If ``token`` or ``sql`` is empty or whitespace-only.
        """
        if not isinstance(token, str) or not token.strip():
            raise ValueError('token must be a non-empty string')
        if not isinstance(sql, str) or not sql.strip():
            raise ValueError('sql must be a non-empty string')

        question = Question(type=QuestionType.EXECUTE)
        question.addQuestion(sql)
        return await self._client.chat(token=token, question=question, on_sse=on_sse)

    async def dialect(self, *, token: str) -> DatabaseDialect:
        """
        Discover the underlying database engine for a pipeline.

        Sends a ``Question(type=DIALECT)``; the database node replies on the
        ``answers`` lane with ``{"dialect": "<engine>"}``. Use this to branch
        on dialect-specific SQL or to assert you're not pointed at the wrong
        kind of database (e.g. Neo4j when you expected Postgres).

        Args:
            token: Pipeline token for authentication and resource access.

        Returns:
            DatabaseDialect: The dialect reported by the node.

        Raises:
            ValueError: If ``token`` is empty/whitespace, the pipeline returns
                no answer, or the response is not a recognized dialect.
        """
        if not isinstance(token, str) or not token.strip():
            raise ValueError('token must be a non-empty string')

        question = Question(type=QuestionType.DIALECT)
        question.addQuestion('dialect')
        result = await self._client.chat(token=token, question=question)

        answers = result.get('answers') if isinstance(result, dict) else None
        if not answers:
            raise ValueError('Pipeline returned no dialect answer; is the endpoint a database node?')

        try:
            payload = json.loads(answers[0])
            return DatabaseDialect(payload['dialect'])
        except (TypeError, KeyError, ValueError, json.JSONDecodeError) as e:
            raise ValueError(f'Unexpected dialect response from pipeline: {answers[0]!r}') from e
