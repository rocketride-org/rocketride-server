# RocketRide TypeScript SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/main/docs/public/typescript/assets/banner-typescript.png" alt="RocketRide TypeScript SDK" width="900">
</p>

<p align="center">
  Build, run, and manage AI pipelines from Node.js or the browser.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/rocketride"><img src="https://img.shields.io/npm/v/rocketride?color=222223&label=NPM" alt="npm"></a>
  <a href="https://github.com/rocketride-org/rocketride-server"><img src="https://img.shields.io/github/stars/rocketride-org/rocketride-server?style=flat&color=238636&label=GitHub&logo=github&logoColor=white" alt="GitHub"></a>
  <a href="https://discord.gg/PMXrtenMsY"><img src="https://img.shields.io/badge/Discord-Join-370b7a?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE"><img src="https://img.shields.io/badge/License-MIT-41b6e6" alt="MIT License"></a>
</p>

**Full documentation: [docs.rocketride.org/clients/typescript](https://docs.rocketride.org/clients/typescript)** — guides, the complete API reference, and worked examples.

## Quick Start

```bash
npm install rocketride
```

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

`send()` / `sendFiles()` are for pipelines whose **source** is `webhook` or `dropper`;
if your pipeline source is `chat`, use `client.chat()` instead. Don't have a pipeline
yet? Build one visually with the [RocketRide IDE extension](https://docs.rocketride.org/quickstart/ide-walkthrough).

The SDK ships complete type definitions, runs in Node.js and the browser, includes
the `rocketride` [CLI](https://docs.rocketride.org/connect/cli), and covers the full
engine surface: pipeline execution, streaming data, chat, deployments with cron
schedules, server-side file storage, and run-log replay.

## What is RocketRide?

[RocketRide](https://rocketride.org) is an open-source, developer-native AI pipeline
platform: build, debug, and deploy production AI workflows without leaving your IDE,
on a visual canvas or code-first. 140+ ready-to-use nodes (15+ LLM providers, 10+
vector stores, OCR, NER, PII anonymization) run on a high-performance C++ engine,
deployable anywhere, MIT licensed. You build your `.pipe` — and run it against the
fastest AI runtime available.

## Configuration

| Variable | Description |
| --- | --- |
| `ROCKETRIDE_URI` | Server URI (e.g. `wss://api.rocketride.ai` or `ws://localhost:5565`) |
| `ROCKETRIDE_APIKEY` | API key for authentication |

All client config options, timeouts, and reconnection behavior:
[Configuration](https://docs.rocketride.org/clients/typescript/configuration).

## Documentation

- [Overview & quickstart](https://docs.rocketride.org/clients/typescript)
- [Running pipelines](https://docs.rocketride.org/clients/typescript/pipelines) · [Sending data](https://docs.rocketride.org/clients/typescript/data) · [Chat](https://docs.rocketride.org/clients/typescript/chat)
- [Deployments](https://docs.rocketride.org/clients/typescript/deploy) · [File storage](https://docs.rocketride.org/clients/typescript/storage) · [Run logs](https://docs.rocketride.org/clients/typescript/logs)
- [Error handling](https://docs.rocketride.org/clients/typescript/errors) · [API reference](https://docs.rocketride.org/clients/typescript/reference) · [Examples](https://docs.rocketride.org/clients/typescript/examples)

## Links

- [Documentation](https://docs.rocketride.org/clients/typescript)
- [GitHub](https://github.com/rocketride-org/rocketride-server)
- [Discord](https://discord.gg/PMXrtenMsY)
- [Release notes](https://docs.rocketride.org/support/release-notes)

## License

MIT - see [LICENSE](https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE).
