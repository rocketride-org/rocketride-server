// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// rocketride/analytics — event taxonomy
// =============================================================================
//
// Single source of truth for RocketRide's PostHog event taxonomy, shared
// between the product (client.report(name, props)) and the marketing site
// home-ui (posthog.capture(name, props)).
//
// Naming convention: `object:action`, lowercase, colon-separated.
// This module is ZERO runtime beyond the const objects below and has NO imports
// from the rest of the SDK — it is browser- and Node-safe and tree-shakeable.
// =============================================================================

// -----------------------------------------------------------------------------
// Shared prop primitives
// -----------------------------------------------------------------------------

/**
 * Where an event originated. Open union: known values autocomplete, but any
 * string is still accepted (the `& {}` trick preserves literal suggestions).
 */
export type EventSource =
	| 'canvas'
	| 'shell'
	| 'vscode'
	| 'store'
	| 'pricing'
	| 'hero'
	| 'panel'
	| 'suggestion'
	| 'nav'
	| 'nav_products'
	| 'home_bottom'
	| 'home_mid'
	| 'developers_hero'
	| 'businesses_hero'
	| 'businesses_bottom'
	| 'thinkers_bottom'
	| (string & {});

export type SubscribeSurface = 'pricing' | 'store';
export type StripeInterval = 'month' | 'year';
export type ChatErrorKind = 'server' | 'timeout' | 'socket';

/** Events that intentionally carry no properties. */
type NoProps = Record<string, never>;

// -----------------------------------------------------------------------------
// Event names (authoritative)
// -----------------------------------------------------------------------------

export const EVENTS = {
	// ---- Auth (shared) ------------------------------------------------------
	AUTH_LOGIN_START: 'auth:login_start',
	AUTH_REGISTER_START: 'auth:register_start',
	AUTH_LOGIN_SUCCESS: 'auth:login_success',

	// ---- Pipeline (product / canvas) ---------------------------------------
	PIPELINE_RUN: 'pipeline:run',
	PIPELINE_STOP: 'pipeline:stop',
	PIPELINE_SAVE: 'pipeline:save',

	// ---- Node editing (product / canvas) -----------------------------------
	NODE_ADD: 'node:add',
	NODE_CONNECT: 'node:connect',
	NODE_CONFIG_OPEN: 'node:config_open',

	// ---- Checkout / subscribe lifecycle (shared) ---------------------------
	// Funnel order:
	//   subscribe:intent -> checkout:start -> checkout:session_created
	//                    -> subscribe:success
	// plan:change is a separate flow (upgrade/downgrade of an active sub).
	SUBSCRIBE_INTENT: 'subscribe:intent',
	CHECKOUT_START: 'checkout:start',
	CHECKOUT_SESSION_CREATED: 'checkout:session_created',
	SUBSCRIBE_SUCCESS: 'subscribe:success',
	PLAN_CHANGE: 'plan:change',

	// ---- App navigation -----------------------------------------------------
	APP_SWITCH: 'app:switch', // product: switching between installed apps
	APP_LAUNCH: 'app:launch', // web: launching an app from the store

	// ---- VS Code extension lifecycle (vscode-only) -------------------------
	EXT_ACTIVATE: 'ext:activate',
	EXT_CANVAS_OPEN: 'ext:canvas_open',
	EXT_DEPLOY_OPEN: 'ext:deploy_open',

	// ---- Chat (web / marketing) --------------------------------------------
	CHAT_OPEN: 'chat:open',
	CHAT_MESSAGE_SENT: 'chat:message_sent',
	CHAT_SUGGESTION_CLICKED: 'chat:suggestion_clicked',
	CHAT_RESPONSE: 'chat:response',
	CHAT_EMPTY_RESPONSE: 'chat:empty_response',
	CHAT_ERROR: 'chat:error',
	CHAT_PANEL_CLOSED: 'chat:panel_closed',

	// ---- Site navigation (web / marketing) ---------------------------------
	NAV_CLICK: 'nav:click',
	FOOTER_LINK: 'footer:link',
	OUTBOUND_CLICK: 'outbound:click', // external link (docs, social, package registry)

	// ---- UI chrome / marketing interactions (web / marketing) --------------
	MENU_OPEN: 'menu:open', // nav dropdown / profile menu / overlay / mobile drawer opening
	MENU_SECTION: 'menu:section', // mobile nav accordion section toggling
	ANNOUNCEMENT_CYCLE: 'announcement:cycle', // announcement carousel prev/next
	MEDIA_PLAY: 'media:play', // marketing screencast / LoopVideo starting playback

	// ---- Generic action clicks (web / marketing) ---------------------------
	// cta:click carries a stable semantic cta_id so PostHog shows the ACTION, not
	// the button text. Use it for action clicks not covered by a domain event.
	CTA_CLICK: 'cta:click',
	WALKTHROUGH_STEP: 'walkthrough:step',
	LANDING_SCROLL: 'landing:scroll', // scroll-depth milestone (25/50/75/100)

	// ---- App store (web / marketing) ---------------------------------------
	STORE_APP_VIEW: 'store:app_view',
	STORE_CATEGORY: 'store:category',
	STORE_APP_ADD: 'store:app_add',

	// ---- Page views (web, manual capture) ----------------------------------
	PAGEVIEW: '$pageview',
} as const;

