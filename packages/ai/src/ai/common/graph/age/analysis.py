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

"""Cypher analysis: openCypher ANTLR parse -> structured facts.

This is the parse stage of the translation pipeline. It runs the vendored
openCypher M23 parser (see ``_cypher/``) over the query text and extracts the
facts every later stage needs:

- the RETURN projection (column display names, or ``RETURN *`` / no RETURN),
- which write clauses appear (typed contexts, not regex),
- variable-length relationship ranges (for the firewall's depth cap),
- ``$param`` names, and invoked function names (for the capability table).

Parsing failures raise :class:`~.errors.AgeTranslationError` with the
collected syntax messages — the same text the LLM repair loop feeds back.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional, Set, Tuple

from antlr4 import CommonTokenStream, InputStream, ParserRuleContext
from antlr4.error.ErrorListener import ErrorListener

from ._cypher.gen.CypherLexer import CypherLexer
from ._cypher.gen.CypherParser import CypherParser
from .errors import AgeTranslationError


@dataclass
class ReturnColumn:
    """One projection item of the final RETURN clause."""

    # Name used to key decoded result rows: the AS alias when present, the
    # bare variable/property text when simple, else a generated placeholder.
    display_name: str
    # Raw expression text (diagnostics only).
    expression: str
    # True when display_name came from an explicit AS alias.
    is_alias: bool = False


@dataclass
class CypherFacts:
    """Everything later pipeline stages need to know about a Cypher query."""

    query: str
    # None => the statement has no RETURN clause (pure write); the emitter
    # synthesizes a single throwaway column in that case.
    return_columns: Optional[List[ReturnColumn]] = None
    returns_star: bool = False
    write_clauses: Set[str] = field(default_factory=set)
    has_call: bool = False
    # (lower_bound, upper_bound) per variable-length pattern; None = unbounded.
    var_length_ranges: List[Tuple[Optional[int], Optional[int]]] = field(default_factory=list)
    param_names: Set[str] = field(default_factory=set)
    function_names: Set[str] = field(default_factory=set)
    # MERGE ... ON CREATE/ON MATCH actions (capability: merge_on_set).
    has_merge_action: bool = False
    # A label check used as an expression (e.g. WHERE (n:Label)) rather than in
    # a pattern (capability: where_label_check).
    has_where_label_check: bool = False
    # A pattern node carrying more than one label (capability: multi_label).
    has_multi_label: bool = False
    # ORDER BY references a bare projection alias rather than an expression
    # (capability: order_by_alias — AGE 1.5.0: 'could not find rte for <name>').
    has_order_by_alias: bool = False

    @property
    def is_write(self) -> bool:
        return bool(self.write_clauses)


class _CollectingErrorListener(ErrorListener):
    """Collect syntax errors instead of ANTLR's default stderr printing."""

    def __init__(self) -> None:
        self.errors: List[str] = []

    def syntaxError(self, recognizer, offendingSymbol, line, column, msg, e):  # noqa: N802 (ANTLR API)
        self.errors.append(f'line {line}:{column} {msg}')


def _strip_backticks(name: str) -> str:
    if len(name) >= 2 and name.startswith('`') and name.endswith('`'):
        return name[1:-1].replace('``', '`')
    return name


def _source_text(ctx: ParserRuleContext) -> str:
    """Original source slice for a context (getText() drops whitespace)."""
    stream = ctx.start.getInputStream()
    return stream.getText(ctx.start.start, ctx.stop.stop)


def _walk(ctx, visit) -> None:
    visit(ctx)
    for i in range(ctx.getChildCount()):
        child = ctx.getChild(i)
        if child.getChildCount() or isinstance(child, ParserRuleContext):
            _walk(child, visit)
        else:
            visit(child)


def _depth(ctx) -> int:
    d = 0
    node = ctx
    while node.parentCtx is not None:
        node = node.parentCtx
        d += 1
    return d


def _parse_range_literal(text: str) -> Tuple[Optional[int], Optional[int]]:
    """``*``/``*3``/``*1..3``/``*..5``/``*2..`` -> (lower, upper), None=absent."""
    body = text.lstrip('*').replace(' ', '')
    if not body:
        return (None, None)
    if '..' not in body:
        n = int(body)
        return (n, n)
    low_s, _, high_s = body.partition('..')
    return (int(low_s) if low_s else None, int(high_s) if high_s else None)


def _projection_column(item_ctx) -> ReturnColumn:
    """Build a ReturnColumn from an oC_ProjectionItem context."""
    expression = _source_text(item_ctx)
    # Grammar: oC_ProjectionItem : ( oC_Expression SP AS SP oC_Variable ) | oC_Expression ;
    variable = item_ctx.oC_Variable() if hasattr(item_ctx, 'oC_Variable') else None
    if variable is not None:
        return ReturnColumn(display_name=_strip_backticks(variable.getText()), expression=expression, is_alias=True)
    expr_text = item_ctx.oC_Expression().getText()
    return ReturnColumn(display_name=_strip_backticks(expr_text), expression=expression)


