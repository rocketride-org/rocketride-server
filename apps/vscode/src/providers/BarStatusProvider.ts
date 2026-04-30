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
 * Status Bar Provider for Extension Status Display
 *
 * Manages the VS Code status bar item to display connection status, errors, and actions.
 * Provides visual feedback for extension state and clickable actions for users.
 *
 * Features:
 * - Connection status display with mode indicators
 * - Visual state changes with appropriate icons and colors
 * - Clickable actions based on current state
 * - Error state handling with helpful tooltips
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/connection';
import { ConnectionStatus, ConnectionState } from '../shared/types';

export class BarStatus {
	private statusBarItem: vscode.StatusBarItem;
	private disposables: vscode.Disposable[] = [];
	private connectionManager: ConnectionManager | undefined;

	/**
	 * Creates a new BarStatus provider
	 *
	 * @param context VS Code extension context for command registration
	 */
	constructor(private context: vscode.ExtensionContext) {
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		this.statusBarItem.text = '$(loading~spin) RocketRide: Initializing...';
		this.statusBarItem.show();

		this.registerCommands();
		// Don't setup event listeners immediately - wait for connection manager to be ready
	}

	/**
	 * Initializes connection to the connection manager and sets up event listeners
	 * This should be called after the connection manager is created
	 */
	public initializeConnectionManager(): void {
		try {
			const { getConnectionManager } = require('../extension');
			this.connectionManager = getConnectionManager();

			if (this.connectionManager) {
				this.setupEventListeners();
			} else {
				console.warn('[BarStatus] Connection manager not available yet');
			}
		} catch (error) {
			console.warn('[BarStatus] Could not access connection manager:', error);
		}
	}

	/**
	 * Registers commands handled by this provider
	 */
	private registerCommands(): void {
		const commands = [
			vscode.commands.registerCommand('rocketride.statusBar.refresh', () => {
				this.updateStatus();
			}),

			vscode.commands.registerCommand('rocketride.statusBar.showDetails', () => {
				this.showStatusDetails();
			}),
		];

		// Store disposables and add to context subscriptions
		this.disposables.push(...commands);
		commands.forEach((command) => this.context.subscriptions.push(command));
	}

	/**
	 * Sets up connection manager event listeners
	 */
	private setupEventListeners(): void {
		if (!this.connectionManager) {
			console.warn('[BarStatus] No connection manager available for event listeners');
			return;
		}

		try {
			const statusListener = this.connectionManager.on('connectionStateChanged', (status: ConnectionStatus) => {
				this.handleConnectionStatusChange(status);
			});

			this.disposables.push(statusListener);
		} catch {
			// Ignore any error
		}
	}

	/**
	 * Handles connection status changes and updates status bar accordingly
	 */
	private handleConnectionStatusChange(status: ConnectionStatus): void {
		if (status.state === ConnectionState.CONNECTED) {
			const modeLabel: Record<string, string> = { cloud: 'Cloud', docker: 'Docker', service: 'Service', onprem: 'On-prem', local: 'Local' };
			this.statusBarItem.text = `$(debug-console) RocketRide: Connected (${modeLabel[status.connectionMode] || status.connectionMode})`;
			this.statusBarItem.command = 'rocketride.sidebar.connection.disconnect';
			this.statusBarItem.tooltip = 'Connected - Click to disconnect';
			this.statusBarItem.backgroundColor = undefined;
			vscode.commands.executeCommand('setContext', 'rocketride.connected', true);
		} else if (status.state === ConnectionState.DOWNLOADING_ENGINE) {
			this.statusBarItem.text = '$(cloud-download) RocketRide: Downloading Engine...';
			this.statusBarItem.command = undefined;
			this.statusBarItem.tooltip = 'Downloading engine from GitHub...';
			this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			vscode.commands.executeCommand('setContext', 'rocketride.connected', false);
		} else if (status.state === ConnectionState.STARTING_ENGINE || status.state === ConnectionState.CONNECTING) {
			this.statusBarItem.text = '$(sync~spin) RocketRide: Connecting...';
			this.statusBarItem.command = undefined;
			this.statusBarItem.tooltip = 'Connecting to RocketRide server...';
			this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			vscode.commands.executeCommand('setContext', 'rocketride.connected', false);
		} else if (status.state === ConnectionState.AUTH_FAILED) {
			this.statusBarItem.text = '$(key) RocketRide: Sign In Required';
			this.statusBarItem.command = 'rocketride.page.auth.open';
			this.statusBarItem.tooltip = status.lastError || 'Authentication failed — click to sign in';
			this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
			vscode.commands.executeCommand('setContext', 'rocketride.connected', false);
		} else if (!status.hasCredentials && (status.connectionMode === 'cloud' || status.connectionMode === 'onprem')) {
			this.statusBarItem.text = '$(key) RocketRide: Setup Required';
			this.statusBarItem.command = 'rocketride.page.settings.open';
			this.statusBarItem.tooltip = 'Click to open settings page';
			this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			vscode.commands.executeCommand('setContext', 'rocketride.connected', false);
		} else {
			this.statusBarItem.text = '$(debug-disconnect) RocketRide: Disconnected';
			this.statusBarItem.command = 'rocketride.sidebar.connection.connect';
			this.statusBarItem.tooltip = status.lastError ? `Disconnected: ${status.lastError}` : 'Click to connect';
			this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
			vscode.commands.executeCommand('setContext', 'rocketride.connected', false);
		}
	}

