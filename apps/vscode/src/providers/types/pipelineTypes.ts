// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Pipeline editor message types — all that remain are REALM-LOCAL.
 *
 * The host sends the webview nothing: publish is `host.pipeline.publish`,
 * the Subscribe overlay is the per-doc `:checkout` signal, and subscription
 * state is derived from the mirrored account. `shell:event` below is
 * synthesized BY THE REALM from its bus `mirror.event` so the existing fold
 * keeps its shape; `view:ready` is useMessaging's page-lifecycle marker.
 */

/** REALM-LOCAL only: synthesized from the bus `mirror.event` so the existing
 *  event fold keeps its shape. The host posts nothing. */
export type PipelineHostToWebview = { type: 'shell:event'; event: unknown };

/** useMessaging's page-lifecycle marker — the only thing still posted. */
export type PipelineWebviewToHost = { type: 'view:ready' };
