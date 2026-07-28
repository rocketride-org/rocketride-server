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

# ------------------------------------------------------------------------------
# Pure, engine-free mapping logic for the answer_documents node.
#
# Kept separate from IInstance so the answer -> document-content mapping can be
# unit-tested without the native engine (see nodes/test/test_answer_documents.py).
# ------------------------------------------------------------------------------

import json
from typing import Any, List


def answer_contents(answer: Any) -> List[str]:
    """Return the ``page_content`` string(s) an ``Answer`` should become.

    The granularity is "one document per validated fact":

    - a JSON list  -> one string per item (each item indexed independently)
    - a JSON object -> a single string
    - plain text -> a single string (empty/whitespace answers produce nothing)

    List items that are already strings are used verbatim; anything else is
    serialized with ``json.dumps`` so the document content is a faithful,
    self-describing representation of the validated fact.

    Args:
        answer: An ``Answer``-like object exposing ``isJson()``, ``getJson()``
            and ``getText()``.

    Returns:
        List[str]: Zero or more ``page_content`` strings.
    """
    if answer.isJson():
        try:
            data = answer.getJson()
        except ValueError:
            pass
        else:
            if data is None:
                return []
            items = data if isinstance(data, list) else [data]
            return [item if isinstance(item, str) else json.dumps(item, ensure_ascii=False) for item in items]

    text = (answer.getText() or '').strip()
    return [text] if text else []
