// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// BINARY WIRE — carrying DAP's one binary member through a JSON-only hop
// =============================================================================
//
// THE PROTOCOL RULE: a DAP message has exactly ONE binary member,
// `arguments.data`, at exactly one depth. Its mere PRESENCE switches the
// WebSocket transport from a text frame to a binary one —
// `JSON header \n payload` (`TransportWebSocket.ts:588-618`) — and a received
// payload is put back at the same key (`:294`). Everything else in a message
// is JSON, always. So the file operations need no special cases of their own:
// `fsWrite` sends bytes in that member and `fsRead` reads bytes out of it.
//
// WHY A REALM NEEDS THIS: `RocketRideClientProxy` forwards `request()` — the
// SDK's real transport chokepoint — over the shell bus. VS Code's
// `webview.postMessage` serializes to JSON, and JSON renders a typed array as
// an INDEX-KEYED OBJECT: `{"0":104,"1":105,…}`. No error, no warning. A write
// would store garbage and a read would hand back an object pretending to be
// bytes. The hand-written op table avoided this per-op with a `dataB64`
// convention; a single chokepoint carries the protocol rule itself.
//
// WHY NOT A GENERIC DEEP WALK FOR BYTES ANYWHERE: because the member is not
// generic, and pretending otherwise is actively worse. Rewriting `data` to a
// marker object means that if the far end ever fails to decode it, the
// transport takes its `else` branch (`:594`) and JSON-stringifies the MARKER
// into the binary payload. Framing exactly the one member the protocol
// defines keeps that impossible rather than merely unlikely.
// =============================================================================

import type { DAPMessage } from 'rocketride';

/** Marks the encoded binary member (a plain object, never a typed array). */
const BINARY_MARKER = '__rrbin';

/** DAP's `arguments.data`, flattened for a JSON-only hop. */
interface IWireBinary {
	/** Discriminant. */
	[BINARY_MARKER]: true;
	/** The bytes, base64-encoded. */
	b64: string;
}

/** Encodes bytes for a JSON-only hop. */
function bytesToB64(bytes: Uint8Array): string {
	const nodeBuffer = (globalThis as Record<string, unknown>).Buffer as { from(b: Uint8Array): { toString(enc: string): string } } | undefined;
	if (nodeBuffer) return nodeBuffer.from(bytes).toString('base64');
	// Browser: chunked, because spreading a multi-megabyte array into
	// `String.fromCharCode` blows the argument limit.
	let bin = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(bin);
}

/** Decodes a base64 payload back into bytes. */
function b64ToBytes(b64: string): Uint8Array {
	const nodeBuffer = (globalThis as Record<string, unknown>).Buffer as { from(s: string, enc: string): Uint8Array } | undefined;
	if (nodeBuffer) return new Uint8Array(nodeBuffer.from(b64, 'base64'));
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Narrows any byte container to the bytes themselves. */
function asBytes(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	// A `Buffer` is a Uint8Array subclass and already matched; this catches
	// the other views (DataView, Int32Array, …) so none is the one that
	// slips through as an index-keyed object.
	if (ArrayBuffer.isView(value)) {
		const view = value as ArrayBufferView;
		return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
	}
	return null;
}

/**
 * Frames a message's binary member for transport over the bus.
 *
 * Applied to a REQUEST before it leaves the realm and to a RESPONSE before it
 * leaves the root — the member sits at the same place in both.
 *
 * A `data` that is a string or a plain object is left ALONE: both are
 * JSON-safe, and the transport has its own defined handling for each
 * (`TransportWebSocket.ts:589-595`). Only bytes need the marker.
 *
 * @param message - The message to frame.
 * @returns A JSON-safe message. The same object when nothing was binary.
 */
export function encodeMessageData(message: DAPMessage): DAPMessage {
	const args = message.arguments;
	if (!args || !('data' in args)) return message;
	const bytes = asBytes(args.data);
	if (!bytes) return message;
	const wire: IWireBinary = { [BINARY_MARKER]: true, b64: bytesToB64(bytes) };
	return { ...message, arguments: { ...args, data: wire } };
}

/**
 * Restores a message's binary member after transport over the bus.
 *
 * @param message - The message as it arrived.
 * @returns The message with bytes back in the `data` member.
 */
export function decodeMessageData(message: DAPMessage): DAPMessage {
	const args = message.arguments;
	if (!args || !('data' in args)) return message;
	const wire = args.data as Record<string, unknown> | null;
	if (typeof wire !== 'object' || wire === null || wire[BINARY_MARKER] !== true) return message;
	return { ...message, arguments: { ...args, data: b64ToBytes(wire.b64 as string) } };
}
