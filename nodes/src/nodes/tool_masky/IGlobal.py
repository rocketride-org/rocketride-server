# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Masky node - global (shared) state.

Reads the resolved node configuration and creates the ``MaskyDriver`` that
serves the ``masky.*`` tools. The schema types, bounds and pins every setting
and requires the API key; this module keeps the semantic checks the schema
cannot express (an https base URL, a finite credit cap, a placeholder that was
never filled), so a bad value fails the pipeline at start rather than on the
first record.
"""

from __future__ import annotations

import math
import re
import urllib.parse
from collections.abc import Mapping
from typing import Any, Dict, List

from rocketlib import IGlobalBase, warning

from .masky_client import MaskyClient
from .masky_core import LIMITS
from .masky_driver import MaskyDriver

# Plain http is accepted only for these hosts (a local mock server), so the API
# key, sent as a Bearer header on every request, never crosses a network unencrypted.
LOCAL_HOSTS = ('localhost', '127.0.0.1', '::1')

# A ${NAME} the task did not fill, or the <REDACTED> the server substitutes
# for a non-ROCKETRIDE_ placeholder: neither is a key to send anywhere
_UNRESOLVED_CREDENTIAL = re.compile(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\}|<REDACTED>')


def validate_base_url(raw: str) -> str:
    """Return the base URL if it is https, or http to a loopback host; raise ValueError otherwise."""
    url = (raw or '').strip()
    try:
        parts = urllib.parse.urlsplit(url)
        host = (parts.hostname or '').lower()
    except ValueError:
        parts, host = None, ''
    scheme = parts.scheme.lower() if parts else ''
    if scheme == 'https' and host:
        return url
    if scheme == 'http' and host in LOCAL_HOSTS:
        return url
    raise ValueError(
        'baseUrl must start with https:// (plain http is allowed only for localhost, 127.0.0.1 or ::1), '
        'so the API key is never sent unencrypted.'
    )


def check_api_key(value: Any) -> str:
    """Return the stripped key; raise ValueError when it is blank or an unfilled placeholder."""
    key = str(value or '').strip()
    if not key:
        raise ValueError('Masky API key not configured. Get one at https://masky.ai/developer')
    match = _UNRESOLVED_CREDENTIAL.search(key)
    if match:
        raise ValueError(
            f'tool_masky.apikey is an unfilled placeholder ({match.group(0)}): save the variable it names '
            'under Environment Variables, or paste the key'
        )
    return key


def read_settings(cfg: Mapping) -> Dict[str, Any]:
    """Read the node settings from the resolved config; raise ValueError on a semantic problem.

    The resolver has already applied the defaults and checked every type, range
    and enum, so the view is read as is. What remains is the base URL scheme and
    a finite credit cap (JSON cannot carry one, a hand-built config can).
    """
    max_credits = float(cfg['maxCreditsPerCall'])
    if not math.isfinite(max_credits) or max_credits < 0:
        raise ValueError('maxCreditsPerCall must be a finite number >= 0')

    return {
        'server_name': cfg['serverName'],
        'base_url': validate_base_url(cfg['baseUrl']),
        'max_credits_per_call': max_credits,
        'timeout_sec': cfg['timeoutSec'],
        'poll_interval_sec': cfg['pollIntervalSec'],
        'default_avatar': str(cfg['defaultAvatar'] or '').strip(),
        'default_look': str(cfg['defaultLook'] or '').strip(),
        'language': cfg['language'].strip(),
        'include_media_urls': cfg['includeMediaUrls'],
        # Permission switches for agent tools (all off by default). readOnly does not
        # affect the pipeline action; allowPublicSharing also applies to scene_video.
        'read_only': cfg['readOnly'],
        'allow_delete': cfg['allowDelete'],
        'allow_public_sharing': cfg['allowPublicSharing'],
        'action': cfg['action'],
        # talking_head
        'output': cfg['output'],
        'text_mode': cfg['textMode'],
        # scene_video
        'quality': cfg['quality'],
        'aspect_ratio': cfg['aspectRatio'],
        'fps': cfg['fps'],
        'duration_sec': cfg['durationSec'],
        'seed': cfg['seed'],
        'silent': cfg['silent'],
        'expand_prompt': cfg['expandPrompt'],
        'share': cfg['share'],
        'source_image_url': str(cfg['sourceImageUrl'] or '').strip(),
        'speech_line': str(cfg['speechLine'] or '').strip(),
        # image
        'engine': cfg['engine'],
        'edit_engine': cfg['editEngine'],
        # live
        'conversation': str(cfg['conversation'] or '').strip(),
        'turn_mode': cfg['turnMode'],
        'turn_output': cfg['turnOutput'],
        'wait_for_turn': cfg['waitForTurn'],
    }


def config_warnings(cfg: Mapping) -> List[str]:
    """Problems worth flagging in the editor; never raises."""
    found: List[str] = []
    try:
        check_api_key(cfg['apikey'])
    except ValueError as e:
        found.append(str(e))
    try:
        settings = read_settings(cfg)
    except ValueError as e:
        found.append(str(e))
        return found
    if settings['action'] == 'scene_video' and settings['share'] == 'public' and not settings['allow_public_sharing']:
        found.append(
            "Scene video Share Page is Public, but 'allowPublicSharing' is off, so every render will be refused. Enable Allow Public Sharing or set Share Page to Private."
        )
    url = settings['source_image_url']
    if settings['action'] in ('scene_video', 'image') and url and not url.lower().startswith(('http://', 'https://')):
        found.append('Source image URL must be a public http(s) URL; Masky cannot read uploaded or local files')
    if len(settings['speech_line']) > LIMITS['video_speech_chars']:
        found.append(
            f'Speech line is {len(settings["speech_line"])} characters; Masky accepts {LIMITS["video_speech_chars"]}'
        )
    return found


class IGlobal(IGlobalBase):
    """Global state for tool_masky."""

    driver: MaskyDriver | None = None
    settings: Dict[str, Any] | None = None

    def beginGlobal(self) -> None:
        from depends import load_depends

        load_depends(__file__)

        # The resolved config: every setting defaulted, typed and ranged; the
        # key a required secret (a ${ROCKETRIDE_MASKY_KEY} reference resolved
        # per call, no process-env fallback)
        cfg = self.config

        try:
            # A ${ROCKETRIDE_...} placeholder with no saved value must not reach Masky as the key.
            api_key = check_api_key(cfg.apikey)
            self.settings = read_settings(cfg)
        except ValueError as e:
            warning(str(e))
            raise

        client = MaskyClient(api_key, base_url=self.settings['base_url'])
        import rocketlib

        self.driver = MaskyDriver(
            server_name=self.settings['server_name'],
            client=client,
            include_media_urls=self.settings['include_media_urls'],
            settings=self.settings,
            is_cancelled=getattr(rocketlib, 'isCancelled', None),
        )
        # One free, unauthenticated pricing read per run, so every later estimate
        # uses Masky's live rates without a request at call time. Never fails start.
        self.driver.load_pricing()

    def endGlobal(self) -> None:
        if self.driver is not None:
            self.driver.close()
        self.driver = None
        self.settings = None
