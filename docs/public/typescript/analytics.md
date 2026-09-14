---
title: Analytics
sidebar_position: 12
---

- [Overview](#overview)
- [Import](#import)
- [API](#api)
- [Event Names](#event-names)
- [What This Module Is Not](#what-this-module-is-not)

## **Overview**

`rocketride/analytics` is the one shared event-report function, bare bones by
design. Apps call `report(event, props)` with any string event name and a
free-form props bag. There is no central event list: **each app owns its own
taxonomy** (home-ui keeps its event names in the home-ui repo, the VS Code
extension keeps its own, and so on). What the shared layer guarantees is that
every reported event carries an `app` property identifying the emitting app
(`home-ui`, `rocket-ui`, …), so downstream analytics can always segment by app.
The Python mirror lives at `rocketride.analytics` in the Python SDK.

## **Import**

```typescript
import { initReport, report, type ReportSink } from 'rocketride/analytics';
```

## **API**

```typescript
// Once, at app init: wire the emitting app id + transport.
initReport('home-ui', (event, props) => posthog.capture(event, props));
// or, on the product side:
// Once, at app init: wire the emitting app id + transport. The sink is
// whatever function your app uses to ship events (HTTP, queue, logger, ...).
initReport('rocket-ui', (event, props) => mySink.send(event, props));

// Anywhere after that:
report('nav:click', { target: 'pricing' });
// → sink receives ('nav:click', { app: 'home-ui', target: 'pricing' })
```

- `initReport(app, sink)` — stores the app id and transport. Call once per app.
- `report(event, props?)` — forwards to the sink with `app` stamped into the
  props. Enforcement is string-ish only: a non-string or empty event name is a
  silent no-op, and nothing else is validated. Before `initReport` runs (and in
  builds where telemetry is unconfigured) it is a safe no-op. It never throws —
  telemetry must never break the app.

## **Event Names**

By convention event names are `object:action` — lowercase, colon-separated
(`chat:message_sent`, `store:app_add`). The convention is documentation, not
enforcement: `report()` accepts any string so an app can evolve its taxonomy
without touching this module. Each app should keep its own documented event
list next to its call sites.

## **What This Module Is Not**

It is not a taxonomy and not a transport. There is no event-name union, no
typed property shapes, no PostHog dependency, and no network I/O — the sink an
app injects does the sending. An earlier revision centralised a strict,
compile-time-checked cross-app event taxonomy here; that was removed in favour
of per-app taxonomies and this loose core.
