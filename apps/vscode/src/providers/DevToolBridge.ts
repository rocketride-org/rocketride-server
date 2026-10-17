// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DevToolBridge — the peer-message relay between a dev tool's two mounts.
 *
 * A tool's frame (editor-area webview) and sidebar panel (the RocketRide
 * sidebar webview) are ISOLATED documents; their `DevToolProps.peer` channel
 * is relayed here, keyed by app id. Payloads are opaque to the host.
 *
 * Buffering: a sidebar click that OPENS the tool's panel can post its first
 * message before the panel webview has mounted — messages to an unregistered
 * panel are buffered (bounded) and flushed when the panel registers. The
 * sidebar webview is long-lived, so the sidebar direction buffers the same
 * way only while it has not resolved yet.
 */

/** Most buffered messages kept per direction per tool. */
const BUFFER_LIMIT = 64;

type Deliver = (payload: unknown) => void;

/**
 * Minimal mirror of the shell's tool-channel STATE envelope
 * (packages/shell/src/components/workspace/toolChannel.ts). The extension
 * host never imports the shell browser bundle, and the envelope is a stable
 * wire contract: `{ __rrtool: 'state', topic, snapshot }`.
 *
 * @param payload - Any relayed peer payload.
 * @returns The topic when the payload is a channel state message, else null.
 */
function toolStateTopic(payload: unknown): string | null {
	const m = payload as { __rrtool?: string; topic?: unknown } | null;
	return m && typeof m === 'object' && m.__rrtool === 'state' && typeof m.topic === 'string' ? m.topic : null;
}

export class DevToolBridge {
	/**
	 * Called when a sidebar mount posts to a tool whose panel is NOT open —
	 * the host wires this to reopen the panel (the message waits in the
	 * buffer and flushes once the reopened panel registers). The sidebar
	 * outlives the panel, so a click there is an implicit "open the tool".
	 */
	public onPanelNeeded?: (appId: string) => void;

	/** Live panel delivery functions, by tool app id. A tool may hold SEVERAL
	    panels (one per document key) — sidebar→panel messages broadcast to
	    all of them; the payload carries whatever the tool needs to route. */
	private panelSinks = new Map<string, Set<Deliver>>();
	/** Buffered sidebar→panel messages awaiting a panel, by tool app id. */
	private panelBuffers = new Map<string, unknown[]>();
	/**
	 * Channel STATE snapshots toward panels, retained per (tool, topic) —
	 * every newly registered panel replays them before anything else, so a
	 * document opening minutes after the controller published still renders
	 * from current state. Unlike events, a state publish with no open panel
	 * retains silently: it must never summon a window.
	 */
	private panelRetainedState = new Map<string, Map<string, unknown>>();

	/** The (single) sidebar delivery function, once the sidebar resolves. */
	private sidebarSink: ((appId: string, payload: unknown) => void) | null = null;
	/** Buffered panel→sidebar messages awaiting the sidebar. */
	private sidebarBuffer: Array<{ appId: string; payload: unknown }> = [];
	/**
	 * The LAST panel→sidebar message per tool, retained across sidebar
	 * reloads. Frames push full state snapshots whenever state changes (the
	 * peer contract), so replaying the latest one to a freshly (re)loaded
	 * sidebar re-renders its mounts without any ask-the-frame handshake.
	 */
	private sidebarRetained = new Map<string, unknown>();

	// ── Panel side ───────────────────────────────────────────────────────────

	/**
	 * Registers a tool panel's delivery function and flushes the buffer.
	 *
	 * @param appId - The tool's app id.
	 * @param deliver - Posts one peer payload into the panel webview.
	 */
	public registerPanel(appId: string, deliver: Deliver): void {
		const sinks = this.panelSinks.get(appId) ?? new Set<Deliver>();
		sinks.add(deliver);
		this.panelSinks.set(appId, sinks);
		// Retained channel state FIRST — the fresh document renders from
		// current snapshots before any queued events act on it.
		const retained = this.panelRetainedState.get(appId);
		if (retained) {
			for (const payload of retained.values()) deliver(payload);
		}
		const buffered = this.panelBuffers.get(appId);
		if (buffered) {
			this.panelBuffers.delete(appId);
			for (const payload of buffered) deliver(payload);
		}
	}

