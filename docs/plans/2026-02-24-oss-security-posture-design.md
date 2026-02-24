# OSS Security Posture — Public Release Readiness

## Context

rocketride-server is going public this week. The repo currently has zero security scanning — no Dependabot, no CodeQL, no SAST, no container scanning, no SBOM. The existing `scripts/licenses.js` does manual license collection but nothing runs in CI. GitHub already shows 29 known vulnerabilities on the default branch.

For a credible open-source repo, visitors check: GitHub Security tab, CI badges, SECURITY.md, LICENSE + NOTICE, and Dependabot activity. This design adds the automated scanning foundation and visible compliance artifacts needed for public launch.

## Scope

Security scanning and compliance automation only. No changes to source code, build system, or test infrastructure. No DAST (no public endpoint — this is an engine/library). No pre-commit hooks (separate effort).

## Architecture

Four new GitHub Actions workflows plus repo config:

```
.github/
├── workflows/
│   ├── build.yaml              (existing — add SBOM to release job, badges to README)
│   ├── codeql.yml              (new — SAST for C++, Python, JS/TS)
│   ├── dependency-review.yml   (new — block PRs introducing known CVEs)
│   └── container-scan.yml      (new — Trivy scan on Dockerfiles)
├── dependabot.yml              (new — all ecosystems, daily)
└── SECURITY.md                 (existing — enable GitHub Security Advisories)

NOTICE                          (new — third-party attribution)
README.md                       (update — security badges)
```

### What runs when

| Trigger | Workflow | Purpose |
|---------|----------|---------|
| Push/PR to develop, main, release/** | CodeQL | SAST scanning (C++, Python, JS/TS) |
| Weekly schedule | CodeQL | Catch new CVEs in unchanged code |
| PR only | Dependency Review | Block PRs introducing critical/high CVEs |
| Daily schedule | Dependabot | Check all ecosystems for updates |
| Push/PR touching docker/** | Container Scan | Trivy scan all 3 Dockerfiles |
| Release (manual dispatch) | SBOM generation | CycloneDX JSON attached to release |

## Dependabot

- **Ecosystems**: npm, pip (all 38 requirement files), docker, github-actions, maven
- **Schedule**: daily
- **No grouping**: every vulnerability gets its own PR for full visibility
- **Labels**: `dependencies` + per-ecosystem labels
- **Target branch**: `develop`

## CodeQL

- **Languages**: `cpp`, `python`, `javascript-typescript`
- **Query suite**: `security-and-quality`
- **Build mode**: autobuild for JS/Python, manual build step for C++ (custom `./builder`)
- **Output**: SARIF uploaded to GitHub Security tab

## Dependency Review

- **Trigger**: PRs only
- **Severity**: fail on critical and high, warn on moderate
- **License check**: warn on GPL-3.0 and AGPL-3.0 (incompatible with MIT)

## Container Scan

- **Tool**: Trivy (aquasecurity/trivy-action)
- **Targets**: Dockerfile.engine, Dockerfile.eaas, Dockerfile.overlay
- **Output**: SARIF uploaded to GitHub Security tab
- **Threshold**: fail on CRITICAL and HIGH (application-layer only, not base OS)

## NOTICE File

Generated from existing `scripts/licenses.js` output. Covers npm, pip, vcpkg, Maven dependencies. Committed to repo root.

## SBOM

- **Tool**: CycloneDX (anchore/sbom-action)
- **Format**: CycloneDX JSON
- **When**: release workflow
- **Output**: attached as GitHub release asset

## GitHub Security Advisories

Enable private vulnerability reporting via `gh api`. Adds "Report a vulnerability" button to Security tab.

## README Badges

```
[![Build](badge-url)](workflow-url)
[![CodeQL](badge-url)](workflow-url)
[![Dependabot](badge-url)](dependabot-url)
[![License: MIT](badge-url)](LICENSE)
```

## Risks

- **CodeQL C++ autobuild may fail**: custom `./builder` system may not be auto-detectable. Fallback: limit C++ to query-only mode (no build needed for some packs).
- **38 pip requirement files**: will generate significant Dependabot PR noise initially. This is intentional — full visibility.
- **Trivy on ubuntu:22.04 base images**: will flag OS-level CVEs. Informational only, won't block builds on base image findings.
- **GPL license denial**: dependency-review set to warn initially, switch to deny after reviewing transitive dependencies.

## What the repo looks like after

Visitors see:
- Green "Code scanning" badge (CodeQL passing)
- Green "Build" badge (existing CI)
- "Dependencies" badge showing Dependabot active
- LICENSE (MIT) + NOTICE (third-party attribution)
- SECURITY.md with "Report a vulnerability" button
- Security tab: code scanning alerts, Dependabot alerts, advisories
- Releases: SBOM attached as CycloneDX JSON
