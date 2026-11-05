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
// EXPLORER — PUBLIC SURFACE (pure modules only)
// =============================================================================
//
// Import path for every app: 'shared/explorer' (or 'shared/explorer/<module>').
// Everything exported here is node:test-safe: no module in this barrel imports
// a VALUE from 'shell'. The two modules that do — shellBinding and react —
// are imported directly by the apps that mount them, never through here.
//
// The library is compiled into each app. It holds no module-level state: every
// store is made by a factory, and each app owns its own instances.
// =============================================================================

export type {
	EndpointState,
	IExplorerClient,
	IExplorerComponent,
	IExplorerEndpoint,
	IExplorerIdentity,
	IExplorerPipeline,
	IExplorerTaskRow,
	IProbeResult,
	IRoleBinding,
	IRoleDef,
	IRoleSpec,
} from './types';
export { SINGLE_TOOLS_ROLE, VECTOR_ROLES } from './types';

export type { ExplorerErrorKind, IExplorerToolErrorInit } from './errors';
export { ExplorerToolError, isStaleError, readErrorCode, readErrorMessage, splitMessage } from './errors';

export type { CheckOutcome, ISchemaReading, ResultCheck, SchemaEvidence } from './checks';
export {
	checkGetQuery,
	checkLegacyErrorEnvelope,
	checkObject,
	checkRowEnvelope,
	checkStoreSuccess,
	checkValidFlag,
	classifySchemaV2,
	composeChecks,
	isPlainObject,
} from './checks';

export type { IGeneration, IGenerationTicket } from './generation';
export { createGeneration } from './generation';

export type { IEndpointKeyParts } from './keys';
export { KEY_VERSION, buildEndpointKey, encodeSegment, legacyKeyFromKey, parseEndpointKey, roleKeySource } from './keys';

export type { IAnnouncement, IAnnouncer } from './a11y/announce';
export { createAnnouncer } from './a11y/announce';
export { createLiveRegion } from './a11y/LiveRegion';

export type { HistoryBag, HistoryOutcome, IHistoryEntry, IHistoryEntryBase, IHistoryLimits, IPrefsAccessor } from './history/types';
export { DEFAULT_HISTORY_LIMITS, MAX_HISTORY_BAG_CHARS } from './history/types';
export type { IRunEvents, RunListener } from './history/runEvents';
export { createRunEvents } from './history/runEvents';
export type { IHistoryStore, IHistoryStoreOptions } from './history/store';
export { createHistoryStore } from './history/store';
export { bagSize, textOf, trimBag, trimHistory } from './history/trim';

export type { ChannelRequest, IActiveKeyStore, IRequestChannel } from './nav/stores';
export { createActiveKeyStore, createRequestChannel } from './nav/stores';
export type { IDocSchemes } from './nav/addresses';
export { createCounter, endpointKeyFromAnyUri, endpointKeyFromUri } from './nav/addresses';

export type { IDiscoveredEndpoint, IDiscoveryOptions } from './connect/discovery';
export { discoverToolEndpoints, mapWithConcurrency, readTaskRow } from './connect/discovery';
export { TOOL_CALL_PERMISSION, identityCanCallTools, identityFingerprint, identityFromConnectResult } from './connect/identity';
export type { IInvokeOptions, ISessionDeps, IToolSession, IToolSessionOptions, IToolSpec } from './connect/session';
export {
	DEFAULT_RETRY_POLL_MS,
	DEFAULT_RETRY_WINDOW_MS,
	DEFAULT_TIMEOUT_MS,
	DEFAULT_TIMEOUT_PAD_MS,
	DEFAULT_TOOL_TIMEOUTS,
	TRANSIENT_TASK_CODE,
	createToolSession,
} from './connect/session';
export type { EndpointStatus, EndpointWatch, IEndpointState, IEndpointStore, IEndpointStoreOptions, IStoreClock, IWatchHandlers } from './connect/store';
export { createEndpointStore, probeInfo } from './connect/store';

export type { IConnectionFlags, IConnectionFlagsOptions } from './history/flags';
export { createConnectionFlags } from './history/flags';

export type { IFailureNotice, IFailureState, IPatternFinding, IRunTarget, IStatementRunBase, PatternAnswer, RunOutcome } from './runner/types';
export { AUTOCOMMIT_WORDS, clock, formatAbandonNotice, formatBatchOutcome, formatElapsed, formatPriorStatements, formatRunLabel, hasStatementInFlight, lineRange } from './runner/format';
export type { BatchStatus, IBatchHooks, IBatchView } from './runner/batch';
export { abandonRuns, runStatementBatch } from './runner/batch';
export type { IPatternPrompt, IStatementRunner, IStatementRunnerConfig } from './runner/useStatementRunner';
export { STOP_WAITING_AFTER_MS, useStatementRunner } from './runner/useStatementRunner';
