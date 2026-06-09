---
title: Windsurf
---

# Windsurf

RocketRide does not ship a dedicated Windsurf extension. Instead, the
[VS Code extension](/ide-extensions/vscode) installs RocketRide agent rules into
your Windsurf project so Windsurf's AI understands how to build RocketRide
pipelines.

When you run the installer, it writes a rules file to `.windsurf/rules/rocketride.md`
in your workspace. Windsurf picks these rules up automatically.

For installation and usage, see the [VS Code extension docs](/ide-extensions/vscode) —
the same extension manages the Windsurf integration.
