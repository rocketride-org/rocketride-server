// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * adapter.ts - Updated Debug Adapter Factory and Registration for RocketRide VS Code Extension
 * 
 * This updated version uses the persistent connection manager instead of creating
 * connections per debug session.
 */

import * as vscode from 'vscode';
import { getLogger } from '../shared/util/output';
import { RocketRideDebugAdapter } from './session';
import { icons } from '../shared/util/icons';

/**
 * Simplified Debug Adapter Factory that uses persistent connection
 */
export class RocketRideDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
	async createDebugAdapterDescriptor(
		session: vscode.DebugSession
	): Promise<vscode.DebugAdapterDescriptor> {
		const logger = getLogger();

		logger.output(`${icons.begin} Creating debug adapter (persistent connection mode)...`);

		// Create adapter with simplified configuration
		const config = { ...session.configuration };
		const adapter = new RocketRideDebugAdapter(config);

		// Connect using the persistent connection
		await adapter.connect(session);

		logger.output(`${icons.success} Debug adapter ready`);

		return new vscode.DebugAdapterInlineImplementation(adapter);
	}
}

/**
 * Updated registration function that doesn't create connection-specific resources
 */
export function registerDebugger(context: vscode.ExtensionContext) {
	const logger = getLogger();

	// Create and register the debug adapter factory
	const factory = new RocketRideDebugAdapterDescriptorFactory();
	const disposable = vscode.debug.registerDebugAdapterDescriptorFactory('rocketride', factory);

	// Register debug configuration providers (simplified)
	const configProvider = vscode.debug.registerDebugConfigurationProvider('rocketride', {
		resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): vscode.DebugConfiguration {
			// Remove connection-specific config as it's now in settings
			delete config.connect;
			delete config.host;
			delete config.port;
			delete config.apikey;

			return config;
		},

		provideDebugConfigurations(_folder: vscode.WorkspaceFolder | undefined): vscode.DebugConfiguration[] {
			return [
				{
					type: 'rocketride',
					request: 'launch',
					name: 'RocketRide: Launch Pipeline',
					file: '${file}'
				},
				{
					type: 'rocketride',
					request: 'attach',
					name: 'RocketRide: Attach to Pipeline',
					token: '${input:token}'
				}
			];
		}
	});

	const initialConfigProvider = vscode.debug.registerDebugConfigurationProvider('rocketride', {
		provideDebugConfigurations(_folder: vscode.WorkspaceFolder | undefined): vscode.DebugConfiguration[] {
			return [
				{
					name: 'Launch RocketRide Pipeline',
					type: 'rocketride',
					request: 'launch',
					file: '${file}'
				}
			];
		}
	}, vscode.DebugConfigurationProviderTriggerKind.Dynamic);

	// Breakpoint change monitoring (same as before)
	const onDidChangeBreakpoints = vscode.debug.onDidChangeBreakpoints(_e => {
		// Handle breakpoint changes - implementation stays the same
		// This could also notify the connection manager about breakpoint changes
	});

	context.subscriptions.push(
		disposable,
		configProvider,
		initialConfigProvider,
		onDidChangeBreakpoints
	);

	logger.output(`${icons.success} Debug adapter registered`);
}
