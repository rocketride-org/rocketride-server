# Building RocketRide Dev Tools

A **dev tool** is a RocketRide app that the host workbench mounts *inside its
own chrome* instead of running as the whole screen: a panel in the sidebar and
one or more documents in the editor area. The Server Monitor, the SQL console,
the file Explorer and the Profiler are all dev tools.

**Read `ROCKETRIDE_APPS.md` first and keep it open.** A dev tool is an app —
same scaffold, same manifest, same deploy/publish lifecycle, same shell hooks,
same UI components. Everything in that guide applies here unless this document
says otherwise. This document covers only what is *additional*: the two mount
points, the contract the host passes them, the lanes they talk over, and the
rules that separate a tool that behaves from one that fights its host.

---

## Table of Contents

- [What makes an app a dev tool](#what-makes-an-app-a-dev-tool)
- [Declaring one](#declaring-one)
- [The two mounts](#the-two-mounts)
- [Realms, and why your client works anyway](#realms-and-why-your-client-works-anyway)
- [DevToolProps — what the host gives you](#devtoolprops--what-the-host-gives-you)
- [The three bus lanes](#the-three-bus-lanes)
- [Registering ops](#registering-ops)
- [Activation and deactivation](#activation-and-deactivation)
- [Polling only while displayed](#polling-only-while-displayed)
- [Do's and don'ts](#dos-and-donts)
- [Pitfalls](#pitfalls)

---

## What makes an app a dev tool

An ordinary app owns the screen: the shell renders your `app` component in the
client area and your own sidebar beneath its chrome. A dev tool instead
contributes **two smaller components** that the host places in slots it owns,
alongside other tools:

| | ordinary app | dev tool |
|---|---|---|
| mounts | one (`app`) | up to two (`devToolFrame`, `devToolSidebar`) |
| sidebar | yours, whole | a tab among other tools' tabs |
| main surface | the client area | a document (tab) in the editor area |
| lifetime | while the app is open | pinned; either mount can outlive the other |
| documents | one | one per key, if the host supports it |

Consequences that drive the rest of this document: the two mounts may run in
**separate realms** (separate JS contexts — in VS Code, separate webviews),
the sidebar mount stays alive while the user works in other tools, and your
tool shares its host with every other pinned tool. Work you leave running is
work the user did not ask for.

---

## Declaring one

Two declarations, in the two places an app already has.

**1. The manifest** (`package.json`, under the `rocketride` key) adds
`devTool` to `categories` — this is what makes the host offer it as a tool
rather than only as a full-screen app:

```json
{
  "rocketride": {
    "categories": ["tools", "devTool"],
    "mode": "free",
    "authenticated": true,
    "showStatusBar": true
  }
}
```

See `ROCKETRIDE_APPS.md` §The App Manifest for every other field; none of them
behave differently for a tool.

**2. The descriptor** adds the mounts beside (or instead of) `app`:

```tsx
export default {
	app: MyToolApp,                 // optional — the full-screen form
	devToolFrame: MyToolFrame,      // the document surface
	devToolSidebar: MyToolSidebar,  // the controller panel
} satisfies AppDescriptor;
```

Both mounts are optional. A tool may be sidebar-only (a tree with no document
of its own), frame-only (a surface with no controls), or both. Declaring
`devToolFrame` without `app` is normal — a tool with no meaningful
full-screen form should not pretend to have one.

---

## The two mounts

**`devToolSidebar` is the CONTROLLER.** The host mounts it in its sidebar,
behind your tool's tab. It owns **authority** over your tool's shared state:
refcounted or singleton resources, single-writer stores, and — most
importantly — **shared pollers**. It is the mount that reliably exists while
the user is working in your tool, so coordination belongs there.

**`devToolFrame` is a DOCUMENT VIEW.** The host mounts it in the editor area,
once per document key. It renders and it asks; it should not own anything a
second frame would also need.

> **"Authority" does not mean "transport."** A controller is not a proxy to the
> engine. Every realm holds its own working `RocketRideClient`, and there is
> **one socket per host process** behind all of them. Do not route engine calls
> frame → controller → engine; the frame can call the engine directly. Route
> through the controller only what genuinely must happen in *one* place.

---

## Realms, and why your client works anyway

A **realm** is one JS context attached to the shell bus. In the browser shell
both your mounts usually share the page's realm. In VS Code each webview is
its own realm, bridged to the extension host over `postMessage`.

The extension host owns the only engine socket. Historically that meant
`useShellConnection().client` was `null` in a webview realm — silently — and
every tool wrote its own workaround. **That is no longer true.** A bus-mirrored
realm now receives a real `RocketRideClient` whose `request()` rides the bus to
the root's socket; argument packing, validation, response unwrapping and typed
exceptions all run locally through the SDK's own code. So:

```tsx
const { client, isConnected } = useShellConnection();
// `client` is a real RocketRideClient in EVERY realm — frame or sidebar,
// browser or webview. Call any SDK method, including whole namespaces
// (client.account.*, client.deploy.*, client.billing.*) and the file store.
```

What still differs in a realm, and why:

| member | in a realm | use instead |
|---|---|---|
| `connect` / `disconnect` / `identify` / `ping` | throws | the shell owns the lifecycle; read `isConnected` |
| `getApiKey()` | throws | `useShellApiKey()` — async, and visible at the call site |
| `clearAllMonitors()` | throws | `removeMonitor(key, types)` for what *you* added |
| `pipe` / `send` with an `onSSE` callback | throws | open without `onSSE` (events route; that callback path does not yet) |
| `addMonitor` / `removeMonitor` | forwarded to the root | nothing — just call them |

`client` is `null` only when the realm has not yet heard from the root.
**Null means "not known yet", not "disconnected"** — see
[Pitfalls](#pitfalls).

---

## DevToolProps — what the host gives you

Both mounts receive the same props. There is deliberately **no `client`
member** and **no `theme` member**: the client comes from
`useShellConnection()` (above), and your tool is themed by the ambient
`--rr-*` CSS custom properties of whatever document it mounts into.

```tsx
interface DevToolProps {
	channel: ToolChannel;               // the tool's ONE transport surface
	documents?: {
		open(docKey: string, title: string): void;
		close(docKey: string): void;
	};
	docKey?: string;                    // frame: which document this is
	activeDocKey?: string | null;       // sidebar: which document is fronted
}
```

**`channel`** is the only pipe to your tool's *other* mount — three lanes
(retained state, events, correlated ops; next section). There is no raw peer
any more: the post/subscribe pipe is a host-internal transport the host builds
the channel over. The channel's EVENTS carry a **direction discipline** that
is easy to get wrong:

- A **sidebar** mount sends events **only in response to a user action**. An
  event to a closed frame *summons* it — a tree click is an implicit "open
  the tool".
- A **frame** pushes its state whenever it changes. The host retains the last
  frame → sidebar event, so a remounted sidebar renders without asking.
- **A mount-time handshake from the sidebar is a bug.** Every pinned tool's
  sidebar boots with the host sidebar; an ask-on-mount would summon every
  tool's frame at once.

**`documents`** is absent on hosts that give a tool only one surface — check
before calling, and fall back to the event summon.

**`activeDocKey`** lets a sidebar follow the editor selection: highlight the
fronted document's row, and clear the highlight and any dependent panels on
`null` (meaning the active editor is *not* one of your documents). It is
`undefined` on hosts that cannot tell, and on frame mounts.

---

## The three bus lanes

The shell bus has three lanes, and picking the wrong one is the most common
structural mistake in a tool. Ask: **is this a fact, a request, or a
notification?**

### 1. Retained state — a LEVEL

```tsx
const ch = useMemo(() => typedToolChannel<MyStateMap>(channel), [channel]);

// Controller — ONE publisher per topic, by contract:
ch.publishState('connections', snapshot);

// Any view, including one that mounts later:
const snapshot = useToolState(ch, 'connections');   // replays immediately
```

Retained means a **late subscriber receives the current value at once**, and a
state publish **never summons a window**. This is the lane for "what is true
right now": lists, selections, status, counts.

### 2. Correlated operations — a REQUEST

```tsx
// Declare the vocabulary ONCE, private to your tool (ops.ts):
interface MyOps extends ToolOpMap {
	'mytool.refresh': ToolOpSpec<void, void>;
	'mytool.saveConn': ToolOpSpec<{ name: string; dsn: string }, { id: string }>;
}

// Frame:
const call = createToolOpClient<MyOps>(channel);
const { id } = await call('mytool.saveConn', { name, dsn });

// Controller:
const server = createToolOpServer<MyOps>(channel);
server.serve('mytool.saveConn', async ({ name, dsn }) => store.save(name, dsn));
// …and on unmount: server.dispose();
```

Replies are opt-in by construction: one exists if and only if the request
carried a correlation id, which only the channel's `call` stamps. The same
handler registry also answers plain channel *events* whose name matches a
served op — the handler runs, no reply is produced, nothing dangles.

Host relay rules you can rely on: replies reach **live subscribers only** (a
reply to a closed caller is dropped, never retained, never summoning), and
calls are **never** written to a retention slot, so a reloaded sidebar does not
re-execute them.

### 3. Events — an EDGE

```tsx
ch.sendEvent('mytool.revealRow', { id });   // MAY summon a window
ch.onEvent('mytool.revealRow', ({ id }) => reveal(id));
```

Events are **not retained**. Send them for user actions and directed commands
only. Never use an event to communicate a *fact*: a view that mounts later
missed it, and will wait forever for an edge that already happened.

---

## Registering ops

Three registries, three owners. Put a registration in the wrong one and it
either collides or never resolves.

**Tool ops (`mytool.*`) — yours.** Declared in your tool's own `ops.ts`,
served by your controller via `createToolOpServer`, called by your frames via
`createToolOpClient`. Namespace them with your tool's id. Nearly all of your
registrations belong here.

**Client ops (`client.*`) — the shell's, and closed.** There is exactly one
transport op, `client.request`, plus the genuinely stateful few (the monitor
pair, the run-log stream family). The ~111 named passthrough ops that used to
live here are **gone**: they were maintained by hand and drifted — of 102
client methods actually called across the repo, 41 had already fallen out of
the map, each failing only in a realm nobody tested.

> **Never add a `client.*` passthrough op for an SDK method.** Call the method
> on `useShellConnection().client`. If you find yourself writing
> `request('client.somethingNew', …)`, the method you want already works
> through the realm client.

**Host ops (`host.*`) — the host's.** For host *policy* a realm cannot decide:
the credential (`host.apiKey`), where Stripe returns the browser
(`host.stripeReturnUrl`), workbench summons. A tool consumes these; it does not
register them.

Rules for every lane:

- **Registration is exclusive.** One handler per op name per realm; a second
  registration throws. Dispose on unmount (`server.dispose()`, or the returned
  unregister function).
- **Specific beats shared.** A host that pre-registers its own handler for a
  shared op wins; shared tables skip names already taken.
- **"Did not answer" is not "did not happen."** Every request has a timeout. A
  timeout tells you nothing about whether the work ran, so never retry a
  non-idempotent op on one.

---

## Activation and deactivation

The host tells your tool when its sidebar tab becomes, and stops being, the
selected one:

```tsx
useShellEvent('shell:toolSidebarActivated',   ({ appId }) => { /* mine? */ });
useShellEvent('shell:toolSidebarDeactivated', ({ appId }) => { /* pause */ });
```

`shell:toolSidebarActivated` fires on **every** selection, with no
deduplication. `shell:toolSidebarDeactivated` fires **before** the successor's
activation, and only on a real change — re-selecting the same tab deactivates
nothing, and a sidebar reload or an externally synced highlight emits neither.

**What activation means is your tool's decision**, made in your
`devToolSidebar` code:

- A **single-pane tool** (one surface — the Monitor, the Profiler) should make
  sure its document is open: `documents?.open('', 'Server Monitor')`. Without
  this, selecting the tool shows a sidebar whose content depends on a frame
  that never opened, and the panel sits there reporting nothing.
- A **per-document tool** (Explorer, SQL — documents open when the user picks
  something) should ignore activation entirely. Opening a document the user did
  not ask for is worse than opening none.

> **Mounting is NOT an activation.** The host keeps every pinned tool's sidebar
> **mounted**, hiding inactive panels with `display: none` rather than
> unmounting them. A tool that opened its pane from a mount effect reopened it
> on every page load — including panes the user had deliberately closed.
> Register the listener and let it fire.
>
> (An older comment in the shell's event map says the first selection lazily
> mounts the sidebar, making the mount the first activation. The host behaviour
> above is what tools actually observe — trust the event, not the mount.)

---

## Polling only while displayed

**A dev tool must not poll while its surface is out of view.** This is the rule
most likely to make your tool unwelcome, because the cost is invisible to you
and paid by everyone else: your tool shares a host with every other pinned
tool, they all share **one socket**, and a hidden panel's 3-second poll is pure
waste — on the engine, on the bus, and on a laptop battery.

Three facts make this something you must handle explicitly:

1. **`usePolling`'s gate is the CONNECTION, not visibility.**
   `usePolling(fn, 3000)` stops while the shell is disconnected and ticks
   happily forever while your panel is hidden. There is no visibility gate in
   it.
2. **Hidden does not mean unmounted.** The host hides inactive sidebar panels
   with `display: none`. Your effects keep running, your intervals keep firing,
   and your cleanup never runs. You cannot rely on unmount to stop anything.
3. **`document.hidden` is the wrong signal.** It reports the whole window, not
   your panel — and the window is visible the entire time the user is working
   in another tool.

### The shape to use

Put **one** poller in the controller, gate it on activation, and publish each
tick as retained state. Frames then render from the snapshot and never poll at
all:

```tsx
export const MyDevToolSidebar: React.FC<DevToolProps> = ({ channel }) => {
	const ch = useMemo(() => typedToolChannel<MyStateMap>(channel), [channel]);
	const { client } = useShellConnection();

	// Visibility is NOT in the props and NOT in usePolling — track it.
	const [visible, setVisible] = useState(true);
	useShellEvent('shell:toolSidebarActivated',   ({ appId }) => { if (appId === MY_ID) setVisible(true); });
	useShellEvent('shell:toolSidebarDeactivated', ({ appId }) => { if (appId === MY_ID) setVisible(false); });

	const tick = useCallback(async () => {
		if (!client) return;
		ch.publishState('dashboard', await client.getDashboard());
	}, [client, ch]);

	// The interval exists only while the panel is displayed. The retained
	// snapshot survives the pause, so reactivating renders instantly and
	// then refreshes — no spinner, and no stale-forever panel.
	useEffect(() => {
		if (!visible || !client) return;
		void tick();                                   // refresh on reveal
		const id = setInterval(() => void tick(), 3000);
		return () => clearInterval(id);
	}, [visible, client, tick]);

	return <MyPanel snapshot={useToolState(ch, 'dashboard')} />;
};
```

### Gating a frame

A frame cannot see its own visibility directly. Two honest options:

- **Preferred:** don't poll in a frame at all. Read the retained state the
  controller publishes (above) — one poller, any number of documents.
- If a frame genuinely must drive its own refresh, let the **controller**
  decide: the sidebar knows which document is fronted via `activeDocKey`, so
  publish that as state and have each frame poll only while
  `activeDocKey === docKey`.

### Honest limits

There is **no initial-visibility prop**. The events give you edges, not a
starting level. Starting `visible = true` (as above) is the pragmatic choice:
you poll until the first deactivation, which costs at most one hidden interval
for a tool the user has never selected. If your tick is expensive, derive the
initial state from something you *do* have — `activeDocKey`, or the frame's
first push — and start paused.

**Also pause on deactivation:** engine monitors (call `removeMonitor` for what
you added, rather than leaving the subscription open), run-log stream playback,
and file watchers. Anything whose cost continues while nobody is looking.

**Do not pause:** a retained state subscription (it costs nothing while idle),
or a one-shot fetch already in flight — let it finish and publish, because
cancelling leaves the panel blank for a reveal that is probably seconds away.

---

## Do's and don'ts

**Do**

- Call the engine from whichever mount needs it — every realm has a real
  client, and there is one socket behind them all.
- Put shared, refcounted or single-writer state in the **controller**, and
  publish it as retained state.
- Namespace every tool op with your tool's id (`mytool.*`).
- Dispose every registration, subscription and interval you create.
- Decide deliberately what activation means for your tool, and implement it in
  the sidebar.
- Treat an absent value as **unknown**, and render it as such.

**Don't**

- Don't add a `client.*` op to forward an SDK method. That map is closed, and
  the forwarding is exactly what drifted.
- Don't route engine work frame → controller → engine. That is transport, not
  coordination, and it is the pattern this architecture removed.
- Don't poll while your panel or document is hidden.
- Don't post from a sidebar on mount — you will summon every tool's frame.
- Don't send a *fact* as an event; a later subscriber never sees it.
- Don't open a document the user did not ask for (unless you are a single-pane
  tool, on activation).
- Don't call `getApiKey()`, `connect()`, `disconnect()` or `clearAllMonitors()`
  from a tool. Engine work needs no key — the client already carries the
  session.
- Don't assume both mounts share a JS context: no module singletons, no shared
  closures, no `window` globals between them.

---

## Pitfalls

**Absence rendered as a negative.** The defining bug of this surface. A realm
that has not yet heard from the root knows *nothing* — it is not disconnected.
Code like this reports a live session as broken:

```tsx
// WRONG — renders "Connecting…" forever in a realm that is fine
const { client } = useShellConnection();
if (!client) return <div>Connecting…</div>;
```

`useConnectionReady(channel)` is deliberately **tri-state** for the same
reason: `true` (ready), `false` (known not ready), `undefined` (not yet known).
Branch on all three, and render `undefined` as neutral or loading:

```tsx
const ready = useConnectionReady(ch);
if (ready === undefined) return <Spinner />;        // unknown
if (ready === false)     return <NotConnected />;   // known bad
```

**An edge where a level belonged.** If a panel is ever empty when it should
have content, and a refresh or a tab switch fixes it, you published an event
where you needed retained state.

**A second publisher on a topic.** Retained topics are single-writer by
contract. Two publishers produce a value that flickers between two truths and
depends on timing.

**Stale state after a reconnect.** The controller's snapshot does not
invalidate itself. Re-publish on `shell:connected`, or your panel will show
pre-outage data with full confidence.

**A reply that never arrives.** Replies go to live subscribers only. If a frame
calls an op and then closes, the reply is dropped by design — handle the
rejection; do not assume the work failed.

---

## Where to read next

- `ROCKETRIDE_APPS.md` — everything a dev tool inherits as an app: scaffold,
  manifest, descriptor, dev loop, shell hooks, state and prefs, embedding
  pipelines, deploy and publish.
- `ROCKETRIDE_UI_COMPONENTS.md` — the stock components your mounts render.
- `ROCKETRIDE_typescript_API.md` — every method on the client your realm holds.
- `ROCKETRIDE_OBSERVABILITY.md` — engine events and monitors, if your tool
  watches runtime activity.
