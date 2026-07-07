---
title: IDE Extensions
sidebar_label: Overview
---

# IDE Extensions

RocketRide ships a single extension that turns your editor into a visual pipeline builder:
author `.pipe` files on a drag-and-drop canvas, deploy a runtime, run pipelines, and trace
every call, without leaving your IDE.

## Install

| Editor                                        | Install from                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| VS Code                                       | [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=RocketRide.rocketride) |
| VS Code forks (Cursor, Windsurf, VSCodium, …) | [Open VSX Registry](https://open-vsx.org/extension/RocketRide/rocketride)                        |

Or search for **RocketRide** in your editor's Extensions view.

## VS Code and VS Code forks

The same extension supports **VS Code and editors built on it**. VS Code installs it from the
Marketplace; forks such as **Cursor**, **Windsurf**, and **VSCodium** install the identical
build from the Open VSX Registry. The visual canvas, runtime management, and pipeline tooling
are the same everywhere.

On Cursor and Windsurf the extension additionally writes **RocketRide agent rules** into your
workspace so the editor's AI understands how to build RocketRide pipelines.

## Where to go next

- **[VS Code](/ide-extensions/vscode)**: installation, the canvas, deploying a runtime, and
  usage (the detailed guide; applies to all supported editors, including forks like Cursor,
  Windsurf, and VSCodium).
