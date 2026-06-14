---
title: Why RocketRide
sidebar_label: Why RocketRide
---

# Why RocketRide

RocketRide is an open-source runtime for AI pipelines. It sits one layer below your
application and your agent framework, handling the models, vector stores, observability, and
orchestration that come *after* the code, so you can swap providers, scale workloads, and
ship production AI without rebuilding your stack every time the landscape shifts.

## Pipelines are portable JSON

A pipeline is a `.pipe` file: plain, version-controlled JSON. The same file runs unchanged on
your laptop, your servers, or RocketRide Cloud. Commit it, diff it, share it, code-review it
like any other source artifact, no proprietary project format, no lock-in.

## Build visually or in code

Author pipelines on a visual drag-and-drop canvas in the VS Code extension, or define and run
them from a few lines of [TypeScript](/develop/typescript) or [Python](/develop/python). The
two are interchangeable: build visually, then run from code, or vice versa.

## A fast, production-grade core

Pipelines execute on a multithreaded C++ engine built for throughput and reliability, not a
thin wrapper around HTTP calls. You get the same execution semantics in development and
production.

## Batteries included, nothing locked in

- **50+ ready-to-use [nodes](/nodes)**: 13+ LLM providers, 8 vector databases, OCR, NER, PII
  anonymization, transcription, web tools, and more.
- **Swap providers freely**: change an LLM or vector store by editing config, not code.
- **Observability built in**: trace call trees, token usage, and memory as pipelines run.
- **Open protocols**: drive pipelines over [WebSocket](/protocols/websocket) or expose them
  as tools over [MCP](/protocols/mcp).
- **Deploy anywhere**: locally, on-premises with Docker, or managed on
  [RocketRide Cloud](/cloud).
- **MIT licensed**: fully open-source and OSI-compliant.

## Where to go next

- [Understanding RocketRide](/evaluate/understanding): how the pieces fit together.
- [Use cases](/evaluate/use-cases): end-to-end walkthroughs.
- [Quickstart](/quickstart): from zero to a running pipeline.