/** Union of every capturable event name. */
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

// -----------------------------------------------------------------------------
// Group identify (not a capture event)
// -----------------------------------------------------------------------------

// `registerApp` is a PostHog $groupidentify, not a captured event:
//   posthog.group(GROUPS.APP, appId, appProps)
// Kept out of EventName on purpose so report()'s type map stays event-only.
export const GROUPS = {
	APP: 'app',
} as const;

export type GroupType = (typeof GROUPS)[keyof typeof GROUPS];

export interface AppGroupProps {
	name?: string;
	version?: string;
	publisher?: string;
	[key: string]: string | number | boolean | undefined;
}

// -----------------------------------------------------------------------------
// Property shapes — one entry per event name
// -----------------------------------------------------------------------------

export interface EventProperties {
	// ---- Auth ---------------------------------------------------------------
	'auth:login_start': { source: EventSource; app_id?: string };
	'auth:register_start': { source: EventSource; app_id?: string };
	'auth:login_success': { source?: EventSource };

	// ---- Pipeline -----------------------------------------------------------
	'pipeline:run': {
		node_types: string[];
		node_count: number;
		edge_count: number;
		source: EventSource;
	};
	'pipeline:stop': { source?: EventSource };
	'pipeline:save': { source?: EventSource };

	// ---- Node ---------------------------------------------------------------
	'node:add': { node_type: string; source?: EventSource };
	'node:connect': { source_node_type?: string; target_node_type?: string };
	'node:config_open': { node_type: string };

	// ---- Checkout / subscribe ----------------------------------------------
	'subscribe:intent': {
		source: SubscribeSurface;
		plan?: string;
		stripe_price_id?: string;
		interval?: StripeInterval;
		app_id?: string;
	};
	'checkout:start': { source?: EventSource; plan?: string };
	'checkout:session_created': { session_id?: string; plan?: string };
	'subscribe:success': { plan?: string; stripe_price_id?: string };
	'plan:change': { from_price_id: string; to_price_id: string };

	// ---- App ----------------------------------------------------------------
	'app:switch': { to: string; from?: string };
	'app:launch': { app_id: string; status?: string; source?: EventSource };

	// ---- Extension ----------------------------------------------------------
	'ext:activate': { version?: string };
	'ext:canvas_open': NoProps;
	'ext:deploy_open': NoProps;

	// ---- Chat ---------------------------------------------------------------
	'chat:open': NoProps;
	'chat:message_sent': { len: number; is_follow_up: boolean; source?: EventSource };
	'chat:suggestion_clicked': { label: string };
	'chat:response': { latency_ms: number; answer_len: number; ok: boolean };
	'chat:empty_response': NoProps;
	'chat:error': { kind: ChatErrorKind };
	'chat:panel_closed': { reason?: 'manual' | 'scroll' | 'responsive' };

	// ---- Navigation ---------------------------------------------------------
	'nav:click': { target: string };
	'footer:link': { label: string };
	'outbound:click': { dest: string };

	// ---- UI chrome / marketing interactions --------------------------------
	'menu:open': { menu: string; surface: 'desktop' | 'mobile' };
	'menu:section': { section: string; state: 'open' | 'close'; surface: 'mobile' };
	'announcement:cycle': { dir: 'prev' | 'next' };
	'media:play': { id: string };

	// ---- Generic action clicks / walkthrough / store -----------------------
	'cta:click': { cta_id: string; cta_location: string };
	'walkthrough:step': { index: number; title?: string; trigger?: 'click' | 'auto' };
	'landing:scroll': { depth: number }; // milestone % reached: 25 | 50 | 75 | 100
	'store:app_view': { app_id: string; source?: EventSource };
	'store:category': { category: string };
	'store:app_add': { app_id: string };

	// ---- Page ---------------------------------------------------------------
	$pageview: { page: string };
}

/**
 * Tuple helper for wrapping report()/capture() with correct arg inference.
 * `properties` is optional when the event has NO required props — this covers
 * both NoProps events (e.g. chat:open) AND events whose props are all optional
 * (e.g. pipeline:stop, auth:login_success, checkout:start), which the older
 * `extends NoProps` check missed.
 */
export type EventArgs<E extends EventName> = {} extends EventProperties[E]
	? [event: E, properties?: EventProperties[E]]
	: [event: E, properties: EventProperties[E]];

// Compile-time completeness guard (type-only; fully erased at build). The forward
// direction — every EVENTS value has an EventProperties entry — is enforced by the
// EventProperties[E] indexed access in EventArgs. This closes the reverse gap: an
// orphaned EventProperties key (left behind after renaming an event in EVENTS)
// makes `keyof EventProperties` wider than `EventName`, so the conditional
// resolves to `false` and violates `Assert<T extends true>`, failing the build.
// Exported only so tsc counts it as used (noUnusedLocals); carries no runtime value.
type Assert<T extends true> = T;
export type AssertEventPropsComplete = Assert<[keyof EventProperties] extends [EventName] ? true : false>;

// Event → surface (web / vscode / shared) is documented inline in the section
// comments of EVENTS above; no runtime map is shipped.
