# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

# =============================================================================
# DEPLOY COMMON — the ground the deploy rails share
#
# Publishing an app and publishing a node ask the same four questions: who is
# the caller, which org does this write land in, which audience does this
# target name, and is this zip safe to open. app_deploy answered them first,
# so the answers live there.
#
# This module is the ONE place that reaches into them. The coupling is real
# either way; keeping it in a single import means a rename breaks one line
# with a clear message, instead of six scattered call sites.
#
# Lifting the implementations here outright is the right end state and is a
# separate piece of work: it moves ~180 lines out of a file that shipped days
# ago, and the file's author should have the say on when that churn is worth
# it. Nothing else has to change when it happens — callers already use the
# public names they will keep.
# =============================================================================

"""Identity, audience and archive helpers shared by the deploy rails."""

from __future__ import annotations

from ai.account.app_deploy import _actor_of as actor_of
from ai.account.app_deploy import _developer_id_of as developer_id_of
from ai.account.app_deploy import _org_of as org_of
from ai.account.app_deploy import _resolve_target as resolve_target
from ai.account.app_deploy import _zip_guard as zip_guard
from ai.account.app_deploy import _ZIP_MAX_ZIPPED as ZIP_MAX_ZIPPED

__all__ = [
    'ZIP_MAX_ZIPPED',
    'actor_of',
    'developer_id_of',
    'org_of',
    'resolve_target',
    'zip_guard',
]
