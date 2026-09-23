---
title: Examples
sidebar_position: 11
---

# Examples

Complete, runnable programs covering the SDK surface end to end. For pipeline-level
examples, see the site-wide examples —
[RAG pipeline](/examples/rag-pipeline), [webhook pipeline](/examples/webhook-pipeline), and [document extraction](/examples/document-extraction).

## 1. Minimal: connect, run pipeline from file, send one string, disconnect

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
	auth: process.env.ROCKETRIDE_APIKEY!,
	uri: 'https://api.rocketride.ai',
});
await client.connect();
const { token } = await client.use({ filepath: './pipeline.pipe' });
const result = await client.send(token, 'Hello, pipeline!', { name: 'input.txt' }, 'text/plain');
console.log(result);
await client.terminate(token);
await client.disconnect();
```

## 2. One-off script with automatic disconnect (withConnection)

```typescript
import { RocketRideClient } from 'rocketride';

const myPipelineConfig = { components: [] }; // your pipeline object, e.g. JSON.parse of a .pipe file

const status = await RocketRideClient.withConnection({ auth: 'my-key', uri: 'wss://api.rocketride.ai' }, async (client) => {
	const { token } = await client.use({ pipeline: myPipelineConfig });
	await client.send(token, JSON.stringify({ data: 1 }));
	return await client.getTaskStatus(token);
});
console.log(status);
```

## 3. Long-lived app: persist mode, callbacks, and status handling

```typescript
import { RocketRideClient } from 'rocketride';

const apiKey = process.env.ROCKETRIDE_APIKEY!;
const serverUri = 'wss://api.rocketride.ai';

const client = new RocketRideClient({
	auth: apiKey,
	uri: serverUri,
	persist: true,
	onConnected: async () => updateUI({ state: 'connected' }),
	onDisconnected: async (reason, hasError) => updateUI({ state: 'disconnected', reason, hasError }),
	onConnectError: (error) => updateUI({ state: 'error', message: error.message }),
	onEvent: async (e) => {
		if (e.event === 'apaevt_status_upload') updateProgress(e.body);
	},
});
await client.connect();
// Later: use(), sendFiles(), etc. If the connection drops, the client retries
// forever (linear backoff) — except on auth failure. Do not call disconnect()
// in onDisconnected.
```

## 4. Upload multiple files and poll until pipeline completes

```typescript
import { RocketRideClient } from 'rocketride';

const auth = process.env.ROCKETRIDE_APIKEY!;
const uri = 'https://api.rocketride.ai';
const client = new RocketRideClient({ auth, uri, onEvent: async (e) => console.log(e.event, e.body) });
await client.connect();
const { token } = await client.use({ filepath: './vectorize.pipe' });
await client.setEvents(token, ['apaevt_status_upload', 'apaevt_status_processing']);

const files = [new File([content1], 'a.md'), new File([content2], 'b.md')];
const uploadResults = await client.sendFiles(
	files.map((file) => ({ file })),
	token
);
console.log('Uploaded:', uploadResults.filter((r) => r.action === 'complete').length);

while (true) {
	const status = await client.getTaskStatus(token);
	console.log(`Progress: ${status.completedCount}/${status.totalCount}`);
	if (status.completed) break;
	await new Promise((r) => setTimeout(r, 2000));
}
await client.terminate(token);
await client.disconnect();
```

## 5. Streaming large data with a pipe

```typescript
import { RocketRideClient } from 'rocketride';
import { createReadStream, readFileSync } from 'fs';
import { createInterface } from 'readline';

const auth = process.env.ROCKETRIDE_APIKEY!;
const uri = 'https://api.rocketride.ai';
const config = JSON.parse(readFileSync('./ingest.pipe', 'utf8'));

const client = new RocketRideClient({ auth, uri });
await client.connect();
const { token } = await client.use({ pipeline: config });

const pipe = await client.pipe(token, { name: 'large.csv' }, 'text/csv');
await pipe.open();
const rl = createInterface({ input: createReadStream('large.csv') });
for await (const line of rl) {
	await pipe.write(new TextEncoder().encode(line + '\n'));
}
const result = await pipe.close();
console.log(result);
await client.terminate(token);
await client.disconnect();
```

## 6. Chat: question with instructions and examples, parse JSON answer

```typescript
import { RocketRideClient, Question, Answer } from 'rocketride';
import { readFileSync } from 'fs';

const auth = process.env.ROCKETRIDE_APIKEY!;
const uri = 'https://api.rocketride.ai';
const chatPipelineConfig = JSON.parse(readFileSync('./chat_pipeline.pipe', 'utf8'));

const client = new RocketRideClient({ auth, uri });
await client.connect();
const { token } = await client.use({ pipeline: chatPipelineConfig });

const question = new Question({ expectJson: true });
question.addInstruction('Format', 'Return a JSON object with keys: summary, keywords.');
question.addExample('Summarize X', { summary: '...', keywords: ['a', 'b'] });
question.addQuestion('Summarize the main points and list keywords.');

const response = await client.chat({ token, question });
const answerText = response?.answers?.[0];
const answer = new Answer(true); // expectJson — so isJson()/getJson() engage
answer.setAnswer(answerText ?? '');
const structured = answer.isJson() ? answer.getJson() : answer.getText();
console.log(structured);

await client.terminate(token);
await client.disconnect();
```

## 7. Discover services and send a custom DAP request

```typescript
import { RocketRideClient } from 'rocketride';

const auth = 'my-key';
const uri = 'https://api.rocketride.ai';
const client = new RocketRideClient({ auth, uri });
await client.connect();

const services = await client.getServices();
console.log('Available:', Object.keys(services.services));
const ocr = await client.getService('ocr'); // throws if the service is unknown

const myToken = 'existing-task-token'; // token from an earlier client.use() call
const req = client.buildRequest('rrext_ping', { token: myToken });
const res = await client.request(req, 5000);
if (client.didFail(res)) throw new Error(res.message);
await client.disconnect();
```
