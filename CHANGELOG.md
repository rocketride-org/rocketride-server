# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **llm_gemini**: Updated model profiles to current Gemini lineup
  - Added: `gemini-3.1-pro-preview`, `gemini-3.1-flash-image-preview`, `gemini-3.1-flash-lite-preview`, `gemini-3-flash-preview`, `gemini-3-pro-image-preview`
  - Deprecated profiles retained for backwards compatibility:
    - `gemini-3-pro-preview` → use `gemini-3.1-pro-preview`
    - `gemini-3-pro-image` → use `gemini-3-pro-image-preview`
    - `gemini-2_0-flash` → use `gemini-2.5-flash`
    - `gemini-2_0-flash-lite` → use `gemini-2.5-flash-lite`
  - Standardized profile key naming: `gemini-2.5-*` (dot notation) for consistency

### Added

- **Config**: `Config.getNodeConfig()` now emits warnings when deprecated profiles are used, with migration guidance from the profile's `migration` field

## [1.0.3] - 2026-03-01

### Added

- Docker image for one-click deploy (#126)

### Fixed

- Performance metrics reset on tab switch (#137)
- Engine crash on malformed pipeline input (#134)

## [1.0.2] and earlier

See [GitHub Releases](https://github.com/rocketride-org/rocketride-server/releases) for previous release notes.

[Unreleased]: https://github.com/rocketride-org/rocketride-server/compare/server-v1.0.3...HEAD
[1.0.3]: https://github.com/rocketride-org/rocketride-server/compare/server-v1.0.2...server-v1.0.3
