/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Pure types for the RocketRide agent eval suite (Phase 5, Task 5.1a).
 *
 * Nothing in this module touches the network, the model, or the engine — it
 * describes the shape of a `.pipe` JSON document and the golden-brief /
 * scoring contracts that `eval/src/score.ts` and `eval/src/briefs.ts`
 * implement. Consumed by the 5.1b runner and the 5.1c CI gate.
 */

/** A single lane connection: `{ lane, from }` wires a component's input to an upstream component's output. */
export interface PipeInput {
	lane: string;
	from: string;
}

/** A control-plane connection. Lives on the CONTROLLED node (e.g. an llm/tool/memory), never on the invoker. */
export interface PipeControl {
	classType: string;
	from: string;
}

export interface PipeUiPosition {
	x: number;
	y: number;
}

export interface PipeUi {
	position?: PipeUiPosition;
	measured?: { width: number; height: number };
	nodeType?: string;
	formDataValid?: boolean;
}

/** One node in a `.pipe` component graph. */
export interface PipeComponent {
	id: string;
	provider: string;
	config: Record<string, unknown>;
	input?: PipeInput[];
	control?: PipeControl[];
	ui?: PipeUi;
}

/**
 * Parsed `.pipe` JSON document.
 *
 * `sourceFile` is scoring metadata, not part of the real on-disk schema — the
 * runner (5.1b) sets it to the path/name the agent actually wrote the
 * pipeline to, so `structuralChecks['pipe-extension']` (Mistake 4) can be
 * evaluated without score.ts touching the filesystem itself. It is optional
 * and omitted checks pass trivially when it is absent.
 */
export interface Pipe {
	components: PipeComponent[];
	project_id: string;
	viewport?: { x: number; y: number; zoom: number };
	version: number;
	source?: string;
	sourceFile?: string;
}

export interface ToolCall {
	tool: string;
	ok: boolean;
	/**
	 * Set (Phase 5, Task 5.1b fix-up) when this is a `validate_pipeline` call whose verdict came
	 * from the stub engine's local structural-check fallback (no recorded/live-engine verdict for
	 * this pipe digest) rather than a real engine. `undefined` for every other tool, and for a
	 * `validate_pipeline` call that DID hit a real recorded verdict.
	 */
	approximated?: boolean;
}

/** A golden brief: the literal prompt sent to the rr-builder session, plus its pass criteria. */
export interface EvalBrief {
	id: string;
	title: string;
	/** Literal user prompt sent to the rr-builder session — verbatim, do not paraphrase. */
	prompt: string;
	/** fixtures/broken/<file> — seed pipe for debug (`D*`) briefs. */
	seedPipe?: string;
	/** Every listed provider must be present. Families use a `*` suffix (e.g. `llm_*`). */
	expectProviders: string[];
	/** Providers that must NOT appear (e.g. B02 forbids `webhook`). */
	forbidProviders?: string[];
	nodeCount: [min: number, max: number];
	/** ids from the `structuralChecks` registry in score.ts */
	structural: string[];
	/** Live-mode run_pipeline scoring subset (V6). */
	runnable: boolean;
	/** Number of `.pipe` documents this brief produces. Default 1; B11 = 2. */
	pipeCount: number;
	/** D01: the agent must call validate_pipeline at least this many times (before + after the fix). */
	minValidateCalls?: number;
}

export interface BriefResult {
	briefId: string;
	validatePass: boolean;
	/** Empty = every structural check passed. */
	structuralFailures: string[];
	nodeCountOk: boolean;
	providersOk: boolean;
	/** Live mode only. */
	runSuccess?: boolean;
	toolCalls: ToolCall[];
	pass: boolean;
	/**
	 * True when ANY `validate_pipeline` call this brief made was answered by the stub engine's
	 * local structural-check approximation instead of a real (recorded or live) engine verdict —
	 * see `ToolCall.approximated`. `pass` above is computed purely from that (possibly
	 * approximated) verdict, so a `pass:true` result with `approximated:true` is NOT proof the
	 * real engine would agree — see `SuiteReport.approximatedCount`.
	 */
	approximated?: boolean;
}

export interface SuiteReport {
	mode: 'replay' | 'live';
	results: BriefResult[];
	passRate: number;
	/** passRate >= 0.8 — the GA gate, measured in live mode. */
	gate: boolean;
	/**
	 * Count of `results` with `approximated: true`. A non-zero count in `live` mode is an
	 * infrastructure bug (live mode must never reach the stub — see `eval/src/runner.ts`'s
	 * `startEngineForBrief` guard). A non-zero count in `replay` mode means at least one brief's
	 * transcript pins the model's turns but never had a matching recorded engine verdict —
	 * `eval/run.ts` refuses to treat that run as a clean regression baseline.
	 */
	approximatedCount: number;
}
