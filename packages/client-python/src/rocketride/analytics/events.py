# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
rocketride.analytics — event taxonomy (Python mirror of ``rocketride/analytics``).

Single source of truth for RocketRide's PostHog event taxonomy, kept in parity
with the TypeScript client (``client-typescript/src/client/analytics/events.ts``).
Naming convention: ``object:action``, lowercase, colon-separated.

This module is definitions only — constants plus typing shapes. It has no
side effects and imports nothing beyond the standard library.
"""

from __future__ import annotations

from typing import Literal, TypedDict

# -----------------------------------------------------------------------------
# Shared prop primitives
# -----------------------------------------------------------------------------

# Where an event originated. Open union in TS via ``(string & {})`` — kept
# permissive here as ``str``; the known values are enumerated for reference.
EventSource = str

KNOWN_EVENT_SOURCES: tuple[str, ...] = (
    'canvas',
    'shell',
    'vscode',
    'store',
    'pricing',
    'hero',
    'panel',
    'suggestion',
    'nav',
    'nav_products',
    'home_bottom',
    'home_mid',
    'developers_hero',
    'businesses_hero',
    'businesses_bottom',
    'thinkers_bottom',
)

SubscribeSurface = Literal['pricing', 'store']
StripeInterval = Literal['month', 'year']
ChatErrorKind = Literal['server', 'timeout', 'socket']


# -----------------------------------------------------------------------------
# Event names (authoritative)
# -----------------------------------------------------------------------------


class EVENTS:
    """Authoritative event-name constants (mirror of the TS ``EVENTS`` const)."""

    # Auth (shared)
    AUTH_LOGIN_START = 'auth:login_start'
    AUTH_REGISTER_START = 'auth:register_start'
    AUTH_LOGIN_SUCCESS = 'auth:login_success'

    # Pipeline (product / canvas)
    PIPELINE_RUN = 'pipeline:run'
    PIPELINE_STOP = 'pipeline:stop'
    PIPELINE_SAVE = 'pipeline:save'

    # Node editing (product / canvas)
    NODE_ADD = 'node:add'
    NODE_CONNECT = 'node:connect'
    NODE_CONFIG_OPEN = 'node:config_open'

    # Checkout / subscribe lifecycle (shared)
    SUBSCRIBE_INTENT = 'subscribe:intent'
    CHECKOUT_START = 'checkout:start'
    CHECKOUT_SESSION_CREATED = 'checkout:session_created'
    SUBSCRIBE_SUCCESS = 'subscribe:success'
    PLAN_CHANGE = 'plan:change'

    # App navigation
    APP_SWITCH = 'app:switch'
    APP_LAUNCH = 'app:launch'

    # VS Code extension lifecycle (vscode-only)
    EXT_ACTIVATE = 'ext:activate'
    EXT_CANVAS_OPEN = 'ext:canvas_open'
    EXT_DEPLOY_OPEN = 'ext:deploy_open'

    # Chat (web / marketing)
    CHAT_OPEN = 'chat:open'
    CHAT_MESSAGE_SENT = 'chat:message_sent'
    CHAT_SUGGESTION_CLICKED = 'chat:suggestion_clicked'
    CHAT_RESPONSE = 'chat:response'
    CHAT_EMPTY_RESPONSE = 'chat:empty_response'
    CHAT_ERROR = 'chat:error'
    CHAT_PANEL_CLOSED = 'chat:panel_closed'

    # Site navigation (web / marketing)
    NAV_CLICK = 'nav:click'
    FOOTER_LINK = 'footer:link'
    OUTBOUND_CLICK = 'outbound:click'

    # UI chrome / marketing interactions (web / marketing)
    MENU_OPEN = 'menu:open'
    MENU_SECTION = 'menu:section'
    ANNOUNCEMENT_CYCLE = 'announcement:cycle'
    MEDIA_PLAY = 'media:play'

    # Generic action clicks / walkthrough / scroll
    CTA_CLICK = 'cta:click'
    WALKTHROUGH_STEP = 'walkthrough:step'
    LANDING_SCROLL = 'landing:scroll'

    # App store (web / marketing)
    STORE_APP_VIEW = 'store:app_view'
    STORE_CATEGORY = 'store:category'
    STORE_APP_ADD = 'store:app_add'

    # Page views (web, manual capture)
    PAGEVIEW = '$pageview'


# Union of every capturable event name (mirror of the TS ``EventName``).
EventName = Literal[
    'auth:login_start',
    'auth:register_start',
    'auth:login_success',
    'pipeline:run',
    'pipeline:stop',
    'pipeline:save',
    'node:add',
    'node:connect',
    'node:config_open',
    'subscribe:intent',
    'checkout:start',
    'checkout:session_created',
    'subscribe:success',
    'plan:change',
    'app:switch',
    'app:launch',
    'ext:activate',
    'ext:canvas_open',
    'ext:deploy_open',
    'chat:open',
    'chat:message_sent',
    'chat:suggestion_clicked',
    'chat:response',
    'chat:empty_response',
    'chat:error',
    'chat:panel_closed',
    'nav:click',
    'footer:link',
    'outbound:click',
    'menu:open',
    'menu:section',
    'announcement:cycle',
    'media:play',
    'cta:click',
    'walkthrough:step',
    'landing:scroll',
    'store:app_view',
    'store:category',
    'store:app_add',
    '$pageview',
]


# -----------------------------------------------------------------------------
# Property shapes — one TypedDict per event (mirror of TS ``EventProperties``).
# Required + optional keys are split via a base TypedDict plus a ``total=False``
# subclass, since Python 3.10's ``typing`` has no ``Required``/``NotRequired``.
# Events with no properties are represented by an empty TypedDict.
# -----------------------------------------------------------------------------


class NoProps(TypedDict):
    """An event that intentionally carries no properties."""


# ---- Auth -------------------------------------------------------------------
class _AuthLoginStartReq(TypedDict):
    source: EventSource


class AuthLoginStartProps(_AuthLoginStartReq, total=False):
    app_id: str


class _AuthRegisterStartReq(TypedDict):
    source: EventSource


class AuthRegisterStartProps(_AuthRegisterStartReq, total=False):
    app_id: str


class AuthLoginSuccessProps(TypedDict, total=False):
    source: EventSource


# ---- Pipeline ---------------------------------------------------------------
class PipelineRunProps(TypedDict):
    node_types: list[str]
    node_count: int
    edge_count: int
    source: EventSource


class PipelineStopProps(TypedDict, total=False):
    source: EventSource


class PipelineSaveProps(TypedDict, total=False):
    source: EventSource


# ---- Node -------------------------------------------------------------------
class _NodeAddReq(TypedDict):
    node_type: str


class NodeAddProps(_NodeAddReq, total=False):
    source: EventSource


class NodeConnectProps(TypedDict, total=False):
    source_node_type: str
    target_node_type: str


class NodeConfigOpenProps(TypedDict):
    node_type: str


# ---- Checkout / subscribe ---------------------------------------------------
class _SubscribeIntentReq(TypedDict):
    source: SubscribeSurface


class SubscribeIntentProps(_SubscribeIntentReq, total=False):
    plan: str
    stripe_price_id: str
    interval: StripeInterval
    app_id: str


class CheckoutStartProps(TypedDict, total=False):
    source: EventSource
    plan: str


class CheckoutSessionCreatedProps(TypedDict, total=False):
    session_id: str
    plan: str


class SubscribeSuccessProps(TypedDict, total=False):
    plan: str
    stripe_price_id: str


class PlanChangeProps(TypedDict):
    from_price_id: str
    to_price_id: str


# ---- App --------------------------------------------------------------------
# NOTE: ``from`` is a Python keyword, so this event uses the functional TypedDict
# form. ``to`` is semantically required (both are marked optional here because the
# functional form cannot mix required/optional with a reserved-word key).
AppSwitchProps = TypedDict('AppSwitchProps', {'to': str, 'from': str}, total=False)


class _AppLaunchReq(TypedDict):
    app_id: str


class AppLaunchProps(_AppLaunchReq, total=False):
    status: str
    source: EventSource


# ---- Extension --------------------------------------------------------------
class ExtActivateProps(TypedDict, total=False):
    version: str


# ---- Chat -------------------------------------------------------------------
class _ChatMessageSentReq(TypedDict):
    len: int
    is_follow_up: bool


class ChatMessageSentProps(_ChatMessageSentReq, total=False):
    source: EventSource


class ChatSuggestionClickedProps(TypedDict):
    label: str


class ChatResponseProps(TypedDict):
    latency_ms: int
    answer_len: int
    ok: bool


class ChatErrorProps(TypedDict):
    kind: ChatErrorKind


class ChatPanelClosedProps(TypedDict, total=False):
    reason: Literal['manual', 'scroll', 'responsive']


# ---- Navigation -------------------------------------------------------------
class NavClickProps(TypedDict):
    target: str


class FooterLinkProps(TypedDict):
    label: str


class OutboundClickProps(TypedDict):
    dest: str


# ---- UI chrome / marketing interactions -------------------------------------
class MenuOpenProps(TypedDict):
    menu: str
    surface: Literal['desktop', 'mobile']


class MenuSectionProps(TypedDict):
    section: str
    state: Literal['open', 'close']
    surface: Literal['mobile']


class AnnouncementCycleProps(TypedDict):
    dir: Literal['prev', 'next']


class MediaPlayProps(TypedDict):
    id: str


# ---- Generic action clicks / walkthrough / store ----------------------------
class CtaClickProps(TypedDict):
    cta_id: str
    cta_location: str


class _WalkthroughStepReq(TypedDict):
    index: int


class WalkthroughStepProps(_WalkthroughStepReq, total=False):
    title: str
    trigger: Literal['click', 'auto']


class LandingScrollProps(TypedDict):
    depth: int  # milestone % reached: 25 | 50 | 75 | 100


class _StoreAppViewReq(TypedDict):
    app_id: str


class StoreAppViewProps(_StoreAppViewReq, total=False):
    source: EventSource


class StoreCategoryProps(TypedDict):
    category: str


class StoreAppAddProps(TypedDict):
    app_id: str


# ---- Page -------------------------------------------------------------------
class PageviewProps(TypedDict):
    page: str


# Runtime registry: event name -> its property TypedDict (Python-faithful
# equivalent of the TS ``EventProperties`` map). Every ``EventName`` has an entry.
EVENT_PROPS: dict[str, type] = {
    'auth:login_start': AuthLoginStartProps,
    'auth:register_start': AuthRegisterStartProps,
    'auth:login_success': AuthLoginSuccessProps,
    'pipeline:run': PipelineRunProps,
    'pipeline:stop': PipelineStopProps,
    'pipeline:save': PipelineSaveProps,
    'node:add': NodeAddProps,
    'node:connect': NodeConnectProps,
    'node:config_open': NodeConfigOpenProps,
    'subscribe:intent': SubscribeIntentProps,
    'checkout:start': CheckoutStartProps,
    'checkout:session_created': CheckoutSessionCreatedProps,
    'subscribe:success': SubscribeSuccessProps,
    'plan:change': PlanChangeProps,
    'app:switch': AppSwitchProps,
    'app:launch': AppLaunchProps,
    'ext:activate': ExtActivateProps,
    'ext:canvas_open': NoProps,
    'ext:deploy_open': NoProps,
    'chat:open': NoProps,
    'chat:message_sent': ChatMessageSentProps,
    'chat:suggestion_clicked': ChatSuggestionClickedProps,
    'chat:response': ChatResponseProps,
    'chat:empty_response': NoProps,
    'chat:error': ChatErrorProps,
    'chat:panel_closed': ChatPanelClosedProps,
    'nav:click': NavClickProps,
    'footer:link': FooterLinkProps,
    'outbound:click': OutboundClickProps,
    'menu:open': MenuOpenProps,
    'menu:section': MenuSectionProps,
    'announcement:cycle': AnnouncementCycleProps,
    'media:play': MediaPlayProps,
    'cta:click': CtaClickProps,
    'walkthrough:step': WalkthroughStepProps,
    'landing:scroll': LandingScrollProps,
    'store:app_view': StoreAppViewProps,
    'store:category': StoreCategoryProps,
    'store:app_add': StoreAppAddProps,
    '$pageview': PageviewProps,
}
