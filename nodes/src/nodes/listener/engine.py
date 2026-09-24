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
Backend-agnostic half of the Listener node: hand one item to the pipeline.

Adapters own delivery (polling, acknowledging, retries); they call
``run_item`` (via a worker thread) for each item and acknowledge only if it
returns. Nothing here knows which backend delivered the item.
"""

from __future__ import annotations

import json
from typing import Any

from ai.common.schema import Question
from rocketlib import getObject, monitorCompleted, monitorFailed


def run_item(target: Any, text: str, name: str) -> str:
    """Run ``text`` through the pipeline as a question; return the first answer or raise.

    Blocking: call from a worker thread (``asyncio.to_thread``), never the event loop.
    """
    size = len(text.encode('utf-8'))
    entry = getObject(obj={'url': name, 'name': text[:200]})
    pipe = target.getPipe()
    try:
        question = Question(role='')
        question.addQuestion(text)
        pipe.open(entry)
        pipe.writeQuestions(question)
        pipe.close()
        # The engine records a node failure on the entry instead of raising
        # (data_conn.py reads it the same way); treat it as a failed item so
        # the adapter does not acknowledge it.
        if getattr(entry, 'objectFailed', False):
            raise RuntimeError(f'listener: pipeline failed: {getattr(entry, "completionError", "")}')
        answers = entry.response.toDict().get('answers', [])
    except Exception:
        monitorFailed(size)
        raise
    finally:
        target.putPipe(pipe)
    if not answers:
        monitorFailed(size)
        raise RuntimeError('listener: pipeline produced no answer')
    monitorCompleted(size)
    first = answers[0]
    return first if isinstance(first, str) else json.dumps(first)
