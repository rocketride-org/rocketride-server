# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide
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
    """Read api_key from raw connector shapes used by audio_tts profiles.

    Searches for a non-empty ``api_key`` value in several locations within
    the ``IJson``-like connector config object, in priority order:

    1. Top-level ``raw.api_key``
    2. ``raw.parameters.api_key``
    3. ``raw[profile].api_key`` (current profile sub-dict)
    4. ``raw[profile_prefix].api_key`` (prefix before first ``-``)
    5. ``raw['openai'].api_key`` and ``raw['elevenlabs'].api_key``

    Args:
        raw: Raw connector config object (``IJson``-like, supports ``.get``).
            May be ``None``; in that case an empty string is returned.

    Returns:
        First non-empty API key found, or ``''`` if none is present.
    """

    def pick(d: Any) -> str:
        """Extract a non-empty ``api_key`` string from a mapping-like object, or return empty string."""
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
    """Best-effort conversion for mapping-like objects to a plain ``dict``.

    Handles three cases: already a ``dict`` (returned as-is), ``None``
    (returns ``{}``), and ``IJson``-like objects that expose an ``items()``
    method (converted via ``dict(obj.items())``).

    Args:
        obj: Object to convert.  May be a ``dict``, an ``IJson`` C++ wrapper,
            or ``None``.

    Returns:
        Plain Python ``dict``.  Returns ``{}`` on conversion failure.
    """
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
    """Resolve the cloud API key from merged config, raw connector, or environment variable.

    Resolution order:
    1. ``cfg['api_key']`` via ``read_cfg`` (covers ``parameters`` sub-dict).
    2. ``_pick_api_key(raw)`` (searches profile sub-dicts in the connector).
    3. ``OPENAI_API_KEY`` env var (OpenAI only).
    4. ``ELEVENLABS_API_KEY`` env var (ElevenLabs only).

    Args:
        cfg: Merged node config dict (output of ``Config.getNodeConfig``).
        raw: Raw connector config object (``IJson``-like).
        engine: Canonical engine name (e.g. ``'openai'``, ``'elevenlabs'``).
        read_cfg: Callable with signature ``(config, key, default) -> value``
            used to read keys from ``cfg`` and its ``parameters`` sub-dict.

    Returns:
        API key string, or ``''`` if not found anywhere.
    """
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
    """Override ``cfg['engine']`` with the engine locked in the selected profile's preconfig.

    Reads the active profile name from ``raw`` or ``cfg``, then looks up
    ``preconfig.profiles[profile].engine`` via ``getServiceDefinition``.
    When found, returns a copy of ``cfg`` with ``engine`` replaced so that
    the profile's declared engine cannot be overridden by user-supplied config.

    Args:
        logical_type: The node's logical type string used to call
            ``getServiceDefinition`` (e.g. ``'audio_tts'``).
        raw: Raw connector config object (``IJson``-like).
        cfg: Merged node config dict from ``Config.getNodeConfig``.

    Returns:
        ``cfg`` unchanged if no profile/engine lock applies, otherwise a new
        dict copy with ``engine`` set to the profile's locked value.
    """
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
    """Return ``(raw, cfg)`` after base merge and audio_tts-specific normalisation.

    Applies three steps on top of ``Config.getNodeConfig``:

    1. Profile-engine lock via ``_merge_cfg_locked_profile_engine`` so the
       profile's declared engine cannot be overridden.
    2. Conversion to a plain ``dict`` via ``_as_dict``.
    3. API key promotion: if ``_pick_api_key(raw)`` finds a key, it is
       written into ``cfg['api_key']`` so downstream resolvers find it at the
       top level.

    Args:
        logical_type: The node's logical type string (e.g. ``'audio_tts'``).
        raw: Raw connector config object (``IJson``-like) from
            ``glb.connConfig``.

    Returns:
        Tuple of ``(raw, cfg)`` where ``raw`` is the original connector object
        and ``cfg`` is the normalised plain-dict config.
    """
    cfg = Config.getNodeConfig(logical_type, raw)
    cfg = _merge_cfg_locked_profile_engine(logical_type, raw, cfg)
    cfg = _as_dict(cfg)
    ak = _pick_api_key(raw)
    if ak:
        cfg = dict(cfg)
        cfg['api_key'] = ak
    return raw, cfg
