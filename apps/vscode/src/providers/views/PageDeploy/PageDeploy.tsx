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
	| { type: 'init'; rocketrideLogoDarkUri?: string; rocketrideLogoLightUri?: string; dockerIconUri?: string; onpremIconUri?: string };

type PageDeployOutgoingMessage = { type: 'ready' } | { type: 'copyToClipboard'; text: string } | { type: 'dockerRun' };

export const PageDeploy: React.FC = () => {
	const [logoDarkUri, setLogoDarkUri] = useState<string | undefined>();
	const [logoLightUri, setLogoLightUri] = useState<string | undefined>();
	const [dockerUri, setDockerUri] = useState<string | undefined>();
	const [onpremUri, setOnpremUri] = useState<string | undefined>();

	const { sendMessage } = useMessaging<PageDeployOutgoingMessage, PageDeployIncomingMessage>({
		onMessage: (message) => {
			if (message.type === 'init') {
				if (message.rocketrideLogoDarkUri) setLogoDarkUri(message.rocketrideLogoDarkUri);
				if (message.rocketrideLogoLightUri) setLogoLightUri(message.rocketrideLogoLightUri);
				if (message.dockerIconUri) setDockerUri(message.dockerIconUri);
				if (message.onpremIconUri) setOnpremUri(message.onpremIconUri);
			}
		}
	});

	useEffect(() => {
		sendMessage({ type: 'ready' });
	}, [sendMessage]);

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
						<h1 className="deploy-panel-title">Docker</h1>
						<p className="deploy-panel-description">
							Pull and run the RocketRide engine container. Requires Docker to be installed.
						</p>
						<div className="deploy-panel-actions">
							<button
								type="button"
								className="deploy-panel-btn deploy-panel-btn-primary"
								onClick={() => sendMessage({ type: 'dockerRun' })}
							>
								Run engine
							</button>
						</div>
						<details className="deploy-panel-details">
							<summary>Show commands</summary>
							<div className="deploy-panel-commands">
								<pre className="deploy-panel-code"><code>{`docker run -p 5565:5565 ghcr.io/rocketride-org/rocketride-engine:latest`}</code></pre>
								<button
									type="button"
									className="deploy-panel-copy"
									onClick={() => sendMessage({ type: 'copyToClipboard', text: 'docker run -p 5565:5565 ghcr.io/rocketride-org/rocketride-engine:latest' })}
								>
									Copy run command
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
