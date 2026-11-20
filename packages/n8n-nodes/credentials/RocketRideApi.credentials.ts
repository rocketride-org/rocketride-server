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
				"Your RocketRide API key (rr_…). An account key reaches every pipeline your account may call; a key scoped to one pipeline endpoint (minted from that pipeline's endpoint info) reaches only that endpoint. Sent as a Bearer token; runs are billed to the key's account.",
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

	// Checks the gateway Base URL and the key together: `GET /status` is an
	// authenticated route, so it answers only when the Base URL is reachable AND
	// the rr_ key authenticates. An account key does not depend on any pipeline
	// running, so it can be validated here, at credential-config time.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/status',
			method: 'GET',
			// Honor the same `Ignore SSL Issues` toggle a node run applies, so Test
			// and Run make identical TLS decisions on self-signed HTTPS gateways.
			skipSslCertificateValidation: '={{$credentials.ignoreSslIssues}}',
		},
	};
}
