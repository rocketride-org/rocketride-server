# Changelog

All notable changes to this project are documented in this file.

## [1.0.0]

### Breaking

- The **RocketRide API** credential holds your RocketRide API key (`rr_…`), an account key or a key scoped to one pipeline endpoint, and sends it as a Bearer token. Pipeline (`pk_…`) and task (`tk_…`) keys are no longer accepted by the server; re-enter the credential with an `rr_` key after upgrading.
- The **RocketRide** node calls `POST {baseUrl}/webhook/{address}`. Set the new **Pipeline Address** field (`developerId.pipelineId.source`); leave it empty only with a key scoped to exactly one pipeline endpoint.

### Changed

- The credential test calls the authenticated `GET /status`, so it checks the Base URL and the key together.
- A single result's token counts (`tokens`: `input`, `output`, `cache_read`, `cache_creation`, which the server adds for text and JSON answers) are under `_rocketride.tokens`. They are not lifted to the top level, where every other key is a pipeline lane.

## [0.1.0]

- Initial scaffold of the RocketRide n8n community node (action node + RocketRide API credential).
