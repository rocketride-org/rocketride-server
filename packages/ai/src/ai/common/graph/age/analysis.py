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
from typing import Dict, Iterator, List, Optional, Set, Tuple

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
    # A SET/REMOVE/DELETE after a MERGE targets something AGE 1.5.0 may drop
    # the change on (capability: merge_write — AGE applies it only to the first
    # entity a MERGE creates, while RETURN still shows the new value).
    has_unsafe_write_after_merge: bool = False
    # The same check for AGE 1.6.0 (capability: merge_write in the 1.6.0 table):
    # a write after a MERGE may reach one MERGE-created entity from several rows,
    # and AGE keeps only one of those writes.
    has_repeated_merge_write: bool = False
    # Character spans (start, stop inclusive) of '<expr> IN <empty list>'
    # (capability: empty_list_in — AGE 1.5.0 matches every row, or fails with
    # 'cache lookup failed for type 0' under NOT / AND / RETURN).
    empty_in_spans: List[Tuple[int, int]] = field(default_factory=list)

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


def _rule_children(ctx) -> List[ParserRuleContext]:
    """Rule (non-token) children of a parse-tree context."""
    return [c for c in (ctx.getChild(i) for i in range(ctx.getChildCount())) if isinstance(c, ParserRuleContext)]


def _only_whitespace_tokens(ctx) -> bool:
    """True when every token child of ``ctx`` is whitespace (SP, comments included)."""
    for i in range(ctx.getChildCount()):
        child = ctx.getChild(i)
        if not isinstance(child, ParserRuleContext) and child.getSymbol().type != CypherParser.SP:
            return False
    return True


def _unwrap(ctx) -> ParserRuleContext:
    """Descend single-child chains and ``( ... )`` wrappers to the innermost context.

    ``oC_Expression`` reaches a plain atom through a dozen single-child
    levels; a level with an operator token (``NOT``, ``-``, ``+``) or a
    second operand stops the descent, so the result is that level.
    """
    node = ctx
    while True:
        if isinstance(node, CypherParser.OC_ParenthesizedExpressionContext):
            node = node.oC_Expression()
            continue
        if isinstance(node, (CypherParser.OC_VariableContext, CypherParser.OC_ListLiteralContext)):
            return node
        rules = _rule_children(node)
        if len(rules) != 1 or not _only_whitespace_tokens(node):
            return node
        node = rules[0]


def _bare_variable(ctx) -> Optional[str]:
    """Variable name when ``ctx`` is only a variable (``r``, ``(r)``), else None."""
    node = _unwrap(ctx)
    if isinstance(node, CypherParser.OC_VariableContext):
        return _strip_backticks(node.getText())
    return None


def _is_empty_list(ctx) -> bool:
    """True when ``ctx`` is a list literal with no elements: ``[]``, ``[ /*c*/ ]``, ``([])``."""
    node = _unwrap(ctx)
    return isinstance(node, CypherParser.OC_ListLiteralContext) and not node.oC_Expression()


def _empty_in_span(ctx) -> Optional[Tuple[int, int]]:
    """Span of an oC_StringListNullPredicateExpression up to its last empty-list ``IN``.

    The predicate chain is left-associative, so everything before the last
    empty-list ``IN`` is that ``IN``'s left operand; the span covers the whole
    ``<lhs> IN []`` and later predicates (e.g. ``IS NULL``) stay outside it.
    """
    last = None
    for child in _rule_children(ctx):
        if isinstance(child, CypherParser.OC_ListPredicateExpressionContext):
            if _is_empty_list(child.oC_AddOrSubtractExpression()):
                last = child
    if last is None:
        return None
    return (ctx.start.start, last.stop.stop)


def _write_target(item_ctx) -> Optional[str]:
    """Variable a SET/REMOVE item changes, or None when it cannot be named.

    ``r.p = 1``, ``r = {...}``, ``r += {...}``, ``r:L`` and ``(r).p`` all give
    ``'r'``; ``head(xs).p`` gives None.
    """
    variable = item_ctx.oC_Variable()
    if variable is not None:
        return _strip_backticks(variable.getText())
    prop = item_ctx.oC_PropertyExpression()
    return _bare_variable(prop.oC_Atom()) if prop is not None else None


_BINDING_CONTEXTS = (
    CypherParser.OC_NodePatternContext,
    CypherParser.OC_RelationshipDetailContext,
    CypherParser.OC_PatternPartContext,
)


def _pattern_variables(ctx) -> Set[str]:
    """Path, node and relationship variables a pattern binds."""
    names: Set[str] = set()

    def visit(node) -> None:
        if isinstance(node, _BINDING_CONTEXTS):
            variable = node.oC_Variable()
            if variable is not None:
                names.add(_strip_backticks(variable.getText()))

    _walk(ctx, visit)
    return names


