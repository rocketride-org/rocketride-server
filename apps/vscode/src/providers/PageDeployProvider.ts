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
 * Deploy Page Provider
 *
 * Provides a webview panel for the Deploy page: deploy to RocketRide.ai cloud
 * or on-prem using Docker.
 */

import * as vscode from 'vscode';
import * as path from 'path';

export class PageDeployProvider {
	private webviewPanel?: vscode.WebviewPanel;
	private disposables: vscode.Disposable[] = [];

	constructor(private context: vscode.ExtensionContext) {
		this.registerCommands();
	}

	private registerCommands(): void {
		const commands = [
			vscode.commands.registerCommand('rocketride.page.deploy.open', async () => {
				await this.show();
			}),
			vscode.commands.registerCommand('rocketride.page.deploy.close', () => {
				this.close();
			})
		];
		commands.forEach(c => this.context.subscriptions.push(c));
	}

	public async show(): Promise<void> {
		if (this.webviewPanel) {
			this.webviewPanel.reveal(vscode.ViewColumn.One);
			return;
		}

		this.webviewPanel = vscode.window.createWebviewPanel(
			'rocketrideDeploy',
			'Deploy',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.file(path.join(this.context.extensionPath, 'dist')),
					vscode.Uri.file(path.join(this.context.extensionPath, 'webview')),
					this.context.extensionUri
				]
			}
		);

		this.webviewPanel.webview.html = this.getHtmlForWebview(this.webviewPanel.webview);

		this.webviewPanel.webview.onDidReceiveMessage(
			async (message: { type: string; text?: string }) => {
				if (message.type === 'ready') {
					await this.sendInit();
				} else if (message.type === 'copyToClipboard' && typeof message.text === 'string') {
					await vscode.env.clipboard.writeText(message.text);
					vscode.window.showInformationMessage('Copied to clipboard.');
				} else if (message.type === 'dockerBuild') {
					await this.runDockerBuild();
				} else if (message.type === 'dockerSave') {
					await this.runDockerSave();
				} else if (message.type === 'dockerExportScript') {
					await this.exportRunScript();
				}
			},
			undefined,
			this.disposables
		);

		this.webviewPanel.onDidDispose(
			() => {
				this.webviewPanel = undefined;
			},
			null,
			this.disposables
		);
	}

	private getWorkspaceRoot(): string | null {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) return null;
		return folders[0].uri.fsPath;
	}

	private async runDockerBuild(): Promise<void> {
		const root = this.getWorkspaceRoot();
		if (!root) {
			vscode.window.showErrorMessage('Open a workspace folder (your project root) to build the Docker image.');
			return;
		}
		const term = vscode.window.createTerminal({
			name: 'RocketRide Docker Build',
			cwd: root,
			hideFromUser: false
		});
		term.show();
		term.sendText('docker build -f docker/Dockerfile.engine -t rocketride-engine .');
		vscode.window.showInformationMessage('Docker build started in terminal. When it finishes, use "Save image to file" or run the container locally.');
	}

	private async runDockerSave(): Promise<void> {
		const root = this.getWorkspaceRoot();
		if (!root) {
			vscode.window.showErrorMessage('Open a workspace folder to save the image.');
			return;
		}
		const tarPath = path.join(root, 'rocketride-engine.tar');
		const term = vscode.window.createTerminal({
			name: 'RocketRide Docker Save',
			cwd: root,
			hideFromUser: false
		});
		term.show();
		term.sendText(`docker save rocketride-engine -o "${tarPath}"`);
		vscode.window.showInformationMessage(
			'Saving image in terminal. When done, copy rocketride-engine.tar to your server and run: docker load -i rocketride-engine.tar && docker run -p 8080:8080 rocketride-engine'
		);
	}

	private async exportRunScript(): Promise<void> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			vscode.window.showErrorMessage('Open a workspace folder to create the run script.');
			return;
		}
		const rootUri = folders[0].uri;
		const runSh = `#!/bin/sh
# Build and run RocketRide engine on your server (copy this repo to the server first)
set -e
docker build -f docker/Dockerfile.engine -t rocketride-engine .
docker run -p 8080:8080 rocketride-engine
`;
		const runPs1 = `# Build and run RocketRide engine on your server (copy this repo to the server first)
docker build -f docker/Dockerfile.engine -t rocketride-engine .
docker run -p 8080:8080 rocketride-engine
`;
		try {
			await vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(rootUri, 'run-rocketride.sh'),
				Buffer.from(runSh, 'utf8')
			);
			await vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(rootUri, 'run-rocketride.ps1'),
				Buffer.from(runPs1, 'utf8')
			);
			vscode.window.showInformationMessage(
				'Created run-rocketride.sh and run-rocketride.ps1 in your workspace. Copy the repo to your server and run one of them.'
			);
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to create run script: ${String(e)}`);
		}
	}

	private async sendInit(): Promise<void> {
		if (!this.webviewPanel) return;

		const webview = this.webviewPanel.webview;
		const logoDarkUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'rocketride-dark-icon.png')
		);
		const logoLightUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'rocketride-light-icon.png')
		);
		const dockerUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'static', 'docker.svg')
		);
		const onpremUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'static', 'onprem.svg')
		);

		webview.postMessage({
			type: 'init',
			rocketrideLogoDarkUri: logoDarkUri.toString(),
			rocketrideLogoLightUri: logoLightUri.toString(),
			dockerIconUri: dockerUri.toString(),
			onpremIconUri: onpremUri.toString()
		});
	}

	public close(): void {
		if (this.webviewPanel) {
			this.webviewPanel.dispose();
		}
	}

	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-deploy.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');
			htmlContent = htmlContent
				.replace(/\{\{nonce\}\}/g, nonce)
				.replace(/\{\{cspSource\}\}/g, webview.cspSource);

			return htmlContent.replace(
				/(?:src|href)="(\/static\/[^"]+)"/g,
				(match: string, relativePath: string): string => {
					const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
					const resourceUri = webview.asWebviewUri(
						vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath)
					);
					return match.replace(relativePath, resourceUri.toString());
				}
			);
		} catch (error) {
			return `<!DOCTYPE html><html><body><h1>Deploy page failed to load</h1><p>${String(error)}</p><p>Expected: ${htmlPath.fsPath}</p></body></html>`;
		}
	}

	private generateNonce(): string {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}

	public dispose(): void {
		this.close();
		this.disposables.forEach(d => d.dispose());
		this.disposables = [];
	}
}
