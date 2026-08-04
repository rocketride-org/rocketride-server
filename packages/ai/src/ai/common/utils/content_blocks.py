"""
Flatten provider content blocks into plain text.

Chat models return one of two shapes. OpenAI-style backends return a plain
string. Anthropic-style backends with extended thinking enabled return a LIST of
typed blocks::

    [{'type': 'thinking', 'thinking': '...', 'signature': '<base64>'}, {'type': 'text', 'text': 'the actual answer'}]

Anything that treats that list as text — ``str(content)``, ``safe_str(...)``, or
just returning it — produces the *repr of the list* rather than the answer. That
is not a cosmetic problem for agents: the ReAct parser reads the model's output
back with a greedy ``Action Input: (.*)`` and swallows the serialized wrapper's
trailing ``", "type": "text"}]`` into the tool arguments, which json-repair then
welds onto the first key. Every tool call arrives as a single-key dict and every
declared field reports as missing.

So the block vocabulary lives here, once, and both the streaming and the
non-streaming response paths read it from the same place.
"""

from __future__ import annotations

from typing import Any, Tuple

__all__ = ['flatten_content_blocks']


def flatten_content_blocks(content: Any) -> Tuple[str, str, bool]:
    """Split provider content into visible text and reasoning text.

    Args:
        content: A response's ``content``: a plain string, or a list of typed
            blocks. Any other type is stringified so a caller never has to
            special-case ``None`` or an unexpected shape.

    Returns:
        ``(text, reasoning, saw_signature_only)``:

        - ``text`` — the visible answer: ``text`` blocks, plus untyped blocks,
          concatenated in order.
        - ``reasoning`` — chain-of-thought carried by ``thinking`` blocks
          (Anthropic) or ``reasoning`` blocks (the LangChain v1 standard name).
          Callers route this to a reasoning lane; it must never be concatenated
          into ``text``.
        - ``saw_signature_only`` — True when a thinking block carried only a
          verification ``signature`` and no readable text. Streaming callers use
          this to explain the gap to the user once per response.

    A plain string passes through as ``text`` untouched — inline ``<think>``
    tags are a separate, stateful concern owned by the streaming path.
    """
    if isinstance(content, str):
        return content, '', False
    if not isinstance(content, list):
        return ('' if content is None else str(content)), '', False

    text_parts: list = []
    reasoning_parts: list = []
    saw_signature_only = False

    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get('type', '')
        if btype == 'thinking':
            # Carries either readable deltas or, on the final delta, only the
            # block verification signature.
            piece = block.get('thinking') or block.get('text') or ''
            if piece:
                reasoning_parts.append(piece)
            elif block.get('signature'):
                saw_signature_only = True
        elif btype == 'reasoning':
            # LangChain v1 renamed the standard block: thinking -> reasoning.
            piece = block.get('reasoning') or block.get('text') or ''
            if piece:
                reasoning_parts.append(piece)
        elif btype == 'text' or not btype:
            text_parts.append(block.get('text', ''))

    return ''.join(text_parts), ''.join(reasoning_parts), saw_signature_only
