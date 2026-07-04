---
title: Security
sidebar_label: Security
---

# Security

RocketRide is open-source and developed in the open with a documented security process. This
page summarizes it; the authoritative policy is
[`SECURITY.md`](https://github.com/rocketride-org/rocketride-server/blob/develop/SECURITY.md)
in the repository.

## Reporting a vulnerability

Report security issues privately, **do not** open a public issue. Use
[GitHub Security Advisories](https://github.com/rocketride-org/rocketride-server/security/advisories/new)
on the repository, or email **security@rocketride.ai**. You'll get an acknowledgement and a
coordinated-disclosure timeline.

## Triage & remediation SLAs

Reports are triaged and fixed on severity-based timelines (critical issues fastest, down to
low). The exact triage and remediation windows per severity are listed in
[`SECURITY.md`](https://github.com/rocketride-org/rocketride-server/blob/develop/SECURITY.md).

## How the codebase is protected

- **Automated scanning** on every change: CodeQL (static analysis), OpenSSF Scorecard, Trivy
  (dependencies & containers), Dependabot, and secret scanning.
- **Two-person control** on dismissing security findings: no single maintainer can wave a
  finding through.
- **Branch protection** on `develop`: required reviews and status checks before merge, with
  admin bypass disabled so the rules apply to everyone, including org owners.
- **Periodic access reviews** of who can write to the repository.

## Deployment & data

Pipelines are portable JSON you control. You choose where the engine runs (locally,
on-premises behind your own network controls, or on [RocketRide Cloud](/cloud)), so sensitive
data and model credentials stay within the boundary you operate. When connecting to a remote
engine, always use an encrypted transport (`https://` / `wss://`); a plain `ws://` URI
downgrades to an unencrypted connection.

## Read the full policy

See [`SECURITY.md`](https://github.com/rocketride-org/rocketride-server/blob/develop/SECURITY.md)
for supported versions, the complete reporting process, and the full SLA table.
