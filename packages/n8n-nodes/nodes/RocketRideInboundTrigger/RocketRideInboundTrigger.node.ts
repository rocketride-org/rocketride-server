import { createHash, timingSafeEqual } from 'node:crypto';
import {
	NodeConnectionTypes,
	type IDataObject,
	type IHookFunctions,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';

function secretDigest(value: string) {
	return createHash('sha256').update(value, 'utf8').digest();
}

function secretsMatch(provided: string, secret: string): boolean {
	return timingSafeEqual(secretDigest(provided), secretDigest(secret));
}

// A trigger cannot meaningfully be used as an AI Agent tool, so usableAsTool is
// intentionally omitted — otherwise n8n generates a confusing "RocketRide Trigger
// Tool" entry. The verified-lint rule is suppressed here for that reason only.
// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class RocketRideInboundTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'RocketRide Trigger',
		// NOTE: the internal name is deliberately NOT "rocketRideTrigger". n8n's node
		// creator (generateMergedNodesAndActions) does `name.replace('Trigger','')` and,
		// if the result matches an action node's name, MERGES the trigger into that action
		// instead of listing it as a standalone trigger — which hides it from the trigger
		// panel. "rocketRideTrigger" would reduce to "rocketRide" (our action node), so we
		// use a non-colliding name. displayName stays "RocketRide Trigger" for users.
		name: 'rocketRideInboundTrigger',
		icon: { light: 'file:rocketride.svg', dark: 'file:rocketride.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '=POST /{{$parameter["path"]}}',
		description: 'Starts the workflow when a RocketRide pipeline calls in',
		eventTriggerDescription: 'Waiting for a call from RocketRide',
		activationMessage: 'You can now receive calls from RocketRide at your production webhook URL.',
		defaults: {
			name: 'RocketRide Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: '={{$parameter["responseMode"]}}',
				path: '={{$parameter["path"]}}',
			},
		],
		properties: [
			{
				displayName: 'Path',
				name: 'path',
				type: 'string',
				default: 'rocketride',
				required: true,
				description:
					'The path segment of this webhook URL. Paste the full URL into the RocketRide n8n node so RocketRide can call this workflow.',
			},
			{
				displayName: 'Respond',
				name: 'responseMode',
				type: 'options',
				default: 'lastNode',
				options: [
					{
						name: 'Immediately',
						value: 'onReceived',
						description: 'Acknowledge as soon as the call is received',
					},
					{
						name: 'Using Respond to Webhook Node',
						value: 'responseNode',
						description: 'Respond from a "Respond to Webhook" node in the workflow',
					},
					{
						name: 'When Last Node Finishes',
						value: 'lastNode',
						description: "Respond with the last node's output, returning the result to RocketRide",
					},
				],
				description: 'When and how to respond to the RocketRide call',
			},
			{
				displayName: 'Secret',
				name: 'secret',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				description:
					'Optional shared secret. If set, the incoming request must send it in the Authorization header (Bearer prefix optional); otherwise the call is rejected with 401.',
			},
		],
	};

	// This webhook is hosted by n8n and the user pastes its URL into RocketRide;
	// there is no external service to register with, so the lifecycle hooks are no-ops.
	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return false;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const secret = String(this.getNodeParameter('secret', '') ?? '').trim();
		if (secret) {
			const headers = this.getHeaderData() as Record<string, unknown>;
			const provided = String(headers.authorization ?? '')
				.replace(/^Bearer\s+/i, '')
				.trim();
			if (!secretsMatch(provided, secret)) {
				const res = this.getResponseObject();
				res.status(401).json({ error: 'Unauthorized: invalid RocketRide secret' });
				return { noWebhookResponse: true };
			}
		}

		const body = this.getBodyData();
		const json: IDataObject =
			body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : { data: body };
		// Never copy auth/session headers into workflow data: the Authorization header
		// carries the shared secret, so exposing it downstream or in execution logs leaks it.
		const safeHeaders = { ...(this.getHeaderData() as Record<string, unknown>) };
		delete safeHeaders.authorization;
		delete safeHeaders.cookie;
		delete safeHeaders['set-cookie'];
		json._rocketride = {
			headers: safeHeaders,
			query: this.getQueryData(),
		} as unknown as IDataObject;

		return { workflowData: [[{ json }]] };
	}
}
