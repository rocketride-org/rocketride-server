from __future__ import annotations

from typing import Any, Dict, Optional


def _best_effort_pydantic_dump(value: Any) -> Any:
    """
    Best-effort unwrap for pydantic-ish models.

    - Pydantic v2: model_dump()
    - Pydantic v1: dict()
    """
    if value is None:
        return None
    if isinstance(value, (dict, list, tuple, str, int, float, bool)):
        return value

    if hasattr(value, 'model_dump') and callable(getattr(value, 'model_dump')):
        try:
            return value.model_dump()  # type: ignore[no-any-return]
        except Exception:
            return value

    if hasattr(value, 'dict') and callable(getattr(value, 'dict')):
        try:
            return value.dict()  # type: ignore[no-any-return]
        except Exception:
            return value

    return value


def normalize_invocation_payload(*, input: Any = None, kwargs: Optional[Dict[str, Any]] = None) -> Any:
    """
    Normalize tool invocation payload shapes across frameworks.

    Supported input forms:
    - Direct dict payload
    - Pydantic-ish model payloads (best-effort to dict)
    - `{ "input": X }` wrapper (unwrapped)
    - `{ "input": { ... }, ...extras }` wrapper (extras merged into inner dict; extras override)
    - `input=<payload>, **kwargs` (kwargs merged into payload dict when possible)
    - kwargs-only invocations (payload becomes kwargs)
    """
    kw = kwargs or {}

    payload: Any
    if input is not None:
        payload = _best_effort_pydantic_dump(input)
        if kw:
            if isinstance(payload, dict):
                payload = {**payload, **kw}
            else:
                payload = {'input': payload, **kw}
    elif kw:
        payload = kw
    else:
        payload = {}

    payload = _best_effort_pydantic_dump(payload)

    if isinstance(payload, dict) and 'input' in payload:
        if len(payload) == 1:
            return _best_effort_pydantic_dump(payload.get('input'))

        inner = _best_effort_pydantic_dump(payload.get('input'))
        if isinstance(inner, dict):
            extras = {k: v for k, v in payload.items() if k != 'input'}
            return {**inner, **extras}

    return payload

