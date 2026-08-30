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
// AUTH & IDENTITY — GALLERY ENTRY (DOC-ONLY, HOOKS)
// =============================================================================

/** Doc-only gallery entry for identity hooks and the auth providers. */

import type { IGalleryEntry } from '../galleryTypes';

/** The Auth & identity gallery entry. */
export const authIdentityEntry: IGalleryEntry = {
	id: 'auth-identity',
	name: 'Auth & identity',
	group: 'hooks',
	blurb: 'Who is signed in: useAuthUser for the server-driven identity, useLogout for sign-out, and the host-side auth providers behind them.',
	doc: `Identity is server-driven: \`useAuthUser()\` returns the \`ConnectResult\` the server produced at connect (aliased as \`AuthUser\`) — name, email, subscription, apps, credits — or \`null\` when not authenticated. Apps read it; they never write it.

The auth providers are HOST bootstrap machinery: \`CloudAuthProvider\` (OAuth2 PKCE against the SaaS identity provider) and \`ApiKeyAuthProvider\` (OSS/local API-key mode). A standalone host picks one and hands it to \`ConnectionManager.initialize\`; hosted apps never touch them.

To trigger auth flows from UI, emit the intent events instead: \`shell:loginRequest\` / \`shell:logoutRequest\`. \`useLogout()\` currently always returns \`null\` (sign-out is a shell page-reload flow) — it exists as the forward-compatible seam.`,
	docNote: 'The shell owns auth end to end. Apps read identity via useAuthUser and emit shell:loginRequest / shell:logoutRequest - never instantiate providers or handle tokens.',
	code: `import { useAuthUser, ConnectionManager, Button } from 'shell';

function AccountCard() {
	const user = useAuthUser();
	if (!user) {
		return <Button onClick={() =>
			ConnectionManager.getInstance().emit('shell:loginRequest', {})
		}>Sign in</Button>;
	}
	return <span>{user.name} - {user.email}</span>;
}`,
	propsLabel: 'Hooks',
	props: [
		{ name: 'useAuthUser', type: '() => AuthUser | null', dir: 'out', note: 'The server-driven identity (ConnectResult); null when not authenticated.' },
		{ name: 'useLogout', type: '() => (() => void) | null', dir: 'out', note: 'Forward-compat sign-out seam; currently always null (logout is a shell page-reload flow).' },
	],
	sections: [
		{
			label: 'Providers (host bootstrap only)',
			rows: [
				{ name: 'CloudAuthProvider', type: 'getInstance() + initialize({ zitadelUrl, clientId })', dir: 'in', note: 'OAuth2 PKCE for the SaaS cloud: signIn / handleCallback / token storage in sessionStorage.' },
				{ name: 'ApiKeyAuthProvider', type: 'getInstance()', dir: 'in', note: 'API-key auth for OSS/local mode; an empty key means open access.' },
				{ name: 'IAuthProvider', type: 'interface', dir: 'in', note: 'The contract both implement - what InitOptions.authProvider accepts.' },
			],
		},
		{
			label: 'Types',
			rows: [{ name: 'AuthUser', type: 'ConnectResult', dir: 'in', note: 'The full connect payload: identity, subscription, apps, credits.' }],
		},
	],
};