	/**
	 * Unregisters one disposed tool panel (its sink specifically — other
	 * panels of the same tool keep theirs).
	 *
	 * @param appId - The tool's app id.
	 * @param deliver - The sink registerPanel was given.
	 */
	public unregisterPanel(appId: string, deliver: Deliver): void {
		const sinks = this.panelSinks.get(appId);
		if (!sinks) return;
		sinks.delete(deliver);
		if (sinks.size === 0) {
			this.panelSinks.delete(appId);
			this.panelBuffers.delete(appId);
		}
	}

	/**
	 * Delivers a sidebar→panel peer message to every open panel of the tool
	 * (buffered while none is open). By the peer contract these are USER
	 * actions, so a message with no panel at all summons one.
	 *
	 * @param appId - The tool's app id.
	 * @param payload - Opaque message payload.
	 */
	public toPanel(appId: string, payload: unknown): void {
		// Channel STATE: retain per topic (replayed to every panel that
		// registers later) and deliver to whoever is open. Never buffer,
		// never summon — publishing state must not pop windows.
		const stateTopic = toolStateTopic(payload);
		if (stateTopic !== null) {
			const topics = this.panelRetainedState.get(appId) ?? new Map<string, unknown>();
			topics.set(stateTopic, payload);
			this.panelRetainedState.set(appId, topics);
			const stateSinks = this.panelSinks.get(appId);
			if (stateSinks) for (const sink of stateSinks) sink(payload);
			return;
		}

		const sinks = this.panelSinks.get(appId);
		if (sinks && sinks.size > 0) {
			for (const sink of sinks) sink(payload);
			return;
		}
		const buffer = this.panelBuffers.get(appId) ?? [];
		if (buffer.length < BUFFER_LIMIT) buffer.push(payload);
		this.panelBuffers.set(appId, buffer);
		// No live panel: summon it — the buffered message delivers on its
		// view:ready registration. (Reopening an already-opening panel is a
		// no-op reveal, so bursts are safe.) Events and legacy raw peer
		// messages only — state returned above.
		this.onPanelNeeded?.(appId);
	}

	// ── Sidebar side ─────────────────────────────────────────────────────────

	/**
	 * Registers the sidebar's delivery function and flushes the buffer.
	 *
	 * @param deliver - Posts one peer payload (with its tool id) into the sidebar webview.
	 */
	public registerSidebar(deliver: (appId: string, payload: unknown) => void): void {
		this.sidebarSink = deliver;
		const buffered = this.sidebarBuffer;
		this.sidebarBuffer = [];
		for (const { appId, payload } of buffered) deliver(appId, payload);
	}

	/**
	 * Delivers a panel→sidebar peer message (buffered until the sidebar resolves).
	 * The latest message per tool is also RETAINED for replay to a reloaded
	 * sidebar (see {@link replayRetainedToSidebar}).
	 *
	 * @param appId - The tool's app id.
	 * @param payload - Opaque message payload.
	 */
	public toSidebar(appId: string, payload: unknown): void {
		this.sidebarRetained.set(appId, payload);
		if (this.sidebarSink) {
			this.sidebarSink(appId, payload);
			return;
		}
		if (this.sidebarBuffer.length < BUFFER_LIMIT) this.sidebarBuffer.push({ appId, payload });
	}

	/**
	 * Replays each tool's retained last message into the sidebar. The host
	 * calls this on the sidebar webview's `view:ready` — registration alone
	 * happens before the webview's document loads, when posts can be lost.
	 */
	public replayRetainedToSidebar(): void {
		if (!this.sidebarSink) return;
		for (const [appId, payload] of this.sidebarRetained) this.sidebarSink(appId, payload);
	}
}
