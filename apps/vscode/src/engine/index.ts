// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Engine module — public barrel export.
 *
 * Architecture:
 *   EngineRegistry (singleton) → owns N × EngineManager (one per mode)
 *   EngineManager             → owns 1 × EngineBackend subclass
 *   EngineBackend (abstract)  → implemented by Local, Service, Docker, Cloud, Onprem
 *
 * Consumers import from this barrel:
 *   - EngineRegistry  — reconcile engines, dispatch ioControl commands
 *   - EngineManager   — per-mode lifecycle (transitionTo / teardown)
 *   - EngineBackend   — base class for implementing new backend types
 *   - Status types    — EngineStatusEvent, EnginePhase, etc.
 */

export { EngineManager, type EngineManagerConfig } from './engine-manager';
export { EngineRegistry } from './engine-registry';
export { type EngineStatusEvent, type EnginePhase, type EngineInfo, type EngineBackendStatus, type StatusEmitter } from './engine-backend';
export { EngineBackend } from './engine-backend';
