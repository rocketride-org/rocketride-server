# =============================================================================
# RocketRide Engine
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
OpenClaw client node — global (shared) state.

- Connects to an OpenClaw gateway via WebSocket
- Discovers tools at startup via tools.catalog RPC and caches them
- Optionally subscribes to messaging channels for the bridge feature
- Invokes tools via HTTP POST /tools/invoke
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .openclaw_client import OpenClawClient
from .openclaw_driver import OpenClawDriver

logger = logging.getLogger(__name__)

# Maps services.json config keys to OpenClaw group IDs
GROUP_MAP: Dict[str, Optional[str]] = {
    'groupWeb': 'group:web',
    'groupFs': 'group:fs',
    'groupRuntime': 'group:runtime',
    'groupUi': 'group:ui',
    'groupMessaging': 'group:messaging',
    'groupMemory': 'group:memory',
    'groupAutomation': 'group:automation',
    'groupSessions': 'group:sessions',
    'groupNodes': 'group:nodes',
    'groupSkills': None,  # catch-all for skill/plugin-provided groups
}

# The standard OpenClaw group IDs (non-skill groups)
_KNOWN_GROUPS = {v for v in GROUP_MAP.values() if v is not None}

# Tools blocked by OpenClaw's gateway HTTP deny list by default.
# These cannot be invoked via POST /tools/invoke without gateway config changes.
_GATEWAY_HTTP_DENIED = frozenset(
    {
        'exec',
        'process',  # group:runtime
        'read',
        'write',
        'edit',
        'apply_patch',  # group:fs
        'cron',  # group:automation
        'sessions_spawn',
        'sessions_send',  # group:sessions
        'gateway',  # group:automation
        'whatsapp_login',  # channel-specific
    }
)

# Hardcoded tool catalog for groups where tools.catalog RPC is unavailable
# (e.g. operator.read scope not granted). Indexed by OpenClaw group ID.
# Follows the same shape as the RPC response so _filter_tools() works unchanged.
_HARDCODED_GROUPS: Dict[str, Dict[str, Any]] = {
    'group:messaging': {
        'id': 'group:messaging',
        'label': 'Messaging',
        'tools': [
            {
                'id': 'message',
                'label': 'Send a message via a messaging channel',
                'description': ('Send an outbound message through WhatsApp, Telegram, or Discord. The channel must be connected and configured in the OpenClaw gateway.'),
                'inputSchema': {
                    'type': 'object',
                    'properties': {
                        'channel': {
                            'type': 'string',
                            'enum': ['whatsapp', 'telegram', 'discord'],
                            'description': 'Messaging channel to use',
                        },
                        'to': {
                            'type': 'string',
                            'description': ('Recipient identifier: E.164 phone number for WhatsApp (e.g. "+15551234567"), numeric chat ID for Telegram, channel/user ID for Discord'),
                        },
                        'text': {
                            'type': 'string',
                            'description': 'Message text to send',
                        },
                    },
                    'required': ['channel', 'to', 'text'],
                },
            },
        ],
    },
}


