# Security Policy

## Supported Versions

We release security patches for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 3.1.x   | :white_check_mark: |
| < 3.1   | :x:                |

Critical-severity issues in unsupported versions are evaluated case-by-case.

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please report it responsibly.

### How to Report

1. **Do NOT** open a public GitHub issue for security vulnerabilities
2. **Preferred**: Use [GitHub Security Advisories](https://github.com/rocketride-org/rocketride-server/security/advisories/new) to report privately through GitHub
3. **Alternative**: Email security concerns to: security@rocketride.ai
4. Include as much detail as possible:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### What to Expect

- **Acknowledgment**: within 2 business days
- **Triage and Remediation SLA**:

| Severity   | Triage SLA      | Remediation SLA  |
| ---------- | --------------- | ---------------- |
| Critical   | 1 business day  | 7 calendar days  |
| High       | 3 business days | 30 calendar days |
| Medium     | 5 business days | 90 calendar days |
| Low / Note | Best effort     | Best effort      |

### Disclosure Policy

- We will coordinate disclosure with you
- We request a 90-day disclosure window for non-critical issues
- We will credit reporters (unless anonymity is requested)

## Vulnerability & Alert Triage

This project uses GitHub-native scanning on the `develop` branch. CodeQL and Scorecard findings both surface as code scanning alerts in the same GitHub UI and share the dismissal workflow described below. All findings are triaged against the SLAs in [What to Expect](#what-to-expect).

### Scanning Tools and Coverage

| Tool                                         | Coverage                                             |
| -------------------------------------------- | ---------------------------------------------------- |
| **CodeQL**                                   | Python, JavaScript/TypeScript, C/C++ (Default Setup) |
| **Scorecard**                                | Supply-chain best practices                          |
| **Trivy**                                    | Dockerfile config + dependency CVEs                  |
| **Dependabot**                               | Dependency vulnerabilities                           |
| **GitHub Secret Scanning + Push Protection** | Credential leak prevention                           |

Tool configuration, cadence, and exact workflow names are maintained in `.github/workflows/` and the repository's security settings, refer to those as the source of truth.

### Two-Person Control on Alert Dismissals

To prevent unilateral dismissal of security findings, this repository operates under GitHub's **Delegated Alert Dismissal**, enabled at the `rocketride-org` organization level:

1. **Request**: any maintainer with write access can submit a dismissal request. The request **must** include a documented justification: compensating controls, mitigation rationale, or basis for "accepted risk". This justification is recorded as the dismissal comment on the alert.
2. **Approval**: must be given by a *different* authorized reviewer under GitHub Delegated Alert Dismissal (organization owner, security manager, or explicitly delegated custom role). The requester cannot self-approve.
3. **Dismissal**: GitHub auto-applies the dismissal once approval lands. The full `request → approval → dismissal` trail is preserved on the alert and serves as the system-of-record for audit.

Direct (one-step) dismissal is blocked at the organization level.

### Triage Dispositions

When closing an alert, choose one of:

| Disposition        | When to use                                                          | Evidence captured                                                           |
| ------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Fixed**          | Vulnerability is exploitable in our usage; patch landed              | PR linking the alert (auto-closes on merge)                                 |
| **Mitigated**      | Code path is reachable but compensating controls neutralize the risk | Two-person dismissal with controls listed in comment                        |
| **False positive** | Tool flagged a non-issue (e.g., test fixture, intentional pattern)   | Two-person dismissal with explanation                                       |
| **Accepted risk**  | Risk accepted by ownership                                           | Two-person dismissal with named approver, rationale, and re-evaluation date |

### Secret Scanning & Dependabot

- **Secret Scanning Push Protection** is enabled org-wide. Pushes containing detected secrets are blocked at push time; bypasses require committer justification and are recorded in the audit log.
- **Secret Scanning alerts** for secrets already in the repository follow the same two-person Delegated Alert Dismissal flow (request by any write-access maintainer; approval by a different organization owner, security manager, or holder of an explicitly delegated custom role; auto-dismissal with audit trail).
- **Dependabot alerts** follow the same two-person Delegated Alert Dismissal flow described above:
  - Request by any write-access maintainer; approval by a different organization owner, security manager, or holder of an explicitly delegated custom role.
  - Dismissal reason and any SLA exception must be recorded in the dismissal comment.
  - Fixes are tracked via Dependabot security update PRs against the SLAs above.

## Branch Protection (`develop`)

- All changes land via pull request
- At least 1 code-owner approval required (per `CODEOWNERS`)
- All required CI and security-scanning status checks (as configured in branch protection settings) must pass
- Force-pushes disallowed
- Branch deletion disallowed
- Linear history enforced
- Stale reviews dismissed on new pushes
- **Admin bypass disabled**: protection rule applies to all users including org owners

## Access Reviews

Access to this repository is reviewed **quarterly** by an org owner. The review covers:

1. All members of `rocketride-org`
2. All outside collaborators with any permission level
3. All org owners and their continuing need for that role
4. 2FA compliance across the org

Reviews are documented internally with disposition for each non-employee or elevated-access user.

## Public Vulnerability Disclosure

After remediation lands in a supported version, we publish an advisory at:
https://github.com/rocketride-org/rocketride-server/security/advisories

Reporters are credited unless they request otherwise.

## Security Best Practices

When using RocketRide Engine:

1. **Keep Updated**: Always use the latest version
2. **Credentials**: Never commit credentials or secrets
3. **Dependencies**: Regularly update dependencies
4. **Access Control**: Implement proper access controls
5. **Encryption**: Use encryption for sensitive data

## Security Features

RocketRide Engine includes several security features:

- **Encryption**: Support for data encryption at rest and in transit
- **Authentication**: Configurable authentication mechanisms
- **Keystore**: Secure key management
- **Audit Logging**: Comprehensive activity logging

Thank you for helping keep RocketRide Engine secure!
