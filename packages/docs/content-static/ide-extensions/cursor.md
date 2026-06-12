---
title: Cursor
---

# Cursor

RocketRide does not ship a dedicated Cursor extension. Instead, the
[VS Code extension](/ide-extensions/vscode) installs RocketRide agent rules into
your Cursor project so Cursor's AI understands how to build RocketRide pipelines.

When you run the installer, it writes a rules file to `.cursor/rules/rocketride.mdc`
in your workspace. Cursor picks these rules up automatically.

For installation and usage, see the [VS Code extension docs](/ide-extensions/vscode) —
the same extension manages the Cursor integration.
