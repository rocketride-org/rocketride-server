"""
Normalize ``glb.connConfig`` from the engine into a plain ``dict``.

Kept on the ``audio_tts`` node so :mod:`ai.common.config` stays aligned with ``develop``
(no global unwrap there). If the engine always delivers clean dicts later, this module
can shrink or go away.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

import json5
from rocketlib import IJson


def _normalize_conn_value(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, IJson):
        try:
            v = IJson.toDict(v)
        except Exception:
            v = None
    td = getattr(v, 'toDict', None)
    if v is not None and callable(td) and not isinstance(v, (dict, list, str, int, float, bool)):
        try:
            v = td()
        except Exception:
            pass
    if isinstance(v, str):
        d = _json_parse_to_dict(v.strip())
        if d is not None:
            v = d
        else:
            return v
    if isinstance(v, dict):
        return {str(k): _normalize_conn_value(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_normalize_conn_value(x) for x in v]
    return v


def _deep_unwrap_conn_root(obj: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(obj, dict):
        return {}
    return {str(k): _normalize_conn_value(v) for k, v in obj.items()}


def _json_parse_to_dict(s: str) -> Optional[Dict[str, Any]]:
    s = (s or '').strip()
    if s.startswith('\ufeff'):
        s = s[1:].strip()
    if not s:
        return None
    try:
        p = json.loads(s)
    except Exception:
        try:
            p = json5.loads(s)
        except Exception:
            return None
    if isinstance(p, dict):
        return p
    if isinstance(p, str):
        inner = p.strip()
        if inner.startswith('{'):
            try:
                p2 = json.loads(inner)
            except Exception:
                try:
                    p2 = json5.loads(inner)
                except Exception:
                    return None
            return p2 if isinstance(p2, dict) else None
    return None


def unwrap_connector_config_from_engine(connConfig: Any) -> Dict[str, Any]:
    """Plain dict for merge; handles ``IJson``, empty ``toDict()``, JSON strings, key/get walk."""
    if connConfig is None:
        return {}
    if isinstance(connConfig, dict):
        return _deep_unwrap_conn_root(connConfig)
    if isinstance(connConfig, str):
        d = _json_parse_to_dict(connConfig.strip())
        return _deep_unwrap_conn_root(d) if d else {}

    t: Any = None
    td = getattr(connConfig, 'toDict', None)
    if callable(td):
        try:
            t = td()
        except Exception:
            t = None
    if t is None and isinstance(connConfig, IJson):
        try:
            t = IJson.toDict(connConfig)
        except Exception:
            t = None

    if isinstance(t, str):
        d = _json_parse_to_dict(t.strip())
        if d:
            return _deep_unwrap_conn_root(d)
    elif isinstance(t, dict) and t:
        return _deep_unwrap_conn_root(t)

    try:
        d = _json_parse_to_dict(str(connConfig).strip())
        if d:
            return _deep_unwrap_conn_root(d)
    except Exception:
        pass
    try:
        keys_fn = getattr(connConfig, 'keys', None)
        get_fn = getattr(connConfig, 'get', None)
        if callable(keys_fn) and callable(get_fn):
            kl = list(keys_fn())
            if kl:
                built: Dict[str, Any] = {}
                for k in kl:
                    sk = str(k)
                    try:
                        built[sk] = get_fn(sk)
                    except Exception:
                        try:
                            built[sk] = get_fn(k)
                        except Exception:
                            continue
                if built:
                    return _deep_unwrap_conn_root(built)
    except Exception:
        pass
    if isinstance(t, dict):
        return _deep_unwrap_conn_root(t)
    return {}
