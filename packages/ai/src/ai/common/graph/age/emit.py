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

"""SQL emission: the ``cypher()`` envelope, column list, and bind plan.

Facts verified against the live AGE 1.5.0 pin (see the layer README):

- The envelope is ``SELECT * FROM cypher('<graph>', $tag$<cypher>$tag$ [, $1])
  AS (<c0 agtype, ...>)``. The AS-list column *count* must equal the RETURN
  column count exactly; the *names* are arbitrary — we emit generated safe
  identifiers (``c0..cN``) and key decoded rows by the Cypher display names.
- Statements without RETURN take a single synthesized column and yield 0 rows.
- The cypher() params argument MUST be a real prepared-statement parameter —
  an inline ``'...'::agtype`` literal is rejected by AGE. With params we emit
  ``PREPARE <name>(agtype) AS ...`` / ``EXECUTE <name>(%s::agtype)`` /
  ``DEALLOCATE <name>`` for one transaction (transaction-pooler safe;
  a rolled-back transaction discards its prepared statements).
- The Cypher body is embedded via dollar-quoting; the tag is chosen to not
  collide with the body so user text can never escape the envelope.

The emitter is DB-driver-agnostic: it produces SQL strings with psycopg2
(``%s``) placeholders plus the bind values; the node owns the connection.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .analysis import CypherFacts
from .errors import AgeTranslationError

# AGE graph names: unquoted-identifier discipline, same as table names.
VALID_GRAPH_NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,62}$')


@dataclass
class TranslatedQuery:
    """The executable plan for one Cypher query.

    ``statements`` run in order inside ONE transaction; the statement at
    ``result_index`` produces the result rows (one agtype column per entry in
    ``columns``). ``binds`` pair positionally with ``statements``.
    """

    columns: List[str]
    statements: List[str] = field(default_factory=list)
    binds: List[Tuple[Any, ...]] = field(default_factory=list)
    result_index: int = 0
    # True when the statement set carries no RETURN (pure write): zero rows
    # are expected and 'affected' semantics apply.
    has_return: bool = True
    # The caller must open the transaction READ ONLY (safe path).
    read_only: bool = False


def _dollar_quote(body: str) -> str:
    """Wrap ``body`` in a dollar-quote tag guaranteed absent from it."""
    tag = '$rr_cypher$'
    counter = 0
    while tag in body:
        counter += 1
        tag = f'$rr_cypher{counter}$'
    return f'{tag}{body}{tag}'


def _params_to_agtype_json(params: Dict[str, Any]) -> str:
    """Serialize the params map to the JSON text cast to agtype at bind time."""
    try:
        return json.dumps(params)
    except (TypeError, ValueError) as e:
        raise AgeTranslationError(f'Cypher parameters are not JSON-serialisable: {e}') from e


def emit(
    facts: CypherFacts,
    graph_name: str,
    params: Optional[Dict[str, Any]] = None,
    limit: Optional[int] = None,
    statement_timeout_ms: int = 30_000,
    read_only: bool = False,
) -> TranslatedQuery:
    """Build the transaction's statement list for one translated query.

    The caller wraps the statements in BEGIN/COMMIT (READ ONLY when
    ``read_only``); AGE is preloaded server-side, so no ``LOAD`` is emitted.
    """
    if not VALID_GRAPH_NAME.fullmatch(graph_name or ''):
        raise AgeTranslationError(
            f'Invalid graph name {graph_name!r}: must be a valid identifier '
            '(letters, digits, underscores; max 63 chars)'
        )
    if params and not facts.param_names:
        raise AgeTranslationError('Parameters were supplied but the Cypher query references no $parameters')
    if facts.param_names:
        missing = sorted(facts.param_names - set(params or {}))
        if missing:
            raise AgeTranslationError(
                'Cypher query references parameters with no supplied values: '
                + ', '.join(f'${name}' for name in missing)
            )

    columns = [c.display_name for c in facts.return_columns] if facts.return_columns else []
    has_return = facts.return_columns is not None
    # Generated safe identifiers; count is what AGE checks, names are ours.
    as_list = ', '.join(f'c{i} agtype' for i in range(len(columns))) if has_return else 'v agtype'

    body = _dollar_quote(facts.query)
    tq = TranslatedQuery(columns=columns, has_return=has_return)

    # Session discipline for the transaction-pooled cloud endpoint: LOCAL only.
    tq.statements.append('SET LOCAL search_path = ag_catalog,"$user",public')
    tq.binds.append(())
    timeout = max(1, int(statement_timeout_ms))
    tq.statements.append(f"SET LOCAL statement_timeout = '{timeout}ms'")
    tq.binds.append(())

    outer_limit = ''
    if limit is not None:
        outer_limit = f' LIMIT {max(0, int(limit))}'

    # Key the branch on the query's $parameters, not on bool(params): the
    # missing-value check above guarantees params covers param_names here.
    if facts.param_names:
        # cypher()'s params argument must be a prepared-statement parameter.
        stmt_name = f'_rr_age_{uuid.uuid4().hex[:12]}'
        select = (
            f'PREPARE {stmt_name}(agtype) AS '
            f"SELECT * FROM cypher('{graph_name}', {body}, $1) AS ({as_list}){outer_limit}"
        )
        tq.statements.append(select)
        tq.binds.append(())
        tq.statements.append(f'EXECUTE {stmt_name}(%s::agtype)')
        tq.binds.append((_params_to_agtype_json(params),))
        tq.result_index = len(tq.statements) - 1
        tq.statements.append(f'DEALLOCATE {stmt_name}')
        tq.binds.append(())
    else:
        select = f"SELECT * FROM cypher('{graph_name}', {body}) AS ({as_list}){outer_limit}"
        tq.statements.append(select)
        tq.binds.append(())
        tq.result_index = len(tq.statements) - 1

    # read_only is enforced by the caller's BEGIN READ ONLY; carried for tests.
    tq.read_only = read_only
    return tq
