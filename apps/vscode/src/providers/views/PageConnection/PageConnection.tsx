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

import React, { useState, useEffect } from 'react';
import { useMessaging } from '../../../shared/util/useMessaging';

// Import the styles
import '../../styles/vscode.css'
import '../../styles/app.css';
import './styles.css';

interface ConnectionState {
	state: 'connected' | 'connecting' | 'downloading-engine' | 'starting-engine' | 'stopping-engine' | 'disconnected';
	connectionMode: 'cloud' | 'onprem' | 'local';
	retryAttempt: number;
	maxRetryAttempts: number;
	lastError?: string;
	hasCredentials: boolean;
	progressMessage?: string;
}

interface Config {
	hostUrl: string;
	connectionMode: 'cloud' | 'onprem' | 'local';
	autoConnect: boolean;
}

interface ConnectionData {
	connectionState: ConnectionState;
	config: Config;
	hasApiKey: boolean;
}

type PageConnectionIncomingMessage = {
	type: 'connectionUpdate';
	data: ConnectionData;
};

type PageConnectionOutgoingMessage =
	| { type: 'ready' }
	| { type: 'connect' }
	| { type: 'disconnect' }
	| { type: 'reconnect' }
	| { type: 'openSettings' }
	| { type: 'openDocs' }
	| { type: 'openDeploy' }
	| { type: 'openSystemPerformance' };