def _has_relationship(ctx) -> bool:
    """True when a pattern contains a relationship (``-[r]->``, ``-->``, ``--``)."""
    found: List = []

    def visit(node) -> None:
        if isinstance(node, CypherParser.OC_RelationshipPatternContext):
            found.append(node)

    _walk(ctx, visit)
    return bool(found)


def _clauses(single_query) -> Iterator[ParserRuleContext]:
    """Clauses of one oC_SingleQuery in source order: reading, updating, WITH, RETURN."""
    for child in _rule_children(single_query):
        if isinstance(child, (CypherParser.OC_SinglePartQueryContext, CypherParser.OC_MultiPartQueryContext)):
            yield from _clauses(child)
        elif isinstance(child, (CypherParser.OC_ReadingClauseContext, CypherParser.OC_UpdatingClauseContext)):
            yield _rule_children(child)[0]
        elif isinstance(child, (CypherParser.OC_WithContext, CypherParser.OC_ReturnContext)):
            yield child


def _project(items_ctx, bound: Set[str], tracked: List[Set[str]]) -> Tuple[Set[str], List[Set[str]]]:
    """Variables in scope after a WITH projection, and each tracked subset of them.

    ``WITH *`` keeps the scope; ``WITH a`` and ``WITH a AS x`` keep a tracked
    variable tracked under its new name; any other projected name drops out
    of every tracked set.
    """
    star = items_ctx.getChild(0).getText() == '*'
    new_bound = set(bound) if star else set()
    new_tracked = [set(t) if star else set() for t in tracked]
    for item in items_ctx.oC_ProjectionItem():
        source = _bare_variable(item.oC_Expression())
        alias = item.oC_Variable()
        name = _strip_backticks(alias.getText()) if alias is not None else source
        if name is None:
            continue
        new_bound.add(name)
        for old, new in zip(tracked, new_tracked):
            if source is not None and source in old:
                new.add(name)
            else:
                new.discard(name)
    return new_bound, new_tracked


def _write_targets(clause) -> List[Optional[str]]:
    """Variables a SET/REMOVE/DELETE clause changes (None where one cannot be named)."""
    if isinstance(clause, CypherParser.OC_SetContext):
        return [_write_target(item) for item in clause.oC_SetItem()]
    if isinstance(clause, CypherParser.OC_RemoveContext):
        return [_write_target(item) for item in clause.oC_RemoveItem()]
    return [_bare_variable(expr) for expr in clause.oC_Expression()]


_WRITE_CLAUSES = (CypherParser.OC_SetContext, CypherParser.OC_RemoveContext, CypherParser.OC_DeleteContext)

# Clauses that can turn one row into many.
_ROW_MULTIPLYING_CLAUSES = (
    CypherParser.OC_MatchContext,
    CypherParser.OC_UnwindContext,
    CypherParser.OC_InQueryCallContext,
)


def _referenced_variables(ctx) -> Set[str]:
    """Every variable name used under ``ctx``: pattern nodes, property values, and so on."""
    names: Set[str] = set()

    def visit(node) -> None:
        if isinstance(node, CypherParser.OC_VariableContext):
            names.add(_strip_backticks(node.getText()))

    _walk(ctx, visit)
    return names


def _steps_of(ctx, steps: Dict[str, Set[int]]) -> Set[int]:
    """Row-multiplying steps that the variables used under ``ctx`` change with.

    Args:
        ctx: A parse-tree node (an expression or a property map), or None.
        steps: For each variable bound so far, the steps it changes with.

    Returns:
        The union of the steps of every variable used under ``ctx``.
    """
    found: Set[int] = set()
    if ctx is not None:
        for name in _referenced_variables(ctx):
            found |= steps.get(name, set())
    return found


def _project_steps(items_ctx, steps: Dict[str, Set[int]]) -> Dict[str, Set[int]]:
    """Steps of each variable a WITH projects.

    ``WITH *`` keeps every variable; ``WITH row.id AS k`` gives ``k`` the steps
    of ``row``. A name the WITH does not project drops out.

    Args:
        items_ctx: The WITH's ``oC_ProjectionItems``.
        steps: Steps of each variable bound before the WITH.

    Returns:
        Steps of each variable bound after the WITH.
    """
    star = items_ctx.getChild(0).getText() == '*'
    out = {name: set(found) for name, found in steps.items()} if star else {}
    for item in items_ctx.oC_ProjectionItem():
        alias = item.oC_Variable()
        name = _strip_backticks(alias.getText()) if alias is not None else _bare_variable(item.oC_Expression())
        if name is not None:
            out[name] = _steps_of(item.oC_Expression(), steps)
    return out


