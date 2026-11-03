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
// PREVIEW SIGN-IN — a session for the App Builder preview, NOT the window
// =============================================================================
//
// The extension holds its own authenticated session (CloudAuthProvider +
// SecretStorage) that the App Builder itself runs on. The PREVIEW is a
// different principal: a developer signing the preview in is testing THEIR
// APP's sign-in, and must be able to do so — repeatedly, as any account —
// without reading, writing, or replacing the window's session.
//
// This module is that separation: its own PKCE round trip through the
// system browser with a LOOPBACK redirect (the CLI's native client — the
// registration proven for random-port 127.0.0.1 redirects), exchanged over
// a throwaway client connection. Nothing is persisted anywhere in the
// extension; the returned session key travels only down the preview's
// retained :session lane, and the preview shell keeps it frame-local.
// =============================================================================

import * as http from 'http';
import * as vscode from 'vscode';
import { RocketRideClient } from 'rocketride';
import { generatePkce, buildAuthUrl } from './pkce';
import { DEFAULT_ZITADEL_URL, DEFAULT_CLI_CLIENT_ID } from '../../../../packages/client-common/typescript/src/auth-defaults';
import { getLogger } from '../shared/util/output';

/** How long the loopback listener waits for the browser redirect. */
const PREVIEW_AUTH_TIMEOUT_MS = 5 * 60 * 1000;

/** The neutral page the browser lands on (no window to hand back to —
 *  the preview inside VS Code picks the session up on its own). */
function callbackPage(ok: boolean, detail?: string): string {
	const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	const title = ok ? 'Signed in' : 'Sign-in failed';
	const body = ok
		? 'Return to VS Code — the preview continues automatically. You can close this tab.'
		: `${esc(detail ?? 'The sign-in did not complete.')} Return to VS Code and try again.`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,'Segoe UI',sans-serif;background:#f0efe9;color:#0a0a0a}div{max-width:420px;padding:40px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{font-size:14px;line-height:1.5;color:rgba(10,10,10,0.62)}</style></head><body><div><h1>${title}</h1><p>${body}</p></div>${ok ? '<script>window.close();</script>' : ''}</body></html>`;
}

/**
 * Run the loopback-redirect authorization and return the code.
 *
 * @param zitadelUrl - Zitadel base URL.
 * @param clientId - OAuth public client id (loopback-capable registration).
 * @param challenge - The S256 code challenge.
 * @returns The authorization code and the exact redirect URI used.
 */
function authorizeViaLoopback(zitadelUrl: string, clientId: string, challenge: string): Promise<{ code: string; redirectUri: string }> {
	return new Promise((resolve, reject) => {
		const server = http.createServer();
		const timer = setTimeout(() => {
			server.close();
			reject(new Error('Preview sign-in timed out waiting for the browser redirect'));
		}, PREVIEW_AUTH_TIMEOUT_MS);

		server.on('request', (req, res) => {
			const url = new URL(req.url || '/', 'http://127.0.0.1');
			if (url.pathname !== '/auth/callback') {
				res.writeHead(404).end();
				return;
			}
			clearTimeout(timer);
			const error = url.searchParams.get('error');
			const code = url.searchParams.get('code') || '';
			const answer = (ok: boolean, detail?: string): void => {
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
				res.end(callbackPage(ok, detail));
				server.close();
			};
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			if (error) {
				const reason = url.searchParams.get('error_description') || error;
				answer(false, reason);
				reject(new Error(`Preview sign-in was rejected: ${reason}`));
			} else if (!code) {
				answer(false, 'The redirect carried no authorization code.');
				reject(new Error('Preview sign-in redirect carried no authorization code'));
			} else {
				answer(true);
				resolve({ code, redirectUri: `http://127.0.0.1:${port}/auth/callback` });
			}
		});

		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
			const authorizeUrl = buildAuthUrl(zitadelUrl, clientId, redirectUri, challenge);
			void vscode.env.openExternal(vscode.Uri.parse(authorizeUrl));
		});
	});
}

/**
 * Sign the PREVIEW in: full PKCE round trip, throwaway exchange connection,
 * nothing persisted. The extension's own session is untouched throughout.
 *
 * @param cloudUrl - The server the preview's session is for.
 * @returns The rr_* session key, or '' when the sign-in did not complete.
 */
export async function signInPreview(cloudUrl: string): Promise<string> {
	const zitadelUrl = process.env.RR_ZITADEL_URL || DEFAULT_ZITADEL_URL;
	// The CLI's Native registration: loopback redirects with arbitrary
	// ports are its proven shape (the extension's own client id redirects
	// to the vscode:// deep link, which would route into the WINDOW's
	// session machinery — exactly what this flow must avoid).
	const clientId = process.env.RR_ZITADEL_CLI_CLIENT_ID || DEFAULT_CLI_CLIENT_ID;
	const { verifier, challenge } = generatePkce();
	const { code, redirectUri } = await authorizeViaLoopback(zitadelUrl, clientId, challenge);

	const tempClient = new RocketRideClient({ persist: false });
	try {
		const result = await tempClient.connect({ code, verifier, redirectUri, clientId }, { uri: cloudUrl });
		if (result?.waitlisted) {
			getLogger().output('[appdev] preview sign-in: account is waitlisted — no session issued');
			return '';
		}
		return result?.userToken ?? '';
	} finally {
		await tempClient.disconnect().catch(() => {});
	}
}
