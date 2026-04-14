"""
Reporter — formats sync results for CLI output and GitHub PR bodies.

Produces two output formats:
  - console: coloured (if supported) plain-text lines for terminal output
  - pr_body:  markdown suitable for a GitHub PR description

The same SyncReport object is passed from the sync orchestrator; each
provider appends its ProviderReport to the shared SyncReport, and at the
end ``format_console`` / ``format_pr_body`` render the full picture.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class ProviderReport:
    """
    Collects the results of syncing a single provider.

    Attributes:
        provider: Display name (e.g. "openai", "anthropic")
        added: list of (profile_key, model_id) tuples for new models
        updated: list of (profile_key, field_name, old_val, new_val)
        deprecated: list of profile_key strings
        skipped: list of (model_id, reason) tuples (smoke test failures)
        unchanged_count: number of profiles with no changes
        estimated_tokens: list of profile_key strings added with a best-guess token limit
                          (no authoritative source); flagged for manual review
        warning: set when the provider was intentionally skipped (e.g. no API key);
                 does NOT cause a non-zero exit code
        error: set if the provider fetch itself failed unexpectedly;
               causes exit code 1
    """

    provider: str
    added: List[tuple] = field(default_factory=list)
    updated: List[tuple] = field(default_factory=list)
    deprecated: List[str] = field(default_factory=list)
    skipped: List[tuple] = field(default_factory=list)
    estimated_tokens: List[str] = field(default_factory=list)
    unchanged_count: int = 0
    warning: Optional[str] = None
    error: Optional[str] = None

    def has_changes(self) -> bool:
        """Return True if any adds, updates, or deprecations occurred."""
        return bool(self.added or self.updated or self.deprecated)


@dataclass
class SyncReport:
    """Aggregates ProviderReports from all providers in a run."""

    providers: List[ProviderReport] = field(default_factory=list)
    dry_run: bool = False
    litellm_available: bool = False
    openrouter_available: bool = False

    def add(self, report: ProviderReport) -> None:
        """Append a provider report."""
        self.providers.append(report)

    def has_any_changes(self) -> bool:
        """Return True if any provider had changes."""
        return any(p.has_changes() for p in self.providers)


def _use_colour() -> bool:
    """Return True if the terminal likely supports ANSI escape codes."""
    return os.environ.get('NO_COLOR') is None and os.isatty(1)


def _c(text: str, code: str) -> str:
    """Wrap text in an ANSI colour code if colour is supported."""
    if not _use_colour():
        return text
    return f'\033[{code}m{text}\033[0m'


def format_console(report: SyncReport) -> str:
    """
    Render the sync report as a plain-text string for terminal output.

    Args:
        report: The completed SyncReport

    Returns:
        Multi-line string ready for print()
    """
    lines: List[str] = []
    mode = '(dry run)' if report.dry_run else '(applied)'
    if report.openrouter_available:
        or_note = 'openrouter ✓'
    else:
        or_note = _c('openrouter ✗', '33')
    if report.litellm_available:
        litellm_note = 'litellm ✓'
    else:
        litellm_note = _c('litellm not installed', '33')
    lines.append(_c(f'=== Sync Models {mode} ===', '1') + f'  [{or_note}]  [{litellm_note}]')

    for pr in report.providers:
        lines.append('')
        if pr.error:
            lines.append(_c(f'[{pr.provider}] ERROR: {pr.error}', '31'))
            continue
        if pr.warning and not pr.has_changes() and not pr.skipped:
            # Pure skip — no changes at all, just a warning
            lines.append(_c(f'[{pr.provider}] SKIPPED: {pr.warning}', '33'))
            continue
        if pr.warning:
            # Ran with a fallback source — show the warning then the changes below
            lines.append(_c(f'[{pr.provider}] WARNING: {pr.warning}', '33'))
        else:
            lines.append(_c(f'[{pr.provider}]', '1'))

        for key, model_id in pr.added:
            lines.append(_c(f'  + {key:<30} {model_id}', '32'))

        for key, field_name, old_val, new_val in pr.updated:
            lines.append(_c(f'  ~ {key:<30} {field_name}: {old_val} → {new_val}', '33'))

        for key in pr.deprecated:
            lines.append(_c(f'  - {key}', '90'))

        for model_id, reason in pr.skipped:
            lines.append(_c(f'  ! {model_id:<30} {reason}', '31'))

        for key in pr.estimated_tokens:
            lines.append(_c(f'  ? {key:<30} token limit is estimated — verify manually', '33'))

        if not pr.has_changes() and not pr.skipped:
            lines.append(_c(f'  (no changes — {pr.unchanged_count} profiles unchanged)', '90'))

    if not report.providers:
        lines.append(_c('  (no providers ran)', '90'))

    return '\n'.join(lines)


def format_pr_body(report: SyncReport) -> str:
    """
    Render the sync report as a GitHub PR body in markdown.

    Args:
        report: The completed SyncReport

    Returns:
        Markdown string suitable for use as a PR description
    """
    lines: List[str] = []
    mode = ' *(dry run — no files changed)*' if report.dry_run else ''
    lines.append(f'## LLM Model Sync{mode}')
    lines.append('')
    lines.append('Automated sync of provider model lists against `services.json` profiles.')
    lines.append('')

    if not report.has_any_changes() and not any(p.skipped for p in report.providers) and not any(p.warning for p in report.providers) and not any(p.error for p in report.providers):
        lines.append('_No changes detected._')
        return '\n'.join(lines)

    for pr in report.providers:
        if pr.warning and not pr.has_changes() and not pr.skipped:
            lines.append(f'### `{pr.provider}` — skipped')
            lines.append('')
            lines.append(f'_{pr.warning}_')
            lines.append('')
            continue
        if pr.error:
            lines.append(f'### `{pr.provider}` — ERROR')
            lines.append('')
            lines.append(f'```\n{pr.error}\n```')
            lines.append('')
            continue

        if not pr.has_changes() and not pr.skipped:
            continue

        lines.append(f'### `{pr.provider}`')
        lines.append('')

        if pr.warning:
            lines.append(f'_{pr.warning}_')
            lines.append('')

        if pr.added:
            lines.append('**Added** (smoke test passed):')
            lines.append('')
            for key, model_id in pr.added:
                lines.append(f'- `{key}` — `{model_id}`')
            lines.append('')

        if pr.updated:
            lines.append('**Updated** (token limits):')
            lines.append('')
            for key, field_name, old_val, new_val in pr.updated:
                lines.append(f'- `{key}` — `{field_name}`: {old_val} → {new_val}')
            lines.append('')

        if pr.deprecated:
            lines.append('**Deprecated** (no longer in API):')
            lines.append('')
            for key in pr.deprecated:
                lines.append(f'- `{key}`')
            lines.append('')

        if pr.skipped:
            lines.append('**Skipped** (smoke test failed — needs manual review):')
            lines.append('')
            for model_id, reason in pr.skipped:
                lines.append(f'- `{model_id}` — {reason}')
            lines.append('')

    lines.append('---')
    lines.append('*Generated by `tools/src/sync_models.py`*')

    return '\n'.join(lines)
