// =============================================================================
// Test probe: internal telemetry steps the network does not show (the web
// vitals capture started, the recorder started or was gated, the storage guard
// missing) are reported to window.__rrTelemetryProbe when something installed
// it. Only the e2e harness does (an init script); production installs nothing,
// so every call is a no-op and nothing is logged.
// =============================================================================

/** The hook the e2e harness installs: one call per step, with a short detail. */
export type TelemetryProbe = (step: string, detail: string) => void;

/**
 * Report a step to the installed probe, if any. Never throws.
 *
 * @param step   What happened ('replay', 'web vitals', 'storage guard').
 * @param detail The outcome ('started', 'skipped <reason>', ...).
 */
export function probe(step: string, detail: string): void {
	try {
		const hook = (globalThis as { __rrTelemetryProbe?: unknown }).__rrTelemetryProbe;
		if (typeof hook === 'function') (hook as TelemetryProbe)(step, detail);
	} catch {
		/* a probe never breaks telemetry */
	}
}
