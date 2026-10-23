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
// CONNECT — PUBLIC SURFACE
// =============================================================================
//
// The rest of the app imports the connection layer ONLY through this barrel.
// See types.ts for the isolation rationale.
// =============================================================================

export type {
	SqlDialect,
	SqlEndpoint,
	SqlExecuteResult,
	SqlSchemaColumn,
	SqlSchemaForeignKey,
	SqlSchemaTable,
	SqlSchemaResponse,
	SqlSession,
} from './types';
export { DATABASE_PROVIDERS } from './discovery';
export { createSqlEndpoints } from './endpoints';
export { createSqlSession, toDialect } from './session';
export { SQL_TOOLS, DIALECT_WAIT_MS, GET_SCHEMA_WAIT_MS, REFRESH_SCHEMA_WAIT_MS, statementWaitMs } from './tools';
export { refreshEndpoints, useSqlEndpoints } from './endpointStore';
export type { EndpointStatus, EndpointState } from './endpointStore';
export {
	loadSavedConnections, resetSavedConnections, useSavedConnections, useSavedConnectionsStatus,
	upsertSavedConnection, newConnectionId, deleteSavedConnection, getSavedConnection,
	applySavedConnections, subscribeSavedConnections, getSavedConnections, getSavedConnectionsStatus,
	ownSavedConnections, applyReplicaConnections, getSavedConnectionsPartial, useSavedConnectionsPartial,
} from './savedConnections';
export type { SavedSqlConnection, PipelineBoundConnection, DirectConnection, SavedConnectionsStatus, SavedConnectionsFs, ReplicaPartial } from './savedConnections';
export {
	endpointForConnection, endpointKeyForConnection, isDirectEndpointKey, connIdFromDirectKey,
	directProjectId, directUseOptions, TOOLS_SOURCE_ID,
} from './resolver';
