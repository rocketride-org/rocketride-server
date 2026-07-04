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
Aparavi AQL tool node — instance state.

Exposes three tools via @tool_function decorators:
  get_data   — natural language -> AQL -> execute -> return rows
  get_aql    — natural language -> AQL (no execution)
  get_schema — return fixed STORE column schema
"""

from __future__ import annotations

import re
from typing import Any, Dict

from rocketlib import IInstanceBase, tool_function
from rocketlib.types import IInvokeLLM
from ai.common.schema import Question

from .IGlobal import IGlobal
from .aql_schema import get_schema_dict, get_schema_prompt_text


# =============================================================================
# CONSTANTS
# =============================================================================

# Block any mutations before hitting the network
_UNSAFE_PATTERN = re.compile(
    r'\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|EXEC|EXECUTE)\b',
    re.IGNORECASE,
)

# Maximum retries when AQL execution fails
_MAX_AQL_RETRIES = 3


def _aql_safe(aql: str) -> bool:
    """
    Return True if the AQL is a single SELECT statement with no unsafe keywords.

    Enforces SELECT-only semantics: strips a trailing semicolon, rejects
    multi-statement input (embedded semicolons), requires the query to begin
    with SELECT, and blocks mutation keywords anywhere in the text.
    """
    normalised = aql.strip().rstrip(';').strip()
    # Reject multi-statement queries (semicolon inside the body)
    if ';' in normalised:
        return False
    if not normalised.upper().startswith('SELECT'):
        return False
    return not _UNSAFE_PATTERN.search(normalised)


def _get_description(self: Any) -> str:
    """Build tool description, prepending db_description when configured."""
    db_desc = (getattr(self.IGlobal, 'db_description', '') or '').strip()
    prefix = f'{db_desc} ' if db_desc else ''
    return (
        f'{prefix}'
        'PRIMARY tool for ALL Aparavi data retrieval. '
        'Pass a plain English question — do NOT look up schema, column names, or write AQL yourself. '
        'This tool handles schema knowledge, AQL generation, and execution internally. '
        'Just describe what you want in natural language and it returns the rows.'
    )


# =============================================================================
# IINSTANCE
# =============================================================================


class IInstance(IInstanceBase):
    """Aparavi AQL instance — provides tool functions for AQL query generation and execution."""

    IGlobal: IGlobal

    # ------------------------------------------------------------------
    # TOOL METHODS
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['question'],
            'properties': {
                'question': {
                    'type': 'string',
                    'description': 'Natural-language description of the data you want from Aparavi',
                },
            },
        },
        output_schema={
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
        description=_get_description,
    )
    def get_data(self, args: Any) -> Dict[str, Any]:
        """Translate natural language to AQL, execute against Aparavi, and return rows."""
        # Validate input
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object')
        question = args.get('question')
        if not question or not isinstance(question, str) or not question.strip():
            raise ValueError('"question" is required and must be a non-empty string')

        # Get the HTTP client from global state
        client = self.IGlobal.client
        if client is None:
            return {'error': 'aparavi_aql: client not initialized (check URL config)', 'rows': []}

        # Retry loop: generate AQL -> safety check -> execute
        question_text = question.strip()
        previous_aql: str | None = None
        last_error: str | None = None

        for _ in range(_MAX_AQL_RETRIES):
            # Generate AQL — include in retry loop so LLM failures also retry
            try:
                aql = self._generate_aql(question_text, previous_aql=previous_aql, error=last_error)
            except Exception as exc:
                last_error = str(exc)
                previous_aql = None
                continue

            # Safety check — block non-SELECT / mutation queries
            if not _aql_safe(aql):
                return {'error': 'Generated AQL contains unsafe operations', 'aql': aql, 'rows': []}

            try:
                result = client.execute(aql)
                return {'rows': result['rows'], 'aql': aql, 'count': result['count']}
            except RuntimeError as exc:
                last_error = str(exc)
                previous_aql = aql

        return {'error': last_error, 'aql': previous_aql, 'rows': []}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['question'],
            'properties': {
                'question': {
                    'type': 'string',
                    'description': 'Natural-language description of the data you want from Aparavi',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'aql': {
                    'type': 'string',
                    'description': 'The generated AQL SELECT statement',
                },
            },
        },
        description=(
            'Convert a natural-language question to an AQL SELECT statement '
            'without executing it. Use only when the user explicitly asks to see the query.'
        ),
    )
    def get_aql(self, args: Any) -> Dict[str, Any]:
        """Generate an AQL SELECT statement from natural language without executing it."""
        # Validate input
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object')
        question = args.get('question')
        if not question or not isinstance(question, str) or not question.strip():
            raise ValueError('"question" is required and must be a non-empty string')

        aql = self._generate_aql(question.strip())
        return {'aql': aql}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {},
        },
        output_schema={
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
        description=(
            'FALLBACK ONLY — returns the fixed column schema for the Aparavi STORE table. '
            'Do NOT call this preemptively; only use if get_data fails or returns unexpected results.'
        ),
    )
    def get_schema(self, args: Any) -> Dict[str, Any]:
        """Return the fixed STORE table column schema."""
        return get_schema_dict()

    # ------------------------------------------------------------------
    # AQL GENERATION
    # ------------------------------------------------------------------

    def _generate_aql(
        self,
        question_text: str,
        *,
        previous_aql: str | None = None,
        error: str | None = None,
    ) -> str:
        """Use the connected LLM to translate a natural-language question into AQL.

        Builds a structured Question with schema context, syntax rules, and examples,
        then invokes the LLM via the framework's standard IInvokeLLM.Ask pattern.
        """
        # Build the structured question for the LLM
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

        # Inject the full schema as context
        q.addContext(get_schema_prompt_text())

        # Inject optional data description from config
        db_desc = (self.IGlobal.db_description or '').strip()
        if db_desc:
            q.addContext(f'Data context: {db_desc}')

        # Few-shot examples
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

        # If retrying, include the previous failure context
        if previous_aql and error:
            q.addContext(
                f'Your previous AQL attempt was rejected with this error:\n\n{error}\n\n'
                f'Failed AQL:\n{previous_aql}\n\n'
                f'Fix the query and try again.'
            )

        q.addGoal('Generate a valid AQL SELECT query for the Aparavi STORE table that answers the question.')
        q.addQuestion(question_text)

        # Invoke the LLM via the framework
        result = self.instance.invoke(IInvokeLLM.Ask(question=q))

        if not result or not result.answer:
            raise ValueError('LLM failed to generate an AQL query.')

        # Strip any accidental markdown fences from the response
        text = result.answer.strip()
        if text.startswith('```'):
            lines = text.split('\n')
            end = len(lines) - 1 if lines[-1].strip() == '```' else len(lines)
            text = '\n'.join(lines[1:end]).strip()

        return text
