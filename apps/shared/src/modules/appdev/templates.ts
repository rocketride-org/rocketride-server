// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * App scaffold templates — re-exported from the SDK's canonical module.
 *
 * The templates moved to `rocketride/app-scaffold` so the App Builder
 * wizard, `deploy.createApp()`, and the `rocketride app create` CLI all
 * render from ONE source. This shim keeps every existing shared/extension
 * import path working; new code should import the SDK subpath directly.
 */

export * from 'rocketride/app-scaffold';
