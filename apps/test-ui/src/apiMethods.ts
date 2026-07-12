// MIT License
//
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
// TEST-UI — Complete API method catalog for coverage tracking
// =============================================================================

import type { ApiMethodDef } from './types';

export const API_METHODS: ApiMethodDef[] = [
	// =========================================================================
	// CONNECTION
	// =========================================================================
	{ method: 'connect', category: 'Connection', mode: 'happy' },
	{ method: 'attach', category: 'Connection', mode: 'happy' },
	{ method: 'login', category: 'Connection', mode: 'happy' },
	{ method: 'detach', category: 'Connection', mode: 'skip', skipReason: 'Destructive: would disconnect the test client' },
	{ method: 'logout', category: 'Connection', mode: 'skip', skipReason: 'Destructive: would deauth the test session' },
	{ method: 'disconnect', category: 'Connection', mode: 'skip', skipReason: 'Destructive: would drop the WebSocket' },
	{ method: 'isConnected', category: 'Connection', mode: 'happy' },
	{ method: 'isAttached', category: 'Connection', mode: 'happy' },
	{ method: 'isAuthenticated', category: 'Connection', mode: 'happy' },
	{ method: 'ping', category: 'Connection', mode: 'happy' },
	{ method: 'getServerInfo', category: 'Connection', mode: 'happy' },
	{ method: 'getAccountInfo', category: 'Connection', mode: 'happy' },
	{ method: 'getConnectionInfo', category: 'Connection', mode: 'happy' },
	{ method: 'getOrgId', category: 'Connection', mode: 'happy' },
	{ method: 'getApiKey', category: 'Connection', mode: 'happy' },
	{ method: 'identify', category: 'Connection', mode: 'happy' },

	// =========================================================================
	// PIPELINE
	// =========================================================================
	{ method: 'use', category: 'Pipeline', mode: 'happy' },
	{ method: 'terminate', category: 'Pipeline', mode: 'happy' },
	{ method: 'restart', category: 'Pipeline', mode: 'happy' },
	{ method: 'getTaskStatus', category: 'Pipeline', mode: 'happy' },
	{ method: 'getTaskToken', category: 'Pipeline', mode: 'negative' },
	{ method: 'getTaskPipeline', category: 'Pipeline', mode: 'happy' },
	{ method: 'validate', category: 'Pipeline', mode: 'happy' },

	// =========================================================================
	// DATA
	// =========================================================================
	{ method: 'send', category: 'Data', mode: 'happy' },
	{ method: 'sendFiles', category: 'Data', mode: 'skip', skipReason: 'Requires File objects not available in test context' },
	{ method: 'pipe.open', category: 'Data', mode: 'skip', skipReason: 'Tested as a group via pipe()' },
	{ method: 'pipe.write', category: 'Data', mode: 'skip', skipReason: 'Tested as a group via pipe()' },
	{ method: 'pipe.close', category: 'Data', mode: 'skip', skipReason: 'Tested as a group via pipe()' },
	{ method: 'pipe.tool', category: 'Data', mode: 'skip', skipReason: 'Requires pipeline with @tool_function node' },
	{ method: 'chat', category: 'Data', mode: 'happy' },

	// =========================================================================
	// EVENTS
	// =========================================================================
	{ method: 'addMonitor', category: 'Events', mode: 'happy' },
	{ method: 'removeMonitor', category: 'Events', mode: 'happy' },
	{ method: 'clearAllMonitors', category: 'Events', mode: 'happy' },
	{ method: 'getDashboard', category: 'Events', mode: 'happy' },

	// =========================================================================
	// TEMPLATES
	// =========================================================================
	{ method: 'saveTemplate', category: 'Templates', mode: 'happy' },
	{ method: 'getTemplate', category: 'Templates', mode: 'happy' },
	{ method: 'deleteTemplate', category: 'Templates', mode: 'happy' },
	{ method: 'getAllTemplates', category: 'Templates', mode: 'happy' },

	// =========================================================================
	// LOGS
	// =========================================================================
	{ method: 'saveLog', category: 'Logs', mode: 'negative' },
	{ method: 'getLog', category: 'Logs', mode: 'happy' },
	{ method: 'deleteLog', category: 'Logs', mode: 'happy' },
	{ method: 'listLogs', category: 'Logs', mode: 'happy' },

	// =========================================================================
	// FILE STORE
	// =========================================================================
	{ method: 'fsMkdir', category: 'FileStore', mode: 'happy' },
	{ method: 'fsWriteString', category: 'FileStore', mode: 'happy' },
	{ method: 'fsReadString', category: 'FileStore', mode: 'happy' },
	{ method: 'fsWriteJson', category: 'FileStore', mode: 'happy' },
	{ method: 'fsReadJson', category: 'FileStore', mode: 'happy' },
	{ method: 'fsStat', category: 'FileStore', mode: 'happy' },
	{ method: 'fsListDir', category: 'FileStore', mode: 'happy' },
	{ method: 'fsRename', category: 'FileStore', mode: 'happy' },
	{ method: 'fsGetUrl', category: 'FileStore', mode: 'happy' },
	{ method: 'fsOpen', category: 'FileStore', mode: 'happy' },
	{ method: 'fsRead', category: 'FileStore', mode: 'happy' },
	{ method: 'fsWrite', category: 'FileStore', mode: 'happy' },
	{ method: 'fsClose', category: 'FileStore', mode: 'skip', skipReason: 'Tested inline within fsOpen/fsRead/fsWrite' },
	{ method: 'fsDelete', category: 'FileStore', mode: 'happy' },
	{ method: 'fsRmdir', category: 'FileStore', mode: 'happy' },

	// =========================================================================
	// ACCOUNT (SaaS only — OSS account handler has different signature)
	// =========================================================================
	{ method: 'account.getProfile', category: 'Account', mode: 'happy', saasOnly: true },
	{ method: 'account.updateProfile', category: 'Account', mode: 'skip', skipReason: 'Destructive: would modify user profile', saasOnly: true },
	{ method: 'account.setDefaultTeam', category: 'Account', mode: 'skip', skipReason: 'Destructive: would change default team', saasOnly: true },
	{ method: 'account.setDefaultOrg', category: 'Account', mode: 'skip', skipReason: 'Destructive: would change default org', saasOnly: true },
	{ method: 'account.getOrg', category: 'Account', mode: 'happy', saasOnly: true },
	{ method: 'account.updateOrgName', category: 'Account', mode: 'skip', skipReason: 'Destructive: would rename organization', saasOnly: true },
	{ method: 'account.listKeys', category: 'Account', mode: 'happy', saasOnly: true },
	{ method: 'account.createKey', category: 'Account', mode: 'skip', skipReason: 'Destructive: would create an API key', saasOnly: true },
	{ method: 'account.revokeKey', category: 'Account', mode: 'skip', skipReason: 'Destructive: would revoke an API key', saasOnly: true },
	{ method: 'account.listMembers', category: 'Account', mode: 'happy', saasOnly: true },
	{ method: 'account.inviteMember', category: 'Account', mode: 'skip', skipReason: 'Destructive: would send invitation email', saasOnly: true },
	{ method: 'account.updateMemberRole', category: 'Account', mode: 'skip', skipReason: 'Destructive: would change member permissions', saasOnly: true },
	{ method: 'account.removeMember', category: 'Account', mode: 'skip', skipReason: 'Destructive: would remove org member', saasOnly: true },
	{ method: 'account.resendInvite', category: 'Account', mode: 'skip', skipReason: 'Destructive: would resend invitation email', saasOnly: true },
	{ method: 'account.listTeams', category: 'Account', mode: 'happy', saasOnly: true },
	{ method: 'account.getTeamDetail', category: 'Account', mode: 'skip', skipReason: 'Requires specific team ID', saasOnly: true },
	{ method: 'account.createTeam', category: 'Account', mode: 'skip', skipReason: 'Destructive: would create a team', saasOnly: true },
	{ method: 'account.deleteTeam', category: 'Account', mode: 'skip', skipReason: 'Destructive: would delete a team', saasOnly: true },
	{ method: 'account.addTeamMember', category: 'Account', mode: 'skip', skipReason: 'Destructive: would add team member', saasOnly: true },
	{ method: 'account.updateTeamMemberPerms', category: 'Account', mode: 'skip', skipReason: 'Destructive: would change team permissions', saasOnly: true },
	{ method: 'account.removeTeamMember', category: 'Account', mode: 'skip', skipReason: 'Destructive: would remove team member', saasOnly: true },
	{ method: 'account.getEnvironmentKeys', category: 'Account', mode: 'happy', saasOnly: true },
	{ method: 'account.getEnv', category: 'Account', mode: 'happy', saasOnly: true },
	{ method: 'account.setEnv', category: 'Account', mode: 'skip', skipReason: 'Destructive: would overwrite env settings', saasOnly: true },

	// =========================================================================
	// BILLING (SaaS only)
	// =========================================================================
	{ method: 'billing.getDetails', category: 'Billing', mode: 'happy', saasOnly: true },
	{ method: 'billing.getProductPrices', category: 'Billing', mode: 'skip', skipReason: 'Requires Stripe integration', saasOnly: true },
	{ method: 'billing.getCreditBalance', category: 'Billing', mode: 'happy', saasOnly: true },
	{ method: 'billing.listCreditPacks', category: 'Billing', mode: 'negative', saasOnly: true },
	{ method: 'billing.getTransactions', category: 'Billing', mode: 'happy', saasOnly: true },
	{ method: 'billing.getUsageByUser', category: 'Billing', mode: 'happy', saasOnly: true },
	{ method: 'billing.getUsageByTeam', category: 'Billing', mode: 'happy', saasOnly: true },

	// =========================================================================
	// DEPLOY (SaaS only)
	// =========================================================================
	{ method: 'deploy.add', category: 'Deploy', mode: 'skip', skipReason: 'Destructive: would create a deployment', saasOnly: true },
	{ method: 'deploy.remove', category: 'Deploy', mode: 'skip', skipReason: 'Destructive: would delete a deployment', saasOnly: true },
	{ method: 'deploy.list', category: 'Deploy', mode: 'happy', saasOnly: true },
	{ method: 'deploy.status', category: 'Deploy', mode: 'skip', skipReason: 'Requires existing deployment ID', saasOnly: true },
	{ method: 'deploy.update', category: 'Deploy', mode: 'skip', skipReason: 'Destructive: would modify a deployment', saasOnly: true },

	// =========================================================================
	// SERVICES
	// =========================================================================
	{ method: 'getServices', category: 'Services', mode: 'happy' },
	{ method: 'getService', category: 'Services', mode: 'happy' },

	// =========================================================================
	// PROFILING
	// =========================================================================
	{ method: 'cprofileStart', category: 'Profiling', mode: 'happy' },
	{ method: 'cprofileStop', category: 'Profiling', mode: 'happy' },
	{ method: 'cprofileStatus', category: 'Profiling', mode: 'happy' },
	{ method: 'cprofileReport', category: 'Profiling', mode: 'happy' },
	{ method: 'cprofileReportTree', category: 'Profiling', mode: 'happy' },

	// =========================================================================
	// DATABASE
	// =========================================================================
	{ method: 'database.query', category: 'Database', mode: 'skip', skipReason: 'Requires pipeline with database node' },
	{ method: 'database.dialect', category: 'Database', mode: 'skip', skipReason: 'Requires pipeline with database node' },

	// =========================================================================
	// TOOL
	// =========================================================================
	{ method: 'tool', category: 'Tool', mode: 'skip', skipReason: 'Requires pipeline with @tool_function node' },
];
