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

``rocketride.analytics`` mints bound per-app event reporters, bare bones by
design. A host creates one reporter per app with ``create_reporter(app, sink)``
and hands it over; the app calls ``report(event, props, options)`` with any
string event name and a free-form props dict. There is no central event list:
**each app owns its own taxonomy**. What the shared layer guarantees is that
every reported event carries an ``app`` property identifying the emitting app,
**fixed at creation** — there is no module-global "current app" state, so a
late event from a backgrounded app still names its true emitter. The
TypeScript mirror lives at ``rocketride/analytics`` in the TypeScript SDK.

## **Import**

```python
from rocketride.analytics import create_reporter
```

## **API**

```python
# The HOST mints one reporter per app. The sink is whatever callable ships
# events (HTTP, queue, logger, ...).
report = create_reporter('rocket-ui', lambda event, props, options: my_sink.send(event, props))

# The app just calls it:
report('pipeline:run', {'node_count': 4})
# → sink receives ('pipeline:run', {'app': 'rocket-ui', 'node_count': 4}, None)
```

- ``create_reporter(app, sink)`` — returns the app's bound ``report``. The
  ``app`` stamp is closed over for the reporter's lifetime and is stamped
  last, so caller props can never overwrite it.
- ``report(event, props=None, options=None)`` — forwards to the sink with
  ``app`` stamped into the props. ``options`` is a free-form delivery-hint
  dict mirroring the TypeScript ``SendOptions`` (``transport``, ``timestamp``,
  ``uuid``); sinks that don't understand it ignore it. Enforcement is
  string-ish only: a non-string or empty event name is a silent no-op, and
  nothing else is validated. It never raises — telemetry must never break the
  app.

## **Event Names**

By convention event names are ``object:action`` — lowercase, colon-separated
(``pipeline:run``, ``store:app_add``). The convention is documentation, not
enforcement: ``report()`` accepts any string so an app can evolve its taxonomy
without touching this module. Each app should keep its own documented event
list next to its call sites.

## **What This Module Is Not**

It is not a taxonomy and not a transport. There is no event-name ``Literal``
union, no typed property shapes, and no network I/O — the sink a host injects
does the sending. Earlier revisions centralised a strict cross-app taxonomy
and, later, a module-global ``init_report(app, sink)``; both were removed —
the taxonomy in favour of per-app ownership, the global in favour of bound
reporters whose ``app`` stamp cannot be re-pointed by whichever app
initialised last.
