---
title: Date & Time
date: 2026-09-03
sidebar_position: 1
---

<head>
  <title>Date & Time - RocketRide Documentation</title>
</head>

## What it does

Gives an agent a clock and a calendar it can trust.

A model has no clock, and telling it today's date does not fix arithmetic. It can
know today is Thursday and still book a follow-up on the wrong Tuesday, or add a
month to 31 January and produce a date that does not exist. Those errors are
written straight through to whatever the agent is filling in — most CRM date
fields are plain strings with no validation — so a wrong date is stored rather
than rejected.

This node does the counting somewhere that counts correctly.

It is a tool node only: it has no lanes and does not appear in the data flow.
Bind it to an agent and it appears in that agent's tool list.

## Unix timestamps are the wire format

Every instant in and out is an integer unix timestamp in seconds. A timestamp
carries no timezone to be wrong about, so nothing is lost passing one between the
model, this tool, and whatever the agent writes to.

Dates, weekdays and "the start of the month" are a **rendering** of an instant,
and the optional `timezone` argument is what resolves them. Pass the caller's own
zone whenever it is known — it decides what date an instant falls on. Every
answer names the zone it actually used, so a reply reading `"timezone": "UTC"`
tells you no zone was supplied.

## The descriptions carry the current time

Each tool's description states the current date, time, weekday and timestamp, and
is re-evaluated every time an agent reads its tool list. So an agent learns what
"now" is from the tool itself, without anything else having injected it — which
matters most when the agent doing the work is a sub-agent several delegations
deep, where an injected anchor tends not to reach.

## Agent tools

Tools are exposed under the `datetime` namespace.

| Tool | Description |
| --- | --- |
| `datetime.now` | The current instant. Call before resolving "today", "tomorrow", "next week" |
| `datetime.at` | A date and a time of day, in a named zone, as an instant — "Wednesday at 12:30" |
| `datetime.shift` | Add or subtract time — "in 90 days", "a month before the close date" |
| `datetime.next_weekday` | The next occurrence of a named weekday — "next Tuesday" |
| `datetime.boundary` | The first or last instant of a day, week, month, quarter or year |
| `datetime.difference` | How far apart two instants are |
| `datetime.render` | A timestamp as a date and time in a given zone |

Every instant-returning tool answers with `epoch`, `iso`, `date` (`YYYY-MM-DD`),
`time` (`HH:MM`), `weekday`, `timezone` — and `utc_iso`, `utc_date`, `utc_time`,
the same instant written in UTC. Write one of those pairs into a record verbatim
rather than formatting or converting an instant by hand.

## Which pair to write is a fact about the field

An instant has no single date and time — it has one per zone. Which one a CRM
field wants belongs to that field, and the CRMs disagree: Pipedrive reads an
activity's `due_time` as UTC and displays it in each viewer's own zone, while
GoHighLevel wants an appointment's `startTime` as a local string carrying its own
offset.

A meeting asked for at 12:30 in California and written to Pipedrive as `12:30` is
stored as 12:30 UTC and shown back to the person who asked for it as 05:30. It is
not rejected; a wrong hour looks exactly like a right one.

Both renderings travel on every answer so that writing the right one is reading a
different key, never subtracting an offset. Read the field's own description — a
well-written CRM node names the zone there — and take **both** halves from the
same rendering: converting an hour past midnight moves the date with it.

## Decisions worth knowing

These are choices, not laws. They are stated here because the alternative is
discovering them from a wrong booking.

**Durations and calendar steps are different.** `second`, `minute` and `hour` move
the instant. `day`, `week`, `month` and `year` move the calendar and keep the time
of day. Across a daylight-saving change those disagree by an hour, and the
calendar answer is the one a person means: "same time tomorrow" is 09:00
tomorrow, not 08:00 because the clocks moved.

**Month arithmetic clamps.** 31 January plus one month is the last day of
February — the 28th, or the 29th in a leap year.

**"Next Tuesday" on a Tuesday means the one coming.** `next_weekday` is strictly
in the future by default; booking today would be a surprise nobody asked for.
Pass `allow_today` when today should count.

**`end` is the last second of a period**, so end-of-month reads as the 30th or
31st rather than the 1st of the next month.

**`difference` answers twice.** `elapsed` is the real duration; `calendar_days` is
how many dates apart the two instants are on a wall calendar. At 23:00 on
Thursday, midnight is one hour away *and* the next date — answering only one of
those is how "how many days until" comes back as zero.

**An unusable timezone answers in UTC rather than failing.** A mistyped zone
should cost a UTC answer the caller can see and correct, not a failed turn.

**A wall-clock time is not always an instant, and `at` says which.** On the
morning clocks go forward, 02:30 never happens: the answer resolves to the next
real instant and sets `adjusted`. On the morning they go back, 01:30 happens
twice: the earlier is taken and `ambiguous` is set. Neither raises — a meeting
that has to be booked is better booked at a stated wrong-by-an-hour time than not
booked at all — and both flags travel with the answer, so say so when either is
true.

**A malformed date IS refused.** Unlike a bad zone, there is no honest fallback:
every instant `"9 sept"` could mean is a guess.

## Configuration

**Default timezone** is a deployment-wide fallback used only when a caller names
no zone of its own. It cannot know where the person asking actually is, which is
why every answer names the zone it used. Leave it empty for UTC.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
