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
 * Connection Tree Provider for Connection Management
 * 
 * Displays real-time connection status including:
 * - Connection state and mode information
 * - Service health indicators
 * - Configuration status
 * - Connection controls
 * 
 * Listens to ConnectionManager events and provides interactive
 * connection management through tree view interface.
 */

import * as vscode from 'vscode';
import { ConfigManager, ConfigManagerInfo } from '../config';
import { ConnectionManager } from '../connection/connection';
import { ConnectionStatus, ConnectionState } from '../shared/types';

export class SidebarConnectionProvider implements vscode.TreeDataProvider<ConnectionItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<ConnectionItem | undefined | null | void> = new vscode.EventEmitter<ConnectionItem | undefined | null | void>();
	readonly onDidChangeTreeData: vscode.Event<ConnectionItem | undefined | null | void> = this._onDidChangeTreeData.event;

	private connectionState: ConnectionStatus | null = null;
	private config: ConfigManagerInfo | null = null;
	private hasApiKey: boolean = false;
	private disposables: vscode.Disposable[] = [];

	private connectionManager = ConnectionManager.getInstance();
	private configManager = ConfigManager.getInstance();

	/**
	 * Creates a new SidebarConnectionProvider
	 * 
	 * @param context VS Code extension context for command registration
	 */
	constructor(private context: vscode.ExtensionContext) {
		this.setupEventListeners();
		this.registerCommands();
		this.initializeData();
	}

	/**
	 * Initialize connection data asynchronously
	 */
	private async initializeData(): Promise<void> {
		try {
			this.connectionState = this.connectionManager.getConnectionStatus();
			this.config = this.configManager.getConfig();
			this.hasApiKey = this.configManager.hasApiKey();
			this.refresh();
		} catch (error: unknown) {
			console.error('Failed to initialize connection data:', error);
		}
	}

	/**
	 * Registers all commands handled by this provider
	 */
	private registerCommands(): void {
		const commands = [
			// Connection commands
			vscode.commands.registerCommand('rocketride.sidebar.connection.connect', async () => {
				try {
					await this.connectionManager.connect();
				} catch {
					// Error handling is done through event listeners
				}
			}),

			vscode.commands.registerCommand('rocketride.sidebar.connection.disconnect', async () => {
				try {
					await this.connectionManager.disconnect();
				} catch {
					// Error handling is done through event listeners
				}
			}),

			vscode.commands.registerCommand('rocketride.sidebar.connection.reconnect', async () => {
				try {
					await this.connectionManager.reconnect();
					vscode.window.showInformationMessage('Reconnected to RocketRide');
				} catch {
					// Error handling is done through event listeners
				}
			}),

			vscode.commands.registerCommand('rocketride.sidebar.connection.testConnection', async () => {
				try {
					vscode.window.showInformationMessage('Testing connection...');
					await this.connectionManager.connect();

					if (this.connectionManager.isConnected()) {
						vscode.window.showInformationMessage('✅ Connection test successful!');
					} else {
						vscode.window.showErrorMessage('❌ Connection test failed');
					}
				} catch (error: unknown) {
					vscode.window.showErrorMessage(`Connection test failed: ${error}`);
				}
			}),

			// Settings command
			vscode.commands.registerCommand('rocketride.sidebar.connection.openSettings', () => {
				vscode.commands.executeCommand('rocketride.page.settings.open');
			})
		];

		// Store disposables and add to context subscriptions
		this.disposables.push(...commands);
		commands.forEach(command => this.context.subscriptions.push(command));
	}

	/**
	 * Sets up ConnectionManager event listeners
	 */
	private setupEventListeners(): void {
		// Listen for connection state changes
		const connectionStateListener = this.connectionManager.on('connectionStateChanged', () => {
			this.updateConnectionData();
		});

		const connectedListener = this.connectionManager.on('connected', () => {
			this.updateConnectionData();
		});

		const errorListener = this.connectionManager.on('error', (_error) => {
			this.updateConnectionData();
		});

		// Listen for config changes
		const configChangeListener = vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('rocketride')) {
				this.updateConnectionData();
			}
		});

		this.disposables.push(
			connectionStateListener,
			connectedListener,
			errorListener,
			configChangeListener
		);
	}

	/**
	 * Updates connection data and refreshes the tree
	 */
	private async updateConnectionData(): Promise<void> {
		try {
			this.connectionState = this.connectionManager.getConnectionStatus();
			this.config = this.configManager.getConfig();
			this.hasApiKey = this.configManager.hasApiKey();
			this.refresh();
		} catch (error: unknown) {
			console.error('Failed to update connection data:', error);
		}
	}

	/**
	 * Refreshes the tree view
	 */
	public refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	/**
	 * Returns tree item representation
	 */
	getTreeItem(element: ConnectionItem): vscode.TreeItem {
		return element;
	}

	/**
	 * Returns child items for tree structure
	 */
	async getChildren(element?: ConnectionItem): Promise<ConnectionItem[]> {
		if (!element) {
			return this.getRootItems();
		}
		return [];
	}

	/**
	 * Generates root tree items
	 */
	private async getRootItems(): Promise<ConnectionItem[]> {
		const items: ConnectionItem[] = [];

		// Ensure we have current data
		if (!this.connectionState || !this.config) {
			await this.updateConnectionData();
		}

		const connectionState = this.connectionState!;
		const config = this.config!;
		const needsApiKeySetup = (config.connectionMode === 'cloud' || config.connectionMode === 'onprem') && !this.hasApiKey;

		// API Key Setup Warning (FIRST LINE if needed)
		if (needsApiKeySetup) {
			const warningItem = new ConnectionItem(
				'⚠️ Setup API Key Required!',
				vscode.TreeItemCollapsibleState.None,
				'warning'
			);
			warningItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
			warningItem.tooltip = 'API Key must be configured for Cloud or On-prem connection';
			warningItem.command = {
				command: 'rocketride.sidebar.connection.openSettings',
				title: 'Setup API Key',
				arguments: []
			};
			items.push(warningItem);

			// Blank line after warning
			const blankLine1 = new ConnectionItem(
				'',
				vscode.TreeItemCollapsibleState.None,
				'spacer'
			);
			items.push(blankLine1);
		}

		// Connection Status
		const statusItem = new ConnectionItem(
			this.getStatusLabel(connectionState),
			vscode.TreeItemCollapsibleState.None,
			'status'
		);

		statusItem.iconPath = this.getStatusIcon(connectionState);
		statusItem.tooltip = this.getStatusTooltip(connectionState, config, this.hasApiKey);
		items.push(statusItem);

		// Show last error if present
		if (connectionState.lastError && this.isConnectingState(connectionState.state)) {
			const errorItem = new ConnectionItem(
				connectionState.lastError,
				vscode.TreeItemCollapsibleState.None,
				'error-detail'
			);
			errorItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
			items.push(errorItem);
		}

		// Show detail line during connecting states: progressMessage or state-based fallback
		if (this.isConnectingState(connectionState.state)) {
			const detail = connectionState.progressMessage || this.getStateDetail(connectionState);
			if (detail) {
				const progressItem = new ConnectionItem(
					detail,
					vscode.TreeItemCollapsibleState.None,
					'progress-detail'
				);
				items.push(progressItem);
			}
		}

		// Blank line after status/retry info
		const blankLine2 = new ConnectionItem(
			'',
			vscode.TreeItemCollapsibleState.None,
			'spacer'
		);
		items.push(blankLine2);

		// Connect/Disconnect Button (with leading spaces for indentation)
		if (connectionState.state === 'connected') {
			const disconnectItem = new ConnectionItem(
				'          [ Disconnect ]',
				vscode.TreeItemCollapsibleState.None,
				'disconnect'
			);
			disconnectItem.command = {
				command: 'rocketride.sidebar.connection.disconnect',
				title: 'Disconnect',
				arguments: []
			};
			disconnectItem.tooltip = 'Click to disconnect from the server';
			items.push(disconnectItem);

		} else if (this.isConnectingState(connectionState.state)) {
			// Show placeholder during any connecting state to maintain consistent spacing
			const placeholderItem = new ConnectionItem(
				'',
				vscode.TreeItemCollapsibleState.None,
				'placeholder'
			);
			items.push(placeholderItem);

		} else {
			// status === 'disconnected'
			const connectItem = new ConnectionItem(
				'          [ Connect ]',
				vscode.TreeItemCollapsibleState.None,
				'connect'
			);
			connectItem.command = {
				command: 'rocketride.sidebar.connection.connect',
				title: 'Connect',
				arguments: []
			};
			connectItem.tooltip = needsApiKeySetup ?
				'Setup API Key first before connecting' :
				'Click to connect to the server';
			items.push(connectItem);
		}

		// Settings Button (with leading spaces for indentation)
		const settingsItem = new ConnectionItem(
			'          [ Settings ]',
			vscode.TreeItemCollapsibleState.None,
			'settings'
		);
		settingsItem.command = {
			command: 'rocketride.sidebar.connection.openSettings',
			title: 'Open Settings',
			arguments: []
		};
		settingsItem.tooltip = 'Click to open the full settings page';
		items.push(settingsItem);

		return items;
	}

	/**
	 * Check if the status represents any connecting state
	 */
	private isConnectingState(status: ConnectionState): boolean {
		return status === ConnectionState.DOWNLOADING_ENGINE ||
			status === ConnectionState.STARTING_ENGINE ||
			status === ConnectionState.CONNECTING ||
			status === ConnectionState.STOPPING_ENGINE;
	}

	/**
	 * Returns a detail string describing what is happening in the current state
	 */
	private getStateDetail(connectionState: ConnectionStatus): string {
		switch (connectionState.state) {
			case 'downloading-engine':
				return 'Downloading server...';
			case 'starting-engine':
				return 'Starting server...';
			case 'connecting':
				if (connectionState.retryAttempt > 0) {
					return 'Retrying...';
				}
				return 'Connecting to server...';
			case 'stopping-engine':
				return 'Stopping server...';
			case 'engine-startup-failed':
				return connectionState.lastError ?? 'Error starting local engine';
			default:
				return '';
		}
	}

	/**
	 * Generates status label with animated dots for connecting states
	 */
	private getStatusLabel(connectionState: ConnectionStatus): string {
		// Generate animated dots based on retry attempt - always 3 characters for consistent width
		const getConnectingDots = (retryAttempt: number): string => {
			const phase = retryAttempt % 4;
			switch (phase) {
				case 0: return '   '; // 3 spaces
				case 1: return '.  '; // 1 dot + 2 spaces
				case 2: return '.. '; // 2 dots + 1 space
				case 3: return '...'; // 3 dots
				default: return '...';
			}
		};

		switch (connectionState.state) {
			case 'connected':
				return 'Connected';

			case 'downloading-engine':
			case 'starting-engine':
			case 'connecting':
			case 'stopping-engine': {
				const connectingDots = getConnectingDots(connectionState.retryAttempt);
				return `Connecting${connectingDots}`;
			}

			case 'disconnected':
			case 'engine-startup-failed':
			default:
				return 'Disconnected';
		}
	}

	/**
	 * Gets appropriate icon for connection state
	 */
	private getStatusIcon(connectionState: ConnectionStatus): vscode.ThemeIcon {
		switch (connectionState.state) {
			case 'connected':
				return new vscode.ThemeIcon('check-all', new vscode.ThemeColor('charts.green'));

			case 'downloading-engine':
			case 'starting-engine':
			case 'connecting':
			case 'stopping-engine':
				return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.yellow'));

			case 'disconnected':
			case 'engine-startup-failed':
			default:
				return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.red'));
		}
	}

	/**
	 * Generates detailed tooltip for connection state
	 */
	private getStatusTooltip(connectionState: ConnectionStatus, config: ConfigManagerInfo, hasApiKey: boolean): string {
		switch (connectionState.state) {
			case 'connected':
				return `Successfully connected to ${config.hostUrl} in ${connectionState.connectionMode} mode`;

			case 'downloading-engine':
				return 'Downloading RocketRide server from GitHub releases...';

			case 'starting-engine':
				return 'Starting local RocketRide server...';

			case 'connecting':
				if (connectionState.connectionMode === 'local') {
					if (connectionState.retryAttempt > 0) {
						return 'Server started, retrying connection...';
					}
					return 'Server started, connecting...';
				} else {
					if (connectionState.retryAttempt > 0) {
						return 'Retrying connection...';
					}
					return 'Connecting to server...';
				}

			case 'stopping-engine':
				return 'Stopping local RocketRide server...';

			case 'disconnected':
			case 'engine-startup-failed':
			default:
				// Handle various disconnected reasons
				if (connectionState.lastError) {
					return `Disconnected: ${connectionState.lastError}`;
				} else if ((connectionState.connectionMode === 'cloud' || connectionState.connectionMode === 'onprem') && !hasApiKey) {
					return 'Not connected - API key required';
				} else if (!connectionState.hasCredentials) {
					return `Not connected - ${connectionState.connectionMode} configuration required`;
				} else if (!config.hostUrl) {
					return 'Not connected - server URL not configured';
				} else {
					return 'Not connected - click Connect to establish connection';
				}
		}
	}

	/**
	 * Checks if there's any connection data to display
	 */
	public hasData(): boolean {
		return this.connectionState !== null;
	}

	/**
	 * Cleans up event listeners and resources
	 */
	public dispose(): void {
		this.disposables.forEach(disposable => disposable.dispose());
		this.disposables = [];
	}
}

class ConnectionItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly itemType: string
	) {
		super(label, collapsibleState);
		this.contextValue = itemType;
	}
}