export const PageConnection: React.FC = () => {
	const [connectionData, setConnectionData] = useState<ConnectionData | null>(null);
	const [animationPhase, setAnimationPhase] = useState(0);

	const { sendMessage } = useMessaging<PageConnectionOutgoingMessage, PageConnectionIncomingMessage>({
		onMessage: (message) => {
			if (message.type === 'connectionUpdate') {
				setConnectionData(message.data);
			}
		}
	});

	// Animate connecting dots
	useEffect(() => {
		const isConnecting = connectionData?.connectionState.state === 'connecting' ||
			connectionData?.connectionState.state === 'downloading-engine' ||
			connectionData?.connectionState.state === 'starting-engine';

		if (isConnecting) {
			const interval = setInterval(() => {
				setAnimationPhase((prev) => (prev + 1) % 4);
			}, 500);
			return () => clearInterval(interval);
		}
	}, [connectionData?.connectionState.state]);

	const getAnimatedDots = (): string => {
		switch (animationPhase) {
			case 0: return '';
			case 1: return '.';
			case 2: return '..';
			case 3: return '...';
			default: return '';
		}
	};

	const getStatusLabel = (): string => {
		if (!connectionData) return 'Loading...';

		const { state, connectionMode } = connectionData.connectionState;
		const modeLabel = connectionMode === 'onprem' ? 'On-prem' : connectionMode === 'cloud' ? 'Cloud' : 'Local';

		switch (state) {
			case 'connected':
				return `Connected (${modeLabel})`;
			case 'downloading-engine':
				return `Downloading Engine${getAnimatedDots()}`;
			case 'starting-engine':
				return `Starting Engine${getAnimatedDots()}`;
			case 'connecting':
				return `Connecting${getAnimatedDots()}`;
			case 'stopping-engine':
				return 'Stopping Engine...';
			case 'disconnected':
			default:
				return 'Disconnected';
		}
	};

	const getStatusClass = (): string => {
		if (!connectionData) return 'status-loading';

		switch (connectionData.connectionState.state) {
			case 'connected':
				return 'status-connected';
			case 'downloading-engine':
			case 'starting-engine':
			case 'connecting':
			case 'stopping-engine':
				return 'status-connecting';
			case 'disconnected':
			default:
				return 'status-disconnected';
		}
	};

	const getStatusIcon = (): string => {
		if (!connectionData) return '○';

		switch (connectionData.connectionState.state) {
			case 'connected':
				return '✓';
			case 'downloading-engine':
			case 'starting-engine':
			case 'connecting':
			case 'stopping-engine':
				return '◷';
			case 'disconnected':
			default:
				return '○';
		}
	};

	/** Single line for status detail: "" -> "Fetching..." -> "No release info." (or short error). Keeps layout stable. */
	const getStatusDetailLine = (): string => {
		if (!connectionData) return '';
		const { lastError, progressMessage } = connectionData.connectionState;
		const connecting = isConnecting;
		if (connecting && progressMessage) return progressMessage;
		if (connecting && lastError) {
			const lower = lastError.toLowerCase();
			if (lower.includes('rate limit') || lower.includes('github')) return 'No release info.';
			return lastError.length > 40 ? lastError.slice(0, 37) + '...' : lastError;
		}
		return '';
	};

	const handleConnect = () => {
		sendMessage({ type: 'connect' });
	};

	const handleDisconnect = () => {
		sendMessage({ type: 'disconnect' });
	};

	const handleOpenSettings = () => {
		sendMessage({ type: 'openSettings' });
	};

	const handleOpenDocs = () => {
		sendMessage({ type: 'openDocs' });
	};

	const handleOpenSystemPerformance = () => {
		sendMessage({ type: 'openSystemPerformance' });
	};

	const isConnecting = connectionData?.connectionState.state === 'connecting' ||
		connectionData?.connectionState.state === 'downloading-engine' ||
		connectionData?.connectionState.state === 'starting-engine' ||
		connectionData?.connectionState.state === 'stopping-engine';

	const isConnected = connectionData?.connectionState.state === 'connected';
	const needsApiKeySetup = (connectionData?.config.connectionMode === 'cloud' || connectionData?.config.connectionMode === 'onprem') && !connectionData?.hasApiKey;

	return (
		<div className="connection-container">
			<div className="connection-view">
				{needsApiKeySetup && (
					<div className="warning-banner">
						<div className="warning-icon">⚠️</div>
						<div className="warning-content">
							<div className="warning-title">Setup Required</div>
							<div className="warning-message">API Key must be configured for cloud mode</div>
						</div>
					</div>
				)}

				<div className="status-card">
					<div className={`status-indicator ${getStatusClass()}`}>
						<span className="status-icon">{getStatusIcon()}</span>
					</div>
					<div className="status-text">
						<div className="status-label">{getStatusLabel()}</div>
						<div className="status-detail" title={connectionData?.connectionState.lastError || undefined}>
							{getStatusDetailLine()}
						</div>
					</div>
				</div>

				<div className="connection-info">
					<div className="info-row">
						<span className="info-label">Server:</span>
						<span className="info-value">{connectionData?.config.hostUrl || 'N/A'}</span>
					</div>
				</div>

				<div className="action-buttons">
					{isConnected ? (
						<button
							className="btn btn-secondary"
							onClick={handleDisconnect}
							disabled={isConnecting}
						>
							Disconnect
						</button>
					) : (
						<button
							className="btn btn-primary"
							onClick={handleConnect}
							disabled={isConnecting || needsApiKeySetup}
						>
							{isConnecting ? 'Connecting...' : 'Connect'}
						</button>
					)}
			<button
				className="btn btn-secondary"
				onClick={handleOpenSettings}
			>
				Settings
			</button>
			<button
				className="btn btn-secondary"
				onClick={() => sendMessage({ type: 'openDeploy' })}
				title="Deploy to RocketRide.ai cloud or on-prem"
			>
				Deploy
			</button>
			<button
				className="btn btn-secondary"
				onClick={handleOpenSystemPerformance}
				disabled={!isConnected}
				title="View system performance metrics and resource utilization"
			>
				System Performance
			</button>
			<button
				className="btn btn-secondary"
				onClick={handleOpenDocs}
				title="View RocketRide API documentation and integration guide"
			>
				Documentation
			</button>
		</div>
		</div>
	</div>
	);
};
