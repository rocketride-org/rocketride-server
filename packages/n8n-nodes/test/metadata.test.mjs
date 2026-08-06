import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RocketRideApi } from '../credentials/RocketRideApi.credentials.ts';
import { RocketRide } from '../nodes/RocketRide/RocketRide.node.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) => JSON.parse(readFileSync(join(root, relativePath), 'utf8'));

const rocketRideCodex = readJson('nodes/RocketRide/RocketRide.node.json');
const triggerCodex = readJson(
	'nodes/RocketRideInboundTrigger/RocketRideInboundTrigger.node.json',
);
const packageJson = readJson('package.json');
const readme = readFileSync(join(root, 'README.md'), 'utf8');

const requiredAliases = [
	'Agent',
	'AI Agent',
	'AI Pipeline',
	'Anonymize',
	'Chat',
	'Classify',
	'Data Extraction',
	'Data Processing',
	'Data Transformation',
	'Document Parsing',
	'Document Processing',
	'Extract',
	'OCR',
	'Parse',
	'Parser',
	'PII',
	'RAG',
	'Redact',
	'Summarize',
	'Transform',
];

const requiredPackageKeywords = [
	'ai-agent',
	'ai-pipeline',
	'document-parsing',
	'ocr',
	'data-extraction',
	'anonymization',
	'pii',
	'redaction',
	'data-transformation',
	'summarization',
];

describe('RocketRide discoverability metadata', () => {
	it('publishes every task-based search alias on the action node', () => {
		expect(rocketRideCodex.alias).toEqual(expect.arrayContaining(requiredAliases));
	});

	it('places the action node in the intended n8n categories', () => {
		expect(rocketRideCodex.categories).toEqual(['AI', 'Development', 'Data & Storage']);
		expect(rocketRideCodex.subcategories).toEqual({ AI: ['Root Nodes'] });
	});

	it('keeps the visible action-node description and tool capability discoverable', () => {
		const description = new RocketRide().description;

		expect(description.description).toBe(
			'Run RocketRide AI pipelines for document parsing, OCR, data extraction, PII anonymization, transformation, RAG, chat, and agents.',
		);
		expect(description.usableAsTool).toBe(true);
	});

	it('uses the published package documentation URLs for both nodes', () => {
		expect(rocketRideCodex.resources).toEqual({
			credentialDocumentation: [
				{
					url: 'https://www.npmjs.com/package/n8n-nodes-rocketride#credentials',
				},
			],
			primaryDocumentation: [
				{
					url: 'https://www.npmjs.com/package/n8n-nodes-rocketride',
				},
			],
		});
		expect(triggerCodex.resources.primaryDocumentation).toEqual([
			{
				url: 'https://www.npmjs.com/package/n8n-nodes-rocketride',
			},
		]);
		expect(new RocketRideApi().documentationUrl).toBe(
			'https://www.npmjs.com/package/n8n-nodes-rocketride#credentials',
		);
	});

	it('preserves the trigger search aliases', () => {
		expect(triggerCodex.alias).toEqual([
			'RocketRide',
			'Webhook',
			'Receive',
			'Inbound',
			'Listen',
			'Callback',
		]);
	});

	it('publishes capability-focused npm metadata from the monorepo package', () => {
		expect(packageJson.keywords).toEqual(expect.arrayContaining(requiredPackageKeywords));
		expect(packageJson.description).toContain('document parsing');
		expect(packageJson.description).toContain('PII anonymization');
		expect(packageJson.description).toContain('RocketRide Trigger');
		expect(packageJson.author).toEqual({
			name: 'Aparavi Software AG',
			url: 'https://rocketride.ai',
		});
		expect(packageJson.homepage).toBe(
			'https://github.com/rocketride-org/rocketride-server/tree/develop/packages/n8n-nodes#readme',
		);
		expect(packageJson.repository).toEqual({
			type: 'git',
			url: 'git+https://github.com/rocketride-org/rocketride-server.git',
			directory: 'packages/n8n-nodes',
		});
		expect(packageJson.bugs.url).toBe(
			'https://github.com/rocketride-org/rocketride-server/issues',
		);
	});

	it('documents use cases, publication status, and a stable credentials anchor', () => {
		expect(readme).toMatch(/^## Use cases$/m);
		expect(readme).toMatch(/^## Credentials$/m);
		expect(readme).toContain('After this package is published to npm');
		expect(readme).toContain('after n8n approves it as a verified community node');
		expect(readme).toContain('The RocketRide node invokes deployed RocketRide pipelines.');
	});
});
