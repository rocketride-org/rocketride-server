---
title: "Analytics / Telemetry Reporting"
date: 2026-07-15
---

- [Overview](#overview)
- [Import](#import)
- [API](#api)
- [Event Names](#event-names)
- [What This Module Is Not](#what-this-module-is-not)

## **Overview**

`rocketride.analytics` is the one shared event-report function, bare bones by
design. Apps call ``report(event, props)`` with any string event name and a
free-form props dict. There is no central event list: **each app owns its own
taxonomy**. What the shared layer guarantees is that every reported event
carries an ``app`` property identifying the emitting app (``home-ui``,
``rocket-ui``, …), so downstream analytics can always segment by app. The
TypeScript mirror lives at ``rocketride/analytics`` in the TypeScript SDK.

## **Import**

```python
from rocketride.analytics import init_report, report
```

## **API**

```python
# Once, at app init: wire the emitting app id + transport.
init_report('rocket-ui', lambda event, props: client.report(event, props))

# Anywhere after that:
report('pipeline:run', {'node_count': 4})
# → sink receives ('pipeline:run', {'app': 'rocket-ui', 'node_count': 4})
```

- ``init_report(app, sink)`` — stores the app id and transport. Call once per app.
- ``report(event, props=None)`` — forwards to the sink with ``app`` stamped into
  the props. Enforcement is string-ish only: a non-string or empty event name is
  a silent no-op, and nothing else is validated. Before ``init_report`` runs it
  is a safe no-op. It never raises — telemetry must never break the app.

## **Event Names**

By convention event names are ``object:action`` — lowercase, colon-separated
(``pipeline:run``, ``store:app_add``). The convention is documentation, not
enforcement: ``report()`` accepts any string so an app can evolve its taxonomy
without touching this module. Each app should keep its own documented event
list next to its call sites.

## **What This Module Is Not**

It is not a taxonomy and not a transport. There is no event-name ``Literal``
union, no typed property shapes, and no network I/O — the sink an app injects
does the sending. An earlier revision centralised a strict cross-app event
taxonomy here; that was removed in favour of per-app taxonomies and this loose
core.