class IGlobal(IGlobalBase):
    """Global state for openclaw_client."""

    driver: OpenClawDriver | None = None
    _client: OpenClawClient | None = None
    _bridge_enabled: bool = False
    _bridge_instance: Any = None  # Set by IInstance.beginInstance()

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        server_name = str(cfg.get('serverName') or cfg.get('name') or 'openclaw').strip()
        gateway_url = str(cfg.get('gatewayUrl') or 'ws://127.0.0.1:18789').strip()
        http_url = str(cfg.get('httpUrl') or 'http://127.0.0.1:18789').strip()
        token = str(cfg.get('token') or '').strip()
        session_key = str(cfg.get('sessionKey') or 'agent:main:main').strip()

        enable_bridge = bool(cfg.get('enableMessageBridge'))
        channel_filter_raw = str(cfg.get('channelFilter') or '').strip()
        self._bridge_enabled = enable_bridge
        self._channel_filter = {c.strip().lower() for c in channel_filter_raw.split(',') if c.strip()} if channel_filter_raw else set()

        # Build set of enabled group IDs from config toggles
        enabled_groups = self._resolve_enabled_groups(cfg)

        # Parse deny list
        deny_raw = str(cfg.get('toolDenyList') or '').strip()
        deny_set = {t.strip() for t in deny_raw.split(',') if t.strip()} if deny_raw else set()

        try:
            on_message = self._on_inbound_message if enable_bridge else None
            self._client = OpenClawClient(
                ws_url=gateway_url,
                http_url=http_url,
                token=token,
                on_message=on_message,
            )
            self._client.start()

            # Discover tools; fall back to empty catalog if RPC fails (e.g. operator.read scope)
            try:
                catalog_groups = self._client.discover_tools()
                logger.info('Tool discovery succeeded: %d groups', len(catalog_groups))
            except Exception as disc_exc:
                logger.warning(
                    'tools.catalog RPC failed (%s); using hardcoded schemas only',
                    disc_exc,
                )
                catalog_groups = []

            # Inject hardcoded schemas (messaging etc.) — always replaces the gateway version
            catalog_groups = self._inject_hardcoded_groups(catalog_groups, enabled_groups)
            filtered_tools = self._filter_tools(catalog_groups, enabled_groups, deny_set)

            self.driver = OpenClawDriver(
                server_name=server_name,
                tools=filtered_tools,
                invoke_fn=self._client.invoke_tool,
                session_key=session_key,
            )

            logger.info(
                'OpenClaw client initialized: %d tools from %d groups',
                len(filtered_tools),
                len(catalog_groups),
            )

            # Subscribe to messages if bridge is enabled
            if enable_bridge:
                self._client.subscribe_messages(session_key)

        except Exception as e:
            warning(str(e))
            raise

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            gateway_url = str(cfg.get('gatewayUrl') or '').strip()
            http_url = str(cfg.get('httpUrl') or '').strip()
            token = str(cfg.get('token') or '').strip()

            if not gateway_url:
                warning('Gateway WebSocket URL is required')
                return
            if not http_url:
                warning('Gateway HTTP URL is required')
                return
            if not token:
                warning('API token is required')
                return
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        try:
            client = self._client
            if client is not None:
                client.stop()
        finally:
            self.driver = None
            self._client = None
            self._bridge_enabled = False
            self._bridge_instance = None

    # ------------------------------------------------------------------
    # Tool filtering
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_enabled_groups(cfg: Any) -> Dict[str, bool]:
        """Build a mapping of OpenClaw group ID -> enabled from config toggles."""
        enabled: Dict[str, bool] = {}
        skills_enabled = False

        for config_key, group_id in GROUP_MAP.items():
            val = cfg.get(config_key)
            is_on = bool(val) if val is not None else False

            if group_id is None:
                # groupSkills — catch-all flag
                skills_enabled = is_on
            else:
                enabled[group_id] = is_on

        # Store skills flag for filtering unknown groups
        enabled['__skills__'] = skills_enabled
        return enabled

    @staticmethod
    def _inject_hardcoded_groups(
        catalog_groups: List[Dict[str, Any]],
        enabled_groups: Dict[str, bool],
    ) -> List[Dict[str, Any]]:
        """Replace any gateway-discovered group with the hardcoded schema for that group,
        and inject hardcoded groups that are enabled but absent from the catalog.
        """
        merged = [g for g in catalog_groups if g.get('id') not in _HARDCODED_GROUPS]
        for group_id, group_def in _HARDCODED_GROUPS.items():
            if enabled_groups.get(group_id, False):
                merged.append(group_def)
        return merged

    @staticmethod
    def _filter_tools(
        catalog_groups: List[Dict[str, Any]],
        enabled_groups: Dict[str, bool],
        deny_set: set,
    ) -> List[Dict[str, Any]]:
        """Filter tool catalog based on enabled groups and deny list."""
        skills_enabled = enabled_groups.get('__skills__', False)
        filtered: List[Dict[str, Any]] = []
        gateway_denied_skipped: List[str] = []

        for group in catalog_groups:
            group_id = group.get('id', '')

            # Determine if this group is enabled
            if group_id in _KNOWN_GROUPS:
                if not enabled_groups.get(group_id, False):
                    continue
            else:
                # Unknown group (skill/plugin-provided) — governed by groupSkills
                if not skills_enabled:
                    continue

            tools = group.get('tools', [])
            if not isinstance(tools, list):
                continue

            for tool in tools:
                if not isinstance(tool, dict):
                    continue
                tool_name = tool.get('id') or tool.get('name') or ''
                if not tool_name:
                    continue
                if tool_name in deny_set:
                    continue
                # Warn about tools that are blocked by gateway HTTP deny list
                if tool_name in _GATEWAY_HTTP_DENIED:
                    gateway_denied_skipped.append(tool_name)
                    continue

                filtered.append(
                    {
                        'name': tool_name,
                        'description': tool.get('label') or tool.get('description') or '',
                        'inputSchema': tool.get('inputSchema') or {'type': 'object', 'additionalProperties': True},
                        'group': group_id,
                    }
                )

        if gateway_denied_skipped:
            logger.warning(
                'Skipped %d tools blocked by OpenClaw gateway HTTP deny list: %s. These require gateway config changes to enable via HTTP.',
                len(gateway_denied_skipped),
                ', '.join(sorted(gateway_denied_skipped)),
            )

        return filtered

    # ------------------------------------------------------------------
    # Message bridge callback
    # ------------------------------------------------------------------

    def _on_inbound_message(self, payload: Dict[str, Any]) -> None:
        """Handle a session.message event from the WebSocket reader thread."""
        if self._bridge_instance is None:
            return

        channel = str(payload.get('channel', '') or payload.get('channelId', '')).lower()
        if self._channel_filter and channel not in self._channel_filter:
            return

        content = payload.get('content', '')
        if not content:
            return

        sender = payload.get('from', '')
        try:
            from rocketlib import Question

            q = Question()
            q.addQuestion(str(content))
            self._bridge_instance.instance.writeQuestions(q)
            logger.debug('Bridge: forwarded message from %s/%s', channel, sender)
        except Exception:
            logger.warning('Bridge: failed to forward message', exc_info=True)
