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

"""
Aparavi AQL tool-provider driver.

Exposes three tools to the agent:
  aparavi.get_data    -- natural language -> AQL -> execute -> return rows
  aparavi.get_aql     -- natural language -> AQL (no execution)
  aparavi.get_schema  -- return fixed STORE column schema
"""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional

from ai.common.schema import Question
from ai.common.tools import ToolsBase

from .aql_schema import get_schema_dict, get_schema_prompt_text

# ---------------------------------------------------------------------------
# AQL safety check -- block any mutations before hitting the network
# ---------------------------------------------------------------------------
_UNSAFE_PATTERN = re.compile(
    r'\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|EXEC|EXECUTE)\b',
    re.IGNORECASE,
)


def _aql_safe(aql: str) -> bool:
    return not _UNSAFE_PATTERN.search(aql)


class AqlDriver(ToolsBase):
    """ToolsBase driver for the Aparavi AQL node."""

    def __init__(self, *, iglobal: Any) -> None:
        self._iglobal = iglobal
        self._server_name = 'aparavi'
        self._llm_invoke: Optional[Callable[[Question], str]] = None

    def set_llm_invoker(self, fn: Callable[[Question], str]) -> None:
        """Bind the LLM invoker callable (called by IInstance)."""
        self._llm_invoke = fn

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[Dict[str, Any]]:
        db_desc = (getattr(self._iglobal, 'db_description', '') or '').strip()
        desc_prefix = f'{db_desc} ' if db_desc else ''
        return [
            {
                'name': f'{self._server_name}.get_data',
                'description': (
                    f'{desc_prefix}'
                    'PRIMARY tool for ALL Aparavi data retrieval. '
                    'Pass a plain English question -- do NOT look up schema, column names, or write AQL yourself. '
                    'This tool handles schema knowledge, AQL generation, and execution internally. '
                    'Just describe what you want in natural language and it returns the rows.'
                ),
                'inputSchema': {
                    'type': 'object',
                    'required': ['question'],
                    'properties': {
                        'question': {
                            'type': 'string',
                            'description': 'Natural-language description of the data you want from Aparavi',
                        },
                    },
                },
                'outputSchema': {
                    'type': 'object',
                    'properties': {
                        'rows': {
                            'type': 'array',
                            'description': 'Result rows returned by the AQL query',
                            'items': {'type': 'object'},
                        },
                        'aql': {
                            'type': 'string',
                            'description': 'The AQL query that was executed',
                        },
                        'count': {
                            'type': 'integer',
                            'description': 'Number of rows returned',
                        },
                        'error': {
                            'type': 'string',
                            'description': 'Error message if the query failed',
                        },
                    },
                },
            },
            {
                'name': f'{self._server_name}.get_aql',
                'description': (
                    f'{desc_prefix}'
                    'Convert a natural-language question to an AQL SELECT statement '
                    'without executing it. Use only when the user explicitly asks to see the query.'
                ),
                'inputSchema': {
                    'type': 'object',
                    'required': ['question'],
                    'properties': {
                        'question': {
                            'type': 'string',
                            'description': 'Natural-language description of the data you want from Aparavi',
                        },
                    },
                },
                'outputSchema': {
                    'type': 'object',
                    'properties': {
                        'aql': {
                            'type': 'string',
                            'description': 'The generated AQL SELECT statement',
                        },
                    },
                },
            },
            {
                'name': f'{self._server_name}.get_schema',
                'description': (
                    f'{desc_prefix}'
                    'FALLBACK ONLY -- returns the fixed column schema for the Aparavi STORE table. '
                    'Do NOT call this preemptively; only use if get_data fails or returns unexpected results.'
                ),
                'inputSchema': {
                    'type': 'object',
                    'properties': {},
                },
                'outputSchema': {
                    'type': 'object',
                    'properties': {
                        'store': {
                            'type': 'string',
                            'description': 'Table name (always "STORE")',
                        },
                        'columns': {
                            'type': 'array',
                            'description': 'Column definitions for the STORE table',
                            'items': {
                                'type': 'object',
                                'properties': {
                                    'name': {'type': 'string'},
                                    'type': {'type': 'string', 'description': 'STRING | NUMBER | DATE | OBJECT'},
                                    'description': {'type': 'string'},
                                },
                            },
                        },
                    },
                },
            },
        ]

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:
        name = self._strip_ns(tool_name)
        if name not in ('get_data', 'get_aql', 'get_schema'):
            raise ValueError(f'Unknown tool {tool_name!r}')
        if name in ('get_data', 'get_aql'):
            if not isinstance(input_obj, dict):
                raise ValueError('Tool input must be a JSON object')
            question = input_obj.get('question')
            if not question or not isinstance(question, str) or not question.strip():
                raise ValueError('"question" is required and must be a non-empty string')

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:
        if input_obj is None:
            input_obj = {}
        self._tool_validate(tool_name=tool_name, input_obj=input_obj)

        name = self._strip_ns(tool_name)
        if name == 'get_schema':
            return get_schema_dict()
        if name == 'get_aql':
            return self._invoke_get_aql(input_obj)
        return self._invoke_get_data(input_obj)

    # ------------------------------------------------------------------
    # Tool implementations
    # ------------------------------------------------------------------

    def _invoke_get_aql(self, input_obj: Dict[str, Any]) -> Dict[str, Any]:
        if self._llm_invoke is None:
            raise RuntimeError('aparavi_aql: LLM invoker not bound')
        aql = self._generate_aql(input_obj['question'].strip())
        return {'aql': aql}

    _MAX_AQL_RETRIES = 3

    def _invoke_get_data(self, input_obj: Dict[str, Any]) -> Dict[str, Any]:
        if self._llm_invoke is None:
            raise RuntimeError('aparavi_aql: LLM invoker not bound')

        client = getattr(self._iglobal, 'client', None)
        if client is None:
            raise RuntimeError('aparavi_aql: client not initialized')

        question = input_obj['question'].strip()
        previous_aql: str | None = None
        last_error: str | None = None

        for _ in range(self._MAX_AQL_RETRIES):
            aql = self._generate_aql(question, previous_aql=previous_aql, error=last_error)

            if not _aql_safe(aql):
                return {'error': 'Generated AQL contains unsafe operations', 'aql': aql, 'rows': []}

            try:
                result = client.execute(aql)
                return {'rows': result['rows'], 'aql': aql, 'count': result['count']}
            except RuntimeError as exc:
                last_error = str(exc)
                previous_aql = aql

        return {'error': last_error, 'aql': previous_aql, 'rows': []}

    # ------------------------------------------------------------------
    # AQL generation
    # ------------------------------------------------------------------

    def _generate_aql(self, question_text: str, *, previous_aql: str | None = None, error: str | None = None) -> str:
        """Use the LLM to translate a natural-language question into AQL."""
        q = Question(role='You are an Aparavi AQL query generator.')

        q.addInstruction(
            'Output format',
            'Output ONLY the raw AQL query string -- no markdown fences, no explanation, no preamble.',
        )

        q.addInstruction(
            'AQL syntax',
            (
                'AQL is an SQL-like language for querying the Aparavi STORE table.\n'
                'Basic structure:\n'
                "  SELECT cols FROM STORE [WHERE condition] [WHICH CONTAIN 'term']\n"
                '  [GROUP BY col] [HAVING cond] [ORDER BY col ASC|DESC] [LIMIT n]\n\n'
                'Key rules:\n'
                '  - No JOINs -- STORE is the only table\n'
                '  - Size units are supported: 10 MB, 5 GB, 100 KB\n'
                '  - Always add LIMIT 250 unless the user specifies a different limit\n'
                '  - Aggregate functions: COUNT, SUM, AVG, MIN, MAX\n'
                '  - Date functions: NOW(), TODAY(), YEAR(), MONTH(), DAY()\n'
                '  - NOW() returns seconds since the Unix epoch; DATE columns are also compared in seconds\n'
                '  - Date arithmetic example: last 30 days = NOW() - (30 * 86400)\n'
                '  - String functions: UPPER, LOWER, TRIM, LENGTH, SUBSTR, CONCAT\n'
                '  - CAST(expr AS NUMBER|DATE|STRING)\n'
                '  - CASE WHEN cond THEN val ELSE val END\n'
                '  - Always quote column ALIASES with double quotes to avoid reserved-word conflicts,\n'
                '    e.g. YEAR(createTime) AS "year", COUNT(*) AS "count", size AS "size"'
            ),
        )

        q.addInstruction(
            'Column selection',
            (
                'Select only the columns relevant to the question. '
                'Use SELECT * only when the user explicitly asks for all data. '
                'For count-only questions use COUNT(*) with GROUP BY.'
            ),
        )

        q.addContext(get_schema_prompt_text())

        db_desc = (getattr(self._iglobal, 'db_description', '') or '').strip()
        if db_desc:
            q.addContext(f'Data context: {db_desc}')

        q.addExample(
            'Find all PDF files larger than 10 MB',
            "SELECT name, parentPath, size, modifyTime FROM STORE WHERE extension = 'pdf' AND size > 10 MB LIMIT 250",
        )
        q.addExample(
            'Count files by extension',
            'SELECT extension, COUNT(*) AS "count" FROM STORE GROUP BY extension ORDER BY "count" DESC LIMIT 250',
        )
        q.addExample(
            'Files modified in the last 7 days',
            'SELECT name, parentPath, size, modifyTime FROM STORE WHERE modifyTime > NOW() - (7 * 86400) LIMIT 250',
        )

        if previous_aql and error:
            q.addContext(
                f'Your previous AQL attempt was rejected with this error:\n\n{error}\n\n'
                f'Failed AQL:\n{previous_aql}\n\n'
                f'Fix the query and try again.'
            )

        q.addGoal('Generate a valid AQL SELECT query for the Aparavi STORE table that answers the question.')
        q.addQuestion(question_text)

        response_text = self._llm_invoke(q)

        # Strip any accidental markdown fences
        text = (response_text or '').strip()
        if text.startswith('```'):
            lines = text.split('\n')
            end = len(lines) - 1 if lines[-1].strip() == '```' else len(lines)
            text = '\n'.join(lines[1:end]).strip()

        return text

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _strip_ns(self, tool_name: str) -> str:
        prefix = f'{self._server_name}.'
        if tool_name.startswith(prefix):
            return tool_name[len(prefix):]
        return tool_name
