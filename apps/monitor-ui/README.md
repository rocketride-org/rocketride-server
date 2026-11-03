# Server Monitor

Watch the server you are connected to: who is connected, what tasks are
running, and what just happened. The dashboard refreshes itself every three
seconds and the activity feed updates live as the server emits events, so
the numbers on screen are never more than a poll behind. Everything here is
read-only — the monitor shows you the server; it never changes it.

Server Monitor runs in the RocketRide shell and as a panel inside the
RocketRide VS Code extension. It is the same app either way.

## Before you start

- **An authenticated connection.** The app monitors the server your shell is
  connected to; there is no server picker inside it.
- **Permission to read the dashboard.** The dashboard endpoint is
  access-scoped. If your account is not entitled to it, the app says `You do
  not have permission to view the dashboard.` and shows nothing rather than
  stale numbers.

## The four pages

The sidebar menu switches between four pages. The Connections, Tasks and
Activity entries carry live count badges.

### Overview

Server health at a glance:

- **The stat strip** — total connections, active tasks, server uptime (with
  the start time it implies), and total completions summed across running
  tasks.
- **The live ticker** — the four most recent events in one line: tasks
  starting, completing or restarting, clients connecting or disconnecting.
- **The unified grid** — active connections and tasks in one table:
  every connection, every running task, and the five most recently completed
  tasks. Clicking a row opens its record panel (the same panels the
  Connections and Tasks pages use).
- **Recent Activity** — the five newest events with time, category and
  message.
- **Resources** — CPU percent, CPU memory and GPU memory summed across
  running tasks, plus the completion total. Completed tasks are excluded;
  their last-reported metrics are stale.

### Connections

Every client attached to the server, as a full grid: client name and
version, connection id, messages in and out, and connection time. Paging,
sorting, filtering and search all run server-side, and the current page
silently re-requests every three seconds, so the grid stays live without
resetting your position. Clicking a row opens a slide-out record panel with
the connection's details; the open panel re-reads its record on every
refresh, so it updates in place.

### Tasks

Running and recent pipeline tasks: name, source component, status, elapsed
time, CPU and memory (running tasks only), completions, idle time, TTL and
— for completed tasks — the exit code. The grid works the same way as
Connections (server-side paging, 3-second refresh, slide-out record panel);
the header counts running and completed tasks.

### Activity

The live server event stream as a sortable grid: connects and disconnects,
task lifecycle events, security and system events, each with its arrival
time, a category badge and a one-line message. Events arrive pushed from
the server — this page does not poll.

## How the data flows

The dashboard snapshot is polled every three seconds and shared across all
pages, so switching pages neither re-fetches nor loses anything. Activity
events are pushed live over the same connection. The Overview page offers a
manual refresh as well.

A failed poll leaves the last good numbers on screen with the error shown
alongside, rather than blanking the dashboard on every network hiccup. A
permission denial is the exception: the data is cleared, because showing a
previous session's numbers under an access-denied banner would be wrong.

## Limits

- **Read-only.** The monitor cannot stop a task, disconnect a client, or
  change anything on the server.
- **Activity is collected in the app, not fetched from history.** The feed
  starts empty when the app opens, holds the 200 most recent events, and is
  gone on reload. It is a live window, not a server audit log.
- **Numbers are a 3-second poll.** Only the activity feed is pushed;
  everything else can be up to one poll interval behind.
- **Resource bars are orientation, not capacity.** The CPU bar caps at 100%
  even when the sum across tasks exceeds it, and the memory and GPU bars
  fill against fixed 2 GB and 8 GB references — read the numbers, not the
  fill level.
- **Completed tasks carry no live metrics.** Their CPU and memory cells are
  empty and they are excluded from the Resources aggregates.
