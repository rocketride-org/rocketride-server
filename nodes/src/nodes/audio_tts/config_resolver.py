# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide
# =============================================================================

# Helpers that keep audio_tts-specific config rules out of IGlobal.
#
# Intent:
# - Keep Config.getNodeConfig as the base merge.
# - Apply audio_tts-only post-processing (profile->engine lock, api_key promotion).
# - Work with mapping-like connector objects (IJson-style .get/.items), no toDict.

from typing import Any, Callable, Dict

from rocketlib import getServiceDefinition
from ai.common.config import Config


def _pick_api_key(raw: Any) -> str:
    """Read api_key from raw connector shapes used by audio_tts profiles."""

    def pick(d: Any) -> str:
        if d is None or not hasattr(d, 'get'):
            return ''
        v = d.get('api_key')
        if v is not None and str(v).strip():
            return str(v).strip()
        return ''

    if raw is None or not hasattr(raw, 'get'):
        return ''
    k = pick(raw)
    if k:
        return k
    k = pick(raw.get('parameters'))
    if k:
        return k
    profile = raw.get('profile')
    if isinstance(profile, str) and profile:
        k = pick(raw.get(profile))
        if k:
            return k
        if '-' in profile:
            k = pick(raw.get(profile.split('-', 1)[0]))
            if k:
                return k
    for alt in ('openai', 'elevenlabs'):
        k = pick(raw.get(alt))
        if k:
            return k
    return ''


def _as_dict(obj: Any) -> Dict[str, Any]:
    """Best-effort conversion for mapping-like objects (dict or IJson-like with ``items``)."""
    if isinstance(obj, dict):
        return obj
    if obj is None:
        return {}
    items_fn = getattr(obj, 'items', None)
    if callable(items_fn):
        try:
            return dict(items_fn())
        except Exception:
            return {}
    return {}


def resolve_cloud_api_key(cfg: Dict[str, Any], raw: Any, engine: str, read_cfg: Callable[[Dict[str, Any], str, Any], Any]) -> str:
    """Resolve cloud ``api_key`` from merged cfg/raw connector, then env fallback by engine."""
    k = (read_cfg(cfg, 'api_key', '') or '').strip() or _pick_api_key(raw)
    if k:
        return k
    e = engine.lower()
    if e == 'openai':
        import os

        return os.environ.get('OPENAI_API_KEY', '').strip()
    if e == 'elevenlabs':
        import os

        return os.environ.get('ELEVENLABS_API_KEY', '').strip()
    return ''


def _merge_cfg_locked_profile_engine(logical_type: str, raw: Any, cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Ensure cfg.engine matches the selected profile's preconfig engine."""
    profile = raw.get('profile') if raw is not None and hasattr(raw, 'get') else None
    if (not isinstance(profile, str) or not profile.strip()) and hasattr(cfg, 'get'):
        p = cfg.get('profile')
        if isinstance(p, str) and p.strip():
            profile = p.strip()
    if not isinstance(profile, str) or not profile:
        return cfg
    try:
        sdef = getServiceDefinition(logical_type)
    except Exception:
        return cfg
    if not isinstance(sdef, dict):
        return cfg
    pre = sdef.get('preconfig') or {}
    prof = (pre.get('profiles') or {}).get(profile)
    if not isinstance(prof, dict):
        return cfg
    eng = prof.get('engine')
    if not eng:
        return cfg
    merged = _as_dict(cfg)
    merged['engine'] = eng
    return merged


def resolve_merged_config(logical_type: str, raw: Any) -> tuple[Any, Dict[str, Any]]:
    """Return ``(raw, cfg)`` after base merge + audio_tts-specific normalization."""
    cfg = Config.getNodeConfig(logical_type, raw)
    cfg = _merge_cfg_locked_profile_engine(logical_type, raw, cfg)
    cfg = _as_dict(cfg)
    ak = _pick_api_key(raw)
    if ak:
        cfg = dict(cfg)
        cfg['api_key'] = ak
    return raw, cfg
