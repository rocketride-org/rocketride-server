# =============================================================================
# RocketRide Engine
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
Read-only check for GraphQL documents.

``mutation_refusal`` decides, before anything is sent, whether a document may run
while the node is in read-only mode. It does not parse GraphQL. It lexes just enough
to skip comments and string literals (plain and block strings), tracks nesting of
braces, parentheses and brackets, and collects the names that appear at nesting depth
zero. Operation keywords live at depth zero, and nothing inside a selection set,
argument list or variable definition does, so a document that defines a mutation
operation, anonymous or named, with or without variables, always has the name
``mutation`` there.

The check errs towards refusing: a depth-zero ``mutation`` that is not an operation
keyword (an operation or fragment named ``mutation``, a type condition
``on mutation``, a top-level directive ``@mutation``) is refused too, and so is a
document that cannot be lexed (an unterminated string, a line break inside a plain
string, unbalanced brackets), since it cannot be checked. The GraphQL grammar does
not allow such documents anyway. The word inside a comment, a string, a field name
or an argument never triggers it.
"""

from __future__ import annotations

import re

_NAME = re.compile(r'[_A-Za-z][_0-9A-Za-z]*')
_OPEN = '{(['
_CLOSE = '})]'

MUTATION_REFUSED = (
    'graphql refused by readOnly: the document contains a mutation operation, and read-only '
    'mode runs queries only. Turn readOnly off and graphqlAllowMutations on in the node '
    'configuration to run mutations.'
)
UNCHECKABLE_REFUSED = (
    'graphql refused by readOnly: the document has an unterminated string or unbalanced '
    'brackets, so it cannot be checked for a mutation operation.'
)


# With readOnly off, the same documents are refused until graphqlAllowMutations is on.
MUTATION_NOT_ALLOWED = (
    'graphql refused: the document contains a mutation operation, and graphqlAllowMutations is off. A '
    'mutation can do anything the credential allows, such as merging a pull request or deleting a '
    'branch, so turn graphqlAllowMutations on in the node configuration to run mutations.'
)
UNCHECKABLE_NOT_ALLOWED = (
    'graphql refused: the document has an unterminated string or unbalanced brackets, so it cannot be '
    'checked for a mutation operation, and graphqlAllowMutations is off. Fix the document, or turn '
    'graphqlAllowMutations on in the node configuration to send it as written.'
)


def not_allowed(refusal: str) -> str:
    """The message for ``refusal`` (a value ``mutation_refusal`` returned) when readOnly is off."""
    return UNCHECKABLE_NOT_ALLOWED if refusal == UNCHECKABLE_REFUSED else MUTATION_NOT_ALLOWED


def mutation_refusal(document: str) -> str | None:
    """Return the refusal message when read-only mode must not send ``document``, else ``None``."""
    names = top_level_names(document)
    if names is None:
        return UNCHECKABLE_REFUSED
    if 'mutation' in names:
        return MUTATION_REFUSED
    return None


def top_level_names(document: str) -> list[str] | None:
    """Return the names outside every brace, parenthesis and bracket, in document order.

    Comments and string literals are skipped, so a word inside them is never a name.
    Returns ``None`` when the document cannot be lexed this way.
    """
    names: list[str] = []
    depth = 0
    index = 0
    length = len(document)
    while index < length:
        char = document[index]
        if char == '#':
            # A comment runs to the end of the line.
            while index < length and document[index] not in '\r\n':
                index += 1
        elif document.startswith('"""', index):
            index = _skip_block_string(document, index + 3)
            if index < 0:
                return None
        elif char == '"':
            index = _skip_string(document, index + 1)
            if index < 0:
                return None
        elif char in _OPEN:
            depth += 1
            index += 1
        elif char in _CLOSE:
            depth -= 1
            if depth < 0:
                return None
            index += 1
        else:
            match = _NAME.match(document, index)
            if match is None:
                index += 1
                continue
            if depth == 0:
                names.append(match.group())
            index = match.end()
    return names if depth == 0 else None


def _skip_block_string(document: str, start: int) -> int:
    """Return the index after the closing triple quote, or -1; a backslash escapes a triple quote."""
    index = start
    while True:
        end = document.find('"""', index)
        if end < 0:
            return -1
        if document[end - 1] == '\\':
            index = end + 3
            continue
        return end + 3


def _skip_string(document: str, start: int) -> int:
    """Return the index after the closing quote, or -1 for an unterminated or multi-line string."""
    index = start
    length = len(document)
    while index < length:
        char = document[index]
        if char == '"':
            return index + 1
        if char == '\\':
            index += 2
            continue
        if char in '\r\n':
            return -1
        index += 1
    return -1
