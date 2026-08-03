// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * shell/client — the RocketRide SDK surface, mediated by the shell.
 *
 * Apps never depend on the 'rocketride' package directly: the SDK version
 * travels with the shell (it is a dependency of the shell package), and
 * this subpath is the ONE door to its runtime values — protocol classes
 * (Question), enums (QuestionType), constants (PROJECT_DIR), and every
 * type. The main 'shell' barrel remains types-only for the SDK; client
 * INSTANCES still only arrive via useShellConnection().
 *
 * In MF remotes this module is a host-provided singleton share
 * ('shell/client'), so protocol classes keep one identity across the
 * host boundary. Static hosts (the vscode webviews / extension) bundle
 * it from the installed shell package.
 */

export * from 'rocketride';
