# Governance

This document describes the governance model for the RocketRide Engine project.

## Roles

### Contributor

Anyone who submits a pull request, opens an issue, or participates in discussions. Contributors are expected to follow the [Contributing Guide](CONTRIBUTING.md) and the Code of Conduct.

### Reviewer

Trusted contributors who review pull requests for specific modules. Reviewers are listed in [CODEOWNERS](.github/CODEOWNERS) and are expected to provide timely, constructive feedback.

To become a reviewer:
- Demonstrate sustained, quality contributions to a specific module
- Be nominated by an existing maintainer

### Maintainer

Maintainers have write access and are responsible for the overall direction of the project. They merge PRs, manage releases, and make architectural decisions.

Current maintainers are members of the [@rocketride-org/maintainers](https://github.com/orgs/rocketride-org/teams/maintainers) team.

## Decision Making

- **Day-to-day decisions** (bug fixes, minor features) are made by the reviewer and maintainer who approve and merge the PR.
- **Significant changes** (new modules, breaking changes, architectural shifts) require discussion in a GitHub Issue or Discussion before implementation. At least two maintainers must approve.
- **Disputes** are resolved by maintainer consensus. If consensus cannot be reached, the project lead makes the final call.

## Adding Maintainers

New maintainers are nominated by existing maintainers and require unanimous approval from current maintainers. Nominations should be based on:

- Consistent, high-quality contributions over an extended period
- Deep understanding of the project architecture
- Demonstrated good judgment in code review and technical decisions

## Changes to Governance

Changes to this document require approval from all current maintainers.
