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

import '../../styles/vscode.css';
import '../../styles/app.css';
import './styles.css';

type PageDeployIncomingMessage =
	| { type: 'init'; rocketrideLogoDarkUri?: string; rocketrideLogoLightUri?: string; dockerIconUri?: string; onpremIconUri?: string; engineImage?: string };

type PageDeployOutgoingMessage = { type: 'ready' } | { type: 'copyToClipboard'; text: string } | { type: 'dockerDeployLocal' };

export const PageDeploy: React.FC = () => {
	const [logoDarkUri, setLogoDarkUri] = useState<string | undefined>();
	const [logoLightUri, setLogoLightUri] = useState<string | undefined>();
	const [dockerUri, setDockerUri] = useState<string | undefined>();
	const [onpremUri, setOnpremUri] = useState<string | undefined>();
	const [engineImage, setEngineImage] = useState('ghcr.io/rocketride-org/rocketride-engine:latest');
	const [deploying, setDeploying] = useState(false);

	const { sendMessage } = useMessaging<PageDeployOutgoingMessage, PageDeployIncomingMessage>({
		onMessage: (message) => {
			if (message.type === 'init') {
				if (message.rocketrideLogoDarkUri) setLogoDarkUri(message.rocketrideLogoDarkUri);
				if (message.rocketrideLogoLightUri) setLogoLightUri(message.rocketrideLogoLightUri);
				if (message.dockerIconUri) setDockerUri(message.dockerIconUri);
				if (message.onpremIconUri) setOnpremUri(message.onpremIconUri);
				if (message.engineImage) setEngineImage(message.engineImage);
			}
		}
	});

	useEffect(() => {
		sendMessage({ type: 'ready' });
	}, [sendMessage]);

	const remoteCommands = `docker pull ${engineImage}\ndocker create --name rocketride-engine -p 5565:5565 ${engineImage}`;

	return (
		<div className="deploy-app">
			<div className="deploy-panels">
				<div className="deploy-panel deploy-panel-rocketride">
					{logoDarkUri && <img src={logoDarkUri} alt="RocketRide" className="deploy-panel-logo logo-dark" />}
					{logoLightUri && <img src={logoLightUri} alt="RocketRide" className="deploy-panel-logo logo-light" />}
					<div className="deploy-panel-content">
						<h1 className="deploy-panel-title">RocketRide.ai</h1>
						<p className="deploy-panel-description">
							Deploy your pipelines to RocketRide.ai cloud or run them on your own infrastructure.
							Configure your deployment connection in Settings and use this page to deploy.
						</p>
					</div>
				</div>

				<div className="deploy-panel deploy-panel-docker">
					{dockerUri && (
						<img src={dockerUri} alt="Docker" className="deploy-panel-icon" />
					)}
					<div className="deploy-panel-content">
						<h1 className="deploy-panel-title">Deploy Image</h1>
						<p className="deploy-panel-description">
							Download the RocketRide engine image and create a container.
							Requires Docker to be installed.
						</p>
						<div className="deploy-panel-actions">
							<button
								type="button"
								className="deploy-panel-btn deploy-panel-btn-primary"
								disabled={deploying}
								onClick={() => {
									setDeploying(true);
									sendMessage({ type: 'dockerDeployLocal' });
								}}
							>
								{deploying ? 'Image deployed' : 'Deploy locally'}
							</button>
						</div>
						<details className="deploy-panel-details">
							<summary>Deploy to a remote server</summary>
							<div className="deploy-panel-commands">
								<p className="deploy-panel-description">
									Run these commands on your target server to pull the image and create a container:
								</p>
								<pre className="deploy-panel-code"><code>{remoteCommands}</code></pre>
								<button
									type="button"
									className="deploy-panel-copy"
									onClick={() => sendMessage({ type: 'copyToClipboard', text: remoteCommands })}
								>
									Copy commands
								</button>
							</div>
						</details>
					</div>
				</div>

				<div className="deploy-panel deploy-panel-onprem">
					{onpremUri && (
						<img src={onpremUri} alt="On-Premises" className="deploy-panel-icon" />
					)}
					<div className="deploy-panel-content">
						<h1 className="deploy-panel-title">On-Premises</h1>
						<p className="deploy-panel-description">
							Run the RocketRide engine on your own infrastructure. Install and manage the
							engine locally for full control and data residency.
						</p>
					</div>
				</div>
			</div>
		</div>
	);
};
