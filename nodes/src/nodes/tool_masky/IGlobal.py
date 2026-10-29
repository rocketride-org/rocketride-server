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
Masky node -- global (shared) state.

Reads the node configuration, resolves the API key (the node field first, then
``ROCKETRIDE_MASKY_KEY``) and creates the ``MaskyDriver`` that serves the
``masky.*`` tools. The pipeline action settings are parsed here too, so a bad
value fails the pipeline at start rather than on the first record.
"""

from __future__ import annotations

import math
import urllib.parse
from typing import Any, Dict, List

from ai.common.config import Config, check_credential_resolved
from ai.common.utils import parse_bool
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .masky_client import MaskyClient
from .masky_core import ACTIONS, ASPECT_RATIOS, ENV_API_KEY, LIMITS, MASKY_BASE_URL, resolve_api_key
from .masky_driver import MaskyDriver

QUALITIES = ('720p-draft', '720p', '1080p-draft', '1080p')

# Plain http is accepted only for these hosts (a local mock server), so the API
# key, sent as a Bearer header on every request, never crosses a network unencrypted.
LOCAL_HOSTS = ('localhost', '127.0.0.1', '::1')


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


def _choice(cfg: Dict[str, Any], name: str, default: str, allowed: tuple) -> str:
    value = str(cfg.get(name) or default).strip()
    if value not in allowed:
        raise ValueError(f'{name} must be one of {", ".join(allowed)} (got {value!r})')
    return value


def _int(cfg: Dict[str, Any], name: str, default: int, minimum: int, maximum: int | None = None) -> int:
    raw = cfg.get(name, default)
    if raw is None or raw == '':
        return default
    bound = f'between {minimum} and {maximum}' if maximum is not None else f'>= {minimum}'
    if isinstance(raw, bool):
        raise ValueError(f'{name} must be an integer {bound}')
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ValueError(f'{name} must be an integer {bound}') from None
    if value < minimum or (maximum is not None and value > maximum):
        raise ValueError(f'{name} must be an integer {bound}')
    return value


def read_settings(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Parse and range-check the node settings; raise ValueError on the first bad value."""
    raw_credits = cfg.get('maxCreditsPerCall', 1.0)
    try:
        max_credits = float(1.0 if raw_credits in (None, '') else raw_credits)
    except (TypeError, ValueError):
        raise ValueError('maxCreditsPerCall must be a number >= 0') from None
    if isinstance(raw_credits, bool) or not math.isfinite(max_credits) or max_credits < 0:
        raise ValueError('maxCreditsPerCall must be a finite number >= 0')

    fps = _int(cfg, 'fps', 24, 1)
    if fps not in (24, 48):
        raise ValueError('fps must be 24 or 48')

    seed_raw = cfg.get('seed')
    seed = None if seed_raw in (None, '') else _int(cfg, 'seed', 0, 0)

    return {
        'server_name': str(cfg.get('serverName') or 'masky').strip(),
        'base_url': validate_base_url(str(cfg.get('baseUrl') or MASKY_BASE_URL)),
        'max_credits_per_call': max_credits,
        'timeout_sec': _int(cfg, 'timeoutSec', 300, 10),
        'poll_interval_sec': _int(cfg, 'pollIntervalSec', 3, 1),
        'default_avatar': str(cfg.get('defaultAvatar') or '').strip(),
        'default_look': str(cfg.get('defaultLook') or '').strip(),
        'language': str(cfg.get('language') or 'en').strip(),
        'include_media_urls': parse_bool(cfg.get('includeMediaUrls', True)),
        # Permission switches for agent tools (all off by default). readOnly does not
        # affect the pipeline action; allowPublicSharing also applies to scene_video.
        'read_only': parse_bool(cfg.get('readOnly', False)),
        'allow_delete': parse_bool(cfg.get('allowDelete', False)),
        'allow_public_sharing': parse_bool(cfg.get('allowPublicSharing', False)),
        'action': _choice(cfg, 'action', 'talking_head', ACTIONS),
        # talking_head
        'output': _choice(cfg, 'output', 'video', ('video', 'audio')),
        'text_mode': _choice(cfg, 'textMode', 'literal', ('literal', 'personality')),
        # scene_video
        'quality': _choice(cfg, 'quality', '720p-draft', QUALITIES),
        'aspect_ratio': _choice(cfg, 'aspectRatio', '16:9', ASPECT_RATIOS),
        'fps': fps,
        'duration_sec': _int(cfg, 'durationSec', 5, LIMITS['video_duration_min'], LIMITS['video_duration_max']),
        'seed': seed,
        'silent': parse_bool(cfg.get('silent', False)),
        'expand_prompt': parse_bool(cfg.get('expandPrompt', True)),
        'share': _choice(cfg, 'share', 'private', ('private', 'public')),
        'source_image_url': str(cfg.get('sourceImageUrl') or '').strip(),
        'speech_line': str(cfg.get('speechLine') or '').strip(),
        # image
        'engine': _choice(cfg, 'engine', 'default', ('default', 'ideogram')),
        'edit_engine': _choice(cfg, 'editEngine', 'default', ('default', 'qwen')),
        # live
        'conversation': str(cfg.get('conversation') or '').strip(),
        'turn_mode': _choice(cfg, 'turnMode', 'chat', ('chat', 'speak')),
        'turn_output': _choice(cfg, 'turnOutput', 'audio', ('audio', 'video')),
        'wait_for_turn': parse_bool(cfg.get('waitForTurn', True)),
    }


def config_warnings(cfg: Dict[str, Any]) -> List[str]:
    """Problems worth flagging in the editor; never raises."""
    found: List[str] = []
    if not resolve_api_key(cfg.get('apikey')):
        found.append(f'API key is required (or set {ENV_API_KEY} on the engine host)')
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
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import load_depends

        load_depends(__file__)

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        api_key = resolve_api_key(cfg.get('apikey'))
        if not api_key:
            warning(
                f'Masky API key is required. Set it on the node or in {ENV_API_KEY}. Get one at https://masky.ai/developer'
            )
            raise ValueError('Masky API key not configured')
        # A ${ROCKETRIDE_...} placeholder with no saved value must not reach Masky as the key.
        check_credential_resolved(self.glb.logicalType, 'apikey', api_key, self.glb.connConfig)

        try:
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

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            for message in config_warnings(cfg):
                warning(message)
            try:
                check_credential_resolved(
                    self.glb.logicalType, 'apikey', resolve_api_key(cfg.get('apikey')), self.glb.connConfig
                )
            except Exception as e:  # noqa: BLE001 - validateConfig only warns
                warning(str(e))
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        if self.driver is not None:
            self.driver.close()
        self.driver = None
        self.settings = None