def _path_elements(part) -> Tuple[list, list]:
    """Node patterns and relationship patterns of a pattern part, in path order.

    Args:
        part: An ``oC_PatternPart``.

    Returns:
        ``(nodes, relationships)``: ``relationships[i]`` (an
        ``oC_RelationshipPattern``) joins ``nodes[i]`` and ``nodes[i + 1]``.
    """
    element = part.oC_AnonymousPatternPart().oC_PatternElement()
    while element.oC_NodePattern() is None:
        element = element.oC_PatternElement()
    nodes = [element.oC_NodePattern()]
    relationships = []
    for chain in element.oC_PatternElementChain():
        relationships.append(chain.oC_RelationshipPattern())
        nodes.append(chain.oC_NodePattern())
    return nodes, relationships


def _one_edge_per_row(relationship) -> bool:
    """True when a MATCH on this relationship alone yields each edge on one row.

    An undirected pattern (no arrowhead, or both) matches an edge from each
    end, so every edge comes twice; a variable-length one puts an edge on
    every path through it.

    Args:
        relationship: An ``oC_RelationshipPattern``.

    Returns:
        True for a directed, fixed-length relationship.
    """
    directed = (relationship.oC_LeftArrowHead() is None) != (relationship.oC_RightArrowHead() is None)
    detail = relationship.oC_RelationshipDetail()
    return directed and (detail is None or detail.oC_RangeLiteral() is None)


def _element_name(ctx) -> Optional[str]:
    """Variable of a node pattern or relationship detail, or None when it has none."""
    variable = ctx.oC_Variable() if ctx is not None else None
    return _strip_backticks(variable.getText()) if variable is not None else None


def _pattern_steps(
    part, steps: Dict[str, Set[int]], bound: Set[str], match_step: Optional[int] = None
) -> Dict[str, Set[int]]:
    """Steps of the variables a MATCH or MERGE pattern part introduces.

    A node changes with the steps its own properties use: a fixed key such as
    ``{name: 'acme'}`` reaches the same node on every row. A relationship
    changes with the steps of both its end nodes and of its own properties.
    The rows of a MATCH part are distinct matches of it, so the variable of a
    single-node part, or of the one directed, fixed-length relationship of a
    single-hop part, also changes with the part's step; the nodes of a longer
    path repeat (one node, many edges) and do not, nor does an edge that an
    undirected or variable-length pattern puts on several rows. A path
    variable changes with its MATCH step, or,
    in a MERGE, with the steps every element shares. Variables bound before
    the part keep their steps.

    Args:
        part: An ``oC_PatternPart`` of a MATCH or MERGE.
        steps: Steps of each variable bound so far.
        bound: Variables bound before this part.
        match_step: The step of this MATCH part; None for a MERGE.

    Returns:
        Steps of each variable the part introduces.
    """
    nodes, relationships = _path_elements(part)
    details = [relationship.oC_RelationshipDetail() for relationship in relationships]
    distinct = None
    if match_step is not None:
        if not details:
            distinct = nodes[0]
        elif len(details) == 1 and _one_edge_per_row(relationships[0]):
            distinct = details[0]

    def own(ctx) -> Set[int]:
        name = _element_name(ctx)
        if name is not None and name in bound:
            return set(steps.get(name, set()))
        found = _steps_of(ctx.oC_Properties() if ctx is not None else None, steps)
        if distinct is not None and ctx is distinct:
            found.add(match_step)
        return found

    node_steps = [own(node) for node in nodes]
    rel_steps = [own(detail) | node_steps[i] | node_steps[i + 1] for i, detail in enumerate(details)]
    found: Dict[str, Set[int]] = {}
    for ctx, element_steps in zip(nodes + details, node_steps + rel_steps):
        name = _element_name(ctx)
        if name is not None and name not in bound:
            found[name] = element_steps
    path = _element_name(part)
    if path is not None and path not in bound:
        found[path] = {match_step} if match_step is not None else set.intersection(*(node_steps + rel_steps))
    return found


