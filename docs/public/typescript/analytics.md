---
title: Analytics
sidebar_position: 12
---

- [Overview](#overview)
- [Import](#import)
- [API](#api)
- [Capture Options](#capture-options)
- [Event Names](#event-names)
- [What This Module Is Not](#what-this-module-is-not)

## **Overview**

`rocketride/analytics` mints bound per-app event reporters, bare bones by
design. A host (the platform shell) creates one reporter per app with
`createReporter(app, sink)` and hands it over; the app calls
`report(event, props, options?)` with any string event name and a free-form
props bag. There is no central event list: **each app owns its own taxonomy**
(home-ui keeps its event names in its own repo, the VS Code extension keeps
its own, and so on). What the shared layer guarantees is that every reported
event carries an `app` property identifying the emitting app, **fixed at
creation** — there is no module-global "current app" state, so a late event
from a backgrounded app still names its true emitter. The Python mirror lives
at `rocketride.analytics` in the Python SDK.

Apps running on the platform shell do not call `createReporter` themselves —
the shell mints their reporter and hands it over (`useReport()` /
`getReporter(appId)` from the shell API). Creating reporters directly is for
hosts and for standalone code with its own transport.

## **Import**

```typescript
import { createReporter, type Reporter, type ReportSink, type SendOptions } from 'rocketride/analytics';
```

## **API**

```typescript
// The HOST mints one reporter per app. The sink is whatever function ships
// events (the shell's capture queue, HTTP, a logger, ...).
const report = createReporter('rocket-ui', (event, props, options) => mySink.send(event, props, options));

// The app just calls it:
report('nav:click', { target: 'pricing' });
// → sink receives ('nav:click', { app: 'rocket-ui', target: 'pricing' }, undefined)
```

- `createReporter(app, sink)` — returns the app's bound `report`. The `app`
  stamp is closed over for the reporter's lifetime and is stamped last, so
  caller props can never overwrite it.
- `report(event, props?, options?)` — forwards to the sink with `app` stamped
  into the props. Enforcement is string-ish only: a non-string or empty event
  name is a silent no-op, and nothing else is validated. It never throws —
  telemetry must never break the app.

## **Capture Options**

The optional third argument passes delivery hints to sinks that understand
them (sinks that don't simply ignore the argument):

```typescript
type SendOptions = { transport?: 'sendBeacon'; timestamp?: Date; uuid?: string };
```

- `transport: 'sendBeacon'` — the page may be torn down a moment later (a CTA
  that starts an OAuth redirect): ask for teardown-surviving delivery.
- `timestamp` — back-date a replayed event to when it was observed.
- `uuid` — make the capture idempotent, so an at-least-once replay dedupes
  instead of double-counting.

## **Event Names**

By convention event names are `object:action` — lowercase, colon-separated
(`chat:message_sent`, `store:app_add`). The convention is documentation, not
enforcement: `report()` accepts any string so an app can evolve its taxonomy
without touching this module. Each app should keep its own documented event
list next to its call sites.

## **What This Module Is Not**

It is not a taxonomy and not a transport. There is no event-name union, no
typed property shapes, no PostHog dependency, and no network I/O — the sink a
host injects does the sending. Earlier revisions centralised a strict
cross-app taxonomy and, later, a module-global `initReport(app, sink)`; both
were removed — the taxonomy in favour of per-app ownership, the global in
favour of bound reporters whose `app` stamp cannot be re-pointed by whichever
app initialised last.
