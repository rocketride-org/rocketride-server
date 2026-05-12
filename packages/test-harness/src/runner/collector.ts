/**
 * Token-scoped trace collector.
 *
 * One collector per pipeline run. Subscribes to apaevt_flow + apaevt_sse via
 * the RocketRide TS client, buffers events, resolves when a terminal
 * apaevt_flow op:'end' arrives or the timeout fires.
 */

import type { ApaevtAnyEvent, ApaevtFlowEvent, ApaevtSseEvent } from './schema';

export type CollectorOptions = {
	token: string;
	timeoutMs: number;
};

export type CollectorResult = {
	sse_events: ApaevtSseEvent[];
	runtime_events: ApaevtFlowEvent[];
	other_events: ApaevtAnyEvent[];
	exercised_nodes: string[];
	timedOut: boolean;
	terminalEvent?: ApaevtFlowEvent;
};

export class TraceCollector {
	private readonly sseEvents: ApaevtSseEvent[] = [];
	private readonly runtimeEvents: ApaevtFlowEvent[] = [];
	private readonly otherEvents: ApaevtAnyEvent[] = [];
	private readonly exercised = new Set<string>();
	private resolveTerminal?: (ev: ApaevtFlowEvent) => void;
	private terminalEvent?: ApaevtFlowEvent;

	constructor(private readonly options: CollectorOptions) {}

	/** Hand this to RocketRideClient constructor as onEvent. */
	readonly onEvent = async (message: unknown): Promise<void> => {
		const msg = message as ApaevtAnyEvent | undefined;
		if (!msg || typeof msg.event !== 'string') return;

		if (msg.event === 'apaevt_flow') {
			const ev = msg as ApaevtFlowEvent;
			this.runtimeEvents.push(ev);
			const pipes = ev.body?.pipes;
			if (Array.isArray(pipes) && pipes.length > 0) {
				this.exercised.add(pipes[pipes.length - 1]);
			}
			if (ev.body?.op === 'end' && !this.terminalEvent) {
				this.terminalEvent = ev;
				if (this.resolveTerminal) this.resolveTerminal(ev);
			}
			return;
		}

		if (msg.event === 'apaevt_sse') {
			this.sseEvents.push(msg as ApaevtSseEvent);
			return;
		}

		this.otherEvents.push(msg);
	};

	/** Resolves when the terminal apaevt_flow op:'end' arrives or the timeout fires. */
	async waitForTerminal(): Promise<CollectorResult> {
		const timedOut = await new Promise<boolean>((resolve) => {
			if (this.terminalEvent) {
				resolve(false);
				return;
			}
			const timer = setTimeout(() => {
				this.resolveTerminal = undefined;
				resolve(true);
			}, this.options.timeoutMs);
			this.resolveTerminal = () => {
				clearTimeout(timer);
				resolve(false);
			};
		});

		return {
			sse_events: this.sseEvents,
			runtime_events: this.runtimeEvents,
			other_events: this.otherEvents,
			exercised_nodes: Array.from(this.exercised),
			timedOut,
			terminalEvent: this.terminalEvent,
		};
	}
}
