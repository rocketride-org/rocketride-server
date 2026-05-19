// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// jsdom's `crypto` object lacks `randomUUID`. The browser provides it on
// `window.crypto`; for tests we polyfill from Node's `crypto.webcrypto`.
const { webcrypto } = require('crypto');
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
	Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

// jsdom's `File` implementation in this jest version is missing `arrayBuffer()`.
// Node 20+ ships a spec-compliant `File` on the global; prefer it.
const { File: NodeFile, Blob: NodeBlob } = require('buffer');
if (typeof NodeFile === 'function') {
	Object.defineProperty(globalThis, 'File', { value: NodeFile, configurable: true, writable: true });
}
if (typeof NodeBlob === 'function') {
	Object.defineProperty(globalThis, 'Blob', { value: NodeBlob, configurable: true, writable: true });
}