def _unsafe_write_after_merge(single_query, writes_reach_every_merge: bool = False) -> bool:
    """True when a SET/REMOVE/DELETE after a MERGE changes something AGE may drop.

    Two engine behaviours, picked by ``writes_reach_every_merge``:

    - ``False`` (AGE 1.5.0): changes reach only the first entity a MERGE
      creates in a statement. Changes to every other entity a MERGE creates —
      on later rows, by a second MERGE, the far node or the edge of a path
      MERGE — are dropped while RETURN shows them. After the first MERGE a
      write may only target a variable bound before it, or the node of a
      single-node MERGE that opens the query (one row, so it is the first
      entity created).
    - ``True`` (AGE 1.6.0): changes reach every entity a MERGE creates, but
      when one entity receives several writes in a statement, AGE keeps only
      one of them. A write may target a variable a MERGE introduced when every
      row writes its own entity. Each row-multiplying step (an UNWIND, a CALL,
      one comma-separated part of a MATCH) gets an id, each variable records
      the steps it changes with (``_pattern_steps``), and a MERGE entity is
      per-row only when it changes with every step before it. A fixed key, a
      variable from an earlier step, or one side of a cross product repeats
      across the rows of a later step, so writes to it are unsafe.

    In both modes a MATCH/UNWIND/CALL between the MERGE and the write repeats
    the write once per row on the same entity, so it makes the target unsafe;
    a target that cannot be named counts as unsafe too. Repeated keys in the
    data (one entity reached from two rows) cannot be seen in the query text.
    """
    bound: Set[str] = set()
    # None until the first MERGE; then the variables bound before it.
    safe: Optional[Set[str]] = None
    # Variables a MERGE introduced that each row still writes once.
    fresh: Set[str] = set()
    # The 1.6.0 mode only: the row-multiplying steps so far, and for each
    # variable the steps it changes with.
    all_steps: Set[int] = set()
    steps: Dict[str, Set[int]] = {}
    for index, clause in enumerate(_clauses(single_query)):
        if isinstance(clause, _WRITE_CLAUSES):
            if safe is None:
                continue
            if any(t is None or (t not in safe and t not in fresh) for t in _write_targets(clause)):
                return True
            continue
        if isinstance(clause, CypherParser.OC_MergeContext):
            part = clause.oC_PatternPart()
            introduced = _pattern_variables(part) - bound
            if safe is None:
                safe = set(bound)
                if not writes_reach_every_merge and index == 0 and not _has_relationship(part):
                    fresh = introduced
            merged = _pattern_steps(part, steps, bound)
            steps.update(merged)
            if writes_reach_every_merge:
                fresh |= {name for name, changes_with in merged.items() if changes_with >= all_steps}
            bound |= introduced
            continue
        if isinstance(clause, _ROW_MULTIPLYING_CLAUSES):
            fresh = set()
        if isinstance(clause, CypherParser.OC_MatchContext):
            for part in clause.oC_Pattern().oC_PatternPart():
                nodes, relationships = _path_elements(part)
                if not relationships and _element_name(nodes[0]) in bound:
                    # A lone node bound earlier only filters rows.
                    continue
                step = len(all_steps)
                all_steps.add(step)
                steps.update(_pattern_steps(part, steps, bound, match_step=step))
                bound |= _pattern_variables(part)
        elif isinstance(clause, CypherParser.OC_CreateContext):
            # CREATE makes a new entity on every row.
            created = _pattern_variables(clause.oC_Pattern()) - bound
            steps.update({name: set(all_steps) for name in created})
            bound |= created
        elif isinstance(clause, CypherParser.OC_UnwindContext):
            variable = _strip_backticks(clause.oC_Variable().getText())
            step = len(all_steps)
            all_steps.add(step)
            steps[variable] = {step}
            bound.add(variable)
        elif isinstance(clause, CypherParser.OC_InQueryCallContext):
            step = len(all_steps)
            all_steps.add(step)
            if clause.oC_YieldItems() is not None:
                for item in clause.oC_YieldItems().oC_YieldItem():
                    variable = _strip_backticks(item.oC_Variable().getText())
                    steps[variable] = {step}
                    bound.add(variable)
        elif isinstance(clause, CypherParser.OC_WithContext):
            items = clause.oC_ProjectionBody().oC_ProjectionItems()
            steps = _project_steps(items, steps)
            if safe is None:
                bound, _ = _project(items, bound, [])
            else:
                bound, (safe, fresh) = _project(items, bound, [safe, fresh])
    return False


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
        if isinstance(node, CypherParser.OC_SingleQueryContext):
            single_queries.append(node)
        if isinstance(node, CypherParser.OC_StringListNullPredicateExpressionContext):
            span = _empty_in_span(node)
            if span is not None:
                facts.empty_in_spans.append(span)

    sort_items: List[str] = []
    # One entry per UNION branch: each has its own variable scope.
    single_queries: List = []
    try:
        _walk(tree, visit)
        facts.has_unsafe_write_after_merge = any(_unsafe_write_after_merge(q) for q in single_queries)
        facts.has_repeated_merge_write = any(
            _unsafe_write_after_merge(q, writes_reach_every_merge=True) for q in single_queries
        )
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
