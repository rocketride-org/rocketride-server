# Copyright 2026 Aparavi Software AG. MIT License.
"""Cache-hint policy for 2026-07-28 CacheableResult fields.

Tools: static per build, but 'private' because listings become
entitlement-filtered when node-auth lands. Status: live state, uncacheable.
Pipelines resource: reflects running tasks.
"""

TOOLS_TTL_MS = 3_600_000
RESOURCES_LIST_TTL_MS = 30_000
STATUS_READ_TTL_MS = 0
PIPELINES_READ_TTL_MS = 30_000
UI_READ_TTL_MS = 3_600_000
CACHE_SCOPE = 'private'
