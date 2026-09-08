import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class RocketRideApi implements ICredentialType {
	name = 'rocketRideApi';

	displayName = 'RocketRide API';

	documentationUrl = 'https://www.npmjs.com/package/n8n-nodes-rocketride#credentials';

	icon: Icon = { light: 'file:rocketride.svg', dark: 'file:rocketride.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://127.0.0.1:5567',
			required: true,
			placeholder: 'http://127.0.0.1:5567',
			description:
				'Base URL of the RocketRide HTTP gateway. For a local engine use 127.0.0.1 rather than localhost (n8n may resolve localhost to IPv6, which a local engine does not listen on). If RocketRide runs in Docker and n8n does not, use http://host.docker.internal:5567.',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				"The pipeline's public authorization key (pk_…), shown in the RocketRide IDE while the pipeline is running. Sent as a Bearer token.",
		},
		{
			displayName: 'Ignore SSL Issues (Insecure)',
			name: 'ignoreSslIssues',
			type: 'boolean',
			default: false,
			description:
				'Whether to connect even if SSL certificate validation fails (only for a self-signed local HTTPS gateway)',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// Reachability check against RocketRide's public, unauthenticated `GET /version`
	// route. This confirms the gateway Base URL is correct and reachable — the most
	// common misconfiguration. The API key itself is exercised when a node runs
	// against a live pipeline: a `pk_` key only resolves while its pipeline is
	// running, so it cannot be meaningfully validated at credential-config time.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/version',
			method: 'GET',
			// Honor the same `Ignore SSL Issues` toggle a node run applies, so Test
			// and Run make identical TLS decisions on self-signed HTTPS gateways.
			skipSslCertificateValidation: '={{$credentials.ignoreSslIssues}}',
		},
	};
}
