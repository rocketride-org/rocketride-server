---
title: "Analytics / Telemetry Taxonomy"
date: 2026-07-09
---

- [Overview](#overview)
- [Import](#import)
- [Event Names](#event-names)
- [Property Enums](#property-enums)
- [What This Module Is Not](#what-this-module-is-not)

## **Overview**

`rocketride.analytics` defines the canonical **names** of RocketRide product
analytics events, plus the enums their properties draw from. It is a taxonomy:
constants and typing shapes, no runtime behaviour, no side effects, no network.

Its purpose is to give the Python SDK, the TypeScript SDK, and the web surfaces
one agreed spelling for every event, so that a funnel assembled from events
emitted by different clients lines up.

## **Import**

```python
from rocketride.analytics import EVENTS, EventName

EVENTS.AUTH_LOGIN_START   # 'auth:login_start'
EVENTS.PIPELINE_RUN       # 'pipeline:run'
```

`EventName` is a `Literal` union of every event name, suitable for annotating a
capture function once one exists:

```python
def capture(event: EventName, props: dict[str, object]) -> None: ...
```

## **Event Names**

Event names follow the convention `object:action` — lowercase, colon-separated.
The single exception is `$pageview`, whose name is fixed by PostHog.

The taxonomy spans eleven domains: authentication, pipeline lifecycle, node
editing, the checkout and subscribe funnel, app navigation, extension lifecycle,
chat, site navigation, UI chrome, calls to action, and the app store.

The authoritative list is the `EVENTS` class in
`src/rocketride/analytics/events.py`. It is deliberately not reproduced here — a
hand-copied table in prose is a table that drifts.

## **Property Enums**

Three closed unions constrain property values across the taxonomy:

| Enum | Values |
| --- | --- |
| `SubscribeSurface` | `pricing`, `store` |
| `StripeInterval` | `month`, `year` |
| `ChatErrorKind` | `server`, `timeout`, `socket` |

`EventSource` is deliberately an open `str` rather than a closed union, so a new
surface can emit events before the taxonomy is updated. The known values are
enumerated in `KNOWN_EVENT_SOURCES` for reference.

## **What This Module Is Not**

It does not send anything. There is no client, no transport, no PostHog
dependency, and no `capture()` call anywhere in the SDK.

An earlier revision also shipped anonymous-id generation, an opt-out predicate,
and a standard-properties builder. Those were removed: no code emitted events, so
the capture-time machinery guarded conditions that could not yet occur. They will
return alongside the first consumer that actually reports telemetry, when their
contracts can be validated against real call sites rather than against tests.
