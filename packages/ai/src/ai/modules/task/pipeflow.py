"""Pure helpers for reconstructing pipeline trace flow chains.

Kept dependency-free (typing only) so the enter/leave stack logic can be unit
tested in isolation, without instantiating the full Task engine.
"""

from __future__ import annotations

from typing import Dict, List


def apply_pipeflow_event(
    by_pipe: Dict[object, List[str]],
    pipe_index: object,
    operation: str,
    component_name: str,
) -> List[str]:
    """Update the per-pipe execution stack for one trace event and return a snapshot.

    `by_pipe` maps a reusable pipe-slot index to the current stack of component
    names nested under it. Reentrant agent sub-invocations (e.g. an agent calling
    qdrant -> transformer mid-run) share one `pipe_index` and their enter/leave
    events can interleave across threads, so:

    - `leave` pops by identity (the leaving component carried in the DBG line),
      not by position, dropping the last occurrence of `component_name`. A blind
      top-pop would remove the wrong frame when leaves arrive out of order.
    - the returned `pipes` is a fresh ``list(...)`` copy, never the live stack —
      the stack keeps mutating on later events, so emitting it by reference would
      let queued / later-serialized events reflect a mutated (corrupt) chain.

    Returns the point-in-time snapshot to attach to the emitted flow event.
    """
    stack = by_pipe.setdefault(pipe_index, [])

    if operation == 'begin':
        stack = by_pipe[pipe_index] = [component_name]
    elif operation == 'enter':
        stack.append(component_name)
    elif operation == 'leave':
        for i in range(len(stack) - 1, -1, -1):
            if stack[i] == component_name:
                del stack[i]
                break
        else:
            # Component not found (dropped/duplicate enter) — fall back to a top-pop.
            if stack:
                stack.pop()
    elif operation == 'end':
        stack = by_pipe[pipe_index] = []

    return list(stack)