	/**
	 * Sets status bar to "needs setup" state — shown before the welcome page is dismissed
	 */
	public setNeedsSetup(): void {
		this.statusBarItem.text = '$(gear) RocketRide: Setup';
		this.statusBarItem.command = 'rocketride.page.welcome.open';
		this.statusBarItem.tooltip = 'Click to open the welcome page and configure your connection';
		this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	}

	/**
	 * Sets status bar to ready state
	 */
	public setReady(): void {
		this.statusBarItem.text = '$(debug-disconnect) RocketRide: Ready';
		this.statusBarItem.command = 'rocketride.sidebar.connection.connect';
		this.statusBarItem.tooltip = 'Click to connect to RocketRide server';
		this.statusBarItem.backgroundColor = undefined;
	}

	/**
	 * Sets status bar to error state
	 */
	public setError(message: string): void {
		this.statusBarItem.text = '$(error) RocketRide: Failed';
		this.statusBarItem.tooltip = `Error: ${message}`;
		this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		this.statusBarItem.command = 'rocketride.statusBar.showDetails';
	}

	/**
	 * Sets status bar to initializing state
	 */
	public setInitializing(): void {
		this.statusBarItem.text = '$(loading~spin) RocketRide: Initializing...';
		this.statusBarItem.tooltip = 'Extension is starting up...';
		this.statusBarItem.command = undefined;
		this.statusBarItem.backgroundColor = undefined;
	}

	/**
	 * Updates the status bar display
	 */
	private updateStatus(): void {
		const connectionManager = this.getConnectionManager();
		if (connectionManager) {
			// Trigger a status update
			connectionManager.getConnectionStatus();
		}
	}

	/**
	 * Shows detailed status information
	 */
	private showStatusDetails(): void {
		const connectionManager = this.getConnectionManager();
		if (connectionManager) {
			const state = connectionManager.getConnectionStatus();
			const details = [`Status: ${state.state}`, `Mode: ${state.connectionMode}`, `Has Credentials: ${state.hasCredentials}`, state.lastError ? `Last Error: ${state.lastError}` : ''].filter(Boolean).join('\n');

			vscode.window.showInformationMessage(`RocketRide Extension Status\n\n${details}`, 'Open Settings', 'Test Connection').then((selection) => {
				switch (selection) {
					case 'Open Settings':
						vscode.commands.executeCommand('rocketride.page.settings.open');
						break;
					case 'Test Connection':
						vscode.commands.executeCommand('rocketride.sidebar.connection.testConnection');
						break;
				}
			});
		}
	}

	/**
	 * Gets the connection manager instance
	 */
	private getConnectionManager(): ConnectionManager | undefined {
		// Import at runtime to avoid circular dependency
		try {
			const { getConnectionManager } = require('../extension');
			return getConnectionManager();
		} catch (error) {
			console.warn('[BarStatus] Could not access connection manager:', error);
			return undefined;
		}
	}

	/**
	 * Shows the status bar item
	 */
	public show(): void {
		this.statusBarItem.show();
	}

	/**
	 * Hides the status bar item
	 */
	public hide(): void {
		this.statusBarItem.hide();
	}

	/**
	 * Gets the status bar item for direct access if needed
	 */
	public getStatusBarItem(): vscode.StatusBarItem {
		return this.statusBarItem;
	}

	/**
	 * Cleans up event listeners and resources
	 */
	public dispose(): void {
		this.statusBarItem.dispose();
		this.disposables.forEach((disposable) => disposable.dispose());
		this.disposables = [];
	}
}
