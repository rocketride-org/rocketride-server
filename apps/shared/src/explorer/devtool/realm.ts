// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EXPLORER DEV TOOL — CONTROLLER READINESS TOPIC (what frames wait for)
// =============================================================================
//
// The one cross-mount fact this library owns: whether a controller is serving.
// A frame's call that reaches a sidebar peer while no controller has served its
// handlers is LOST (the host builds the sidebar channel at render, which flushes
// the peer's held calls into a channel that has no registry yet, and the
// channel drops calls it cannot serve), so frames send nothing until the
// controller says it is ready (frame.ts), and ask the host to mount it with
// one event (summon.ts).
//
// The topic sits under this library's reserved `devtool:` prefix (the shell
// reserves `host:` for itself and this library never publishes under it).
// There is no realm-kind probe here: every realm holds a real client, so what
// a realm owns is never inferred from whether it has one.
// =============================================================================

/**
 * State topics whose names start with this prefix belong to this library;
 * lanes never publish under it. (The shell reserves `host:` the same way,
 * toolProtocol.ts.)
 */
export const RESERVED_STATE_PREFIX = 'devtool:';

/**
 * The retained state topic a controller publishes its readiness on:
 * `{ ready: <nonce> }` once every handler is served, `{ ready: null }` when it
 * unmounts. Frames hold calls until they see a nonce (frame.ts).
 */
export const CONTROLLER_STATE_TOPIC = `${RESERVED_STATE_PREFIX}controller`;

/** What {@link CONTROLLER_STATE_TOPIC} carries. */
export interface IControllerState {
	/** A nonce per controller mount while it serves; null once it unmounted. */
	ready: string | null;
}

/**
 * A short random id (a controller mount's readiness nonce).
 *
 * @returns The id.
 */
export function mountNonce(): string {
	return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
