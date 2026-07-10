---
title: "Analytics / Telemetry Taxonomy"
date: 2026-07-11
---

- [Overview](#overview)
- [Import](#import)
- [Event Names](#event-names)
- [Typed Event Properties](#typed-event-properties)
- [Property Enums](#property-enums)
- [What This Module Is Not](#what-this-module-is-not)

## **Overview**

`rocketride/analytics` defines the canonical **names** of RocketRide product
analytics events and the **typed property shape** of each one. It is a taxonomy:
constants and typing shapes, no runtime behaviour, no side effects, no network.

Its purpose is to give the TypeScript SDK, the Python SDK, and the web surfaces
one agreed spelling and shape for every event, so that a funnel assembled from
events emitted by different clients lines up. The Python mirror lives at
`rocketride.analytics` in the Python SDK.

## **Import**

```typescript
import { EVENTS, type EventName } from 'rocketride/analytics';

EVENTS.AUTH_LOGIN_START; // 'auth:login_start'
EVENTS.PIPELINE_RUN;     // 'pipeline:run'
```

## **Event Names**

Event names follow the convention `object:action` — lowercase, colon-separated.
The single exception is `$pageview`, whose name is fixed by PostHog.

The taxonomy spans eleven domains: authentication, pipeline lifecycle, node
editing, the checkout and subscribe funnel, app navigation, extension lifecycle,
chat, site navigation, UI chrome, calls to action, and the app store.

The authoritative list is the `EVENTS` const in
`src/client/analytics/events.ts`. It is deliberately not reproduced here — a
hand-copied table in prose is a table that drifts.

## **Typed Event Properties**

Unlike a bare name list, the TypeScript taxonomy also carries the property shape
of each event through `EventProperties`, plus an `EventArgs<E>` tuple helper so a
capture wrapper is property-checked at every call site:

```typescript
import { type EventName, type EventArgs } from 'rocketride/analytics';

function report<E extends EventName>(...[event, properties]: EventArgs<E>): void {
	// `properties` is required when the event has required props, optional otherwise
}

report('nav:click', { target: 'pricing' }); // ok
report('nav:click');                         // type error — `target` is required
report('chat:open');                         // ok — this event has no properties
```

A compile-time guard (`AssertEventPropsComplete`) fails the build if `EVENTS` and
`EventProperties` ever fall out of sync, so every event name has exactly one
property shape and no shape is orphaned.

## **Property Enums**

Three closed unions constrain property values across the taxonomy:

| Enum | Values |
| --- | --- |
| `SubscribeSurface` | `pricing`, `store` |
| `StripeInterval` | `month`, `year` |
| `ChatErrorKind` | `server`, `timeout`, `socket` |

`EventSource` is deliberately an open union (`... | (string & {})`) rather than a
closed one, so a new surface can emit events before the taxonomy is updated while
still offering autocomplete for the known values.

## **What This Module Is Not**

It does not send anything. There is no client, no transport, no PostHog
dependency, and no `capture()` call in this module.

An earlier revision also shipped anonymous-id generation, an opt-out predicate,
and a standard-properties builder. Those were removed: no code emitted events, so
the capture-time machinery guarded conditions that could not yet occur. They will
return alongside the first consumer that actually reports telemetry, when their
contracts can be validated against real call sites rather than against tests.