def analyze(query: str) -> CypherFacts:
    """Parse ``query`` with the openCypher grammar and extract translation facts.

    Raises:
        AgeTranslationError: when the text is not syntactically valid Cypher.
    """
    if not query or not query.strip():
        raise AgeTranslationError('Empty Cypher query')

    listener = _CollectingErrorListener()
    lexer = CypherLexer(InputStream(query))
    lexer.removeErrorListeners()
    lexer.addErrorListener(listener)
    parser = CypherParser(CommonTokenStream(lexer))
    parser.removeErrorListeners()
    parser.addErrorListener(listener)

    # The recursive-descent parse (and the walk below) burn stack per nesting
    # level. The firewall's pre-parse nesting cap keeps normal input far from
    # the limit; this backstop keeps the layer's contract — every failure is
    # an AgeTranslationError — even for input that slips past the scan.
    try:
        tree = parser.oC_Cypher()
    except RecursionError:
        raise AgeTranslationError(
            'Cypher expression is nested too deeply to parse (reduce parenthesis/expression nesting)'
        ) from None
    if listener.errors:
        raise AgeTranslationError('Cypher syntax error: ' + '; '.join(listener.errors[:5]))

    facts = CypherFacts(query=query)

    # Write clauses / CALLs / ranges / params / functions — a single walk.
    write_map = {
        CypherParser.OC_CreateContext: 'CREATE',
        CypherParser.OC_MergeContext: 'MERGE',
        CypherParser.OC_DeleteContext: 'DELETE',
        CypherParser.OC_SetContext: 'SET',
        CypherParser.OC_RemoveContext: 'REMOVE',
    }
    returns: List = []

    def visit(node) -> None:
        for ctx_cls, clause in write_map.items():
            if isinstance(node, ctx_cls):
                facts.write_clauses.add(clause)
        if isinstance(node, (CypherParser.OC_StandaloneCallContext, CypherParser.OC_InQueryCallContext)):
            facts.has_call = True
        if isinstance(node, CypherParser.OC_RangeLiteralContext):
            facts.var_length_ranges.append(_parse_range_literal(node.getText()))
        if isinstance(node, CypherParser.OC_ParameterContext):
            facts.param_names.add(node.getText().lstrip('$'))
        if isinstance(node, CypherParser.OC_FunctionInvocationContext):
            name_ctx = node.oC_FunctionName()
            if name_ctx is not None:
                facts.function_names.add(name_ctx.getText().lower())
        if isinstance(node, CypherParser.OC_MergeActionContext):
            facts.has_merge_action = True
        if isinstance(node, CypherParser.OC_NodeLabelsContext):
            if len(node.oC_NodeLabel()) > 1:
                facts.has_multi_label = True
            # A NodeLabels context under a WHERE (not inside a pattern) is a
            # label check used as an expression: WHERE (n:Label).
            parent = node.parentCtx
            while parent is not None:
                if isinstance(parent, CypherParser.OC_WhereContext):
                    facts.has_where_label_check = True
                    break
                if isinstance(parent, CypherParser.OC_PatternContext):
                    break
                parent = parent.parentCtx
        if isinstance(node, CypherParser.OC_ReturnContext):
            returns.append(node)
        if isinstance(node, CypherParser.OC_SortItemContext):
            sort_items.append(node.oC_Expression().getText())

    sort_items: List[str] = []
    try:
        _walk(tree, visit)
    except RecursionError:
        raise AgeTranslationError(
            'Cypher expression is nested too deeply to analyze (reduce parenthesis/expression nesting)'
        ) from None

    if returns:
        # Multiple RETURNs at the same (shallowest) depth = UNION branches; all
        # branches must project the same column count, so the first shallowest
        # RETURN defines the projection. Deeper RETURNs (subqueries) are not
        # the statement's result shape.
        top = min(returns, key=_depth)
        items_ctx = top.oC_ProjectionBody().oC_ProjectionItems()
        # Grammar: oC_ProjectionItems : ( '*' ... ) | ( oC_ProjectionItem ... ) ;
        if items_ctx.getChild(0).getText() == '*':
            facts.returns_star = True
        else:
            facts.return_columns = [_projection_column(item) for item in items_ctx.oC_ProjectionItem()]

    # ORDER BY a bare AS-alias (not an expression) — an AGE 1.5.0 wrinkle:
    # verified to fail with 'could not find rte for <name>'.
    if facts.return_columns:
        aliases = {c.display_name for c in facts.return_columns if c.is_alias}
        bare = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
        facts.has_order_by_alias = any(bare.fullmatch(item) and item in aliases for item in sort_items)

    return facts
