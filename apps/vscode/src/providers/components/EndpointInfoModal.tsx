// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Re-exports the shared EndpointInfoModal so the status page uses the same
 * implementation as the canvas (packages/shared-ui).
 */

export { EndpointInfoModal, type EndpointInfo, appendAuthQueryParam, buildIntegrationExamples, type IntegrationTabId } from 'shared';
