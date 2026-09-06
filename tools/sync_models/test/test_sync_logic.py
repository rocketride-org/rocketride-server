"""
Offline tests for the sync script logic.

These tests require no server, no running engine, and no API keys.
They test the merge, deprecation, smoke-test gate, and comment-preservation
logic against mocked provider responses.

Run: pytest tools/sync_models/test/test_sync_logic.py
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

# tools/sync_models/src is added to sys.path by conftest.py
from core.merger import (
    merge,
    _make_profile_key,
    _derive_title,
    find_swapped_output_profiles,
    _source_is_authoritative,
    _migration_from_provider,
    CALL_VERIFIED,
)
from core.smoke import classify_failure
from providers.base import is_retirement_anomaly


class _NotFound(Exception):
    """Stands in for openai/anthropic NotFoundError and google-genai ClientError."""

    def __init__(self, message):
        super().__init__(message)
        self.status_code = 404


def _not_found(message):
    return _NotFound(message)


from core.smoke import run
from core.patcher import load as patcher_load, patch as patcher_patch, get_profiles
from core.reporter import SyncReport, ProviderReport, format_console, format_pr_body
import sync_models


# ---------------------------------------------------------------------------
# merger.py tests
# ---------------------------------------------------------------------------


class TestMakeProfileKey:
    def test_dots_become_hyphens(self):
        assert _make_profile_key('claude-sonnet-4.6') == 'claude-sonnet-4-6'

    def test_underscores_become_hyphens(self):
        assert _make_profile_key('gpt_4o') == 'gpt-4o'

    def test_slashes_become_hyphens(self):
        assert _make_profile_key('models/gemini-2.5-pro') == 'models-gemini-2-5-pro'

    def test_colons_become_hyphens(self):
        assert _make_profile_key('deepseek-r1:8b') == 'deepseek-r1-8b'

    def test_already_normalised(self):
        assert _make_profile_key('gpt-4o') == 'gpt-4o'

    def test_lowercase(self):
        assert _make_profile_key('GPT-4O') == 'gpt-4o'


class TestDeriveTitle:
    def test_known_prefix(self, title_mappings):
        assert _derive_title('gpt-4o', title_mappings) == 'GPT-4o'

    def test_claude_prefix(self, title_mappings):
        assert _derive_title('claude-sonnet-4-6', title_mappings) == 'Claude Sonnet 4.6'

    def test_fallback_capitalise(self, title_mappings):
        result = _derive_title('unknown-model-x', title_mappings)
        assert result[0].isupper()

    def test_empty_string(self, title_mappings):
        assert _derive_title('', title_mappings) == ''


class TestMerge:
    def test_new_model_added(self, current_profiles, title_mappings):
        api_models = [
            {'id': 'test-model-a'},
            {'id': 'test-model-b'},
            {'id': 'test-model-c'},  # NEW
        ]
        updated, result = merge(
            current_profiles=current_profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={'test-model-c': 65536},
            output_token_overrides={},
            default_output_tokens=4096,
            extra_profile_fields={'apikey': ''},
        )
        assert len(result.added) == 1
        key, profile = result.added[0]
        assert key == 'test-model-c'
        assert profile['model'] == 'test-model-c'
        assert profile['modelTotalTokens'] == 65536
        assert profile['apikey'] == ''

    def test_missing_model_deprecated(self, current_profiles, title_mappings):
        # test-model-b is absent from API
        api_models = [{'id': 'test-model-a'}]
        updated, result = merge(
            current_profiles=current_profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        assert 'test-model-b' in result.deprecated
        assert updated['test-model-b'].get('deprecated') is True

    def test_token_limit_updated(self, current_profiles, title_mappings):
        # test-model-a gets a new token limit from API
        api_models = [
            {'id': 'test-model-a'},
            {'id': 'test-model-b'},
        ]
        updated, result = merge(
            current_profiles=current_profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={'test-model-a': 99999},  # override differs from current 16384
            output_token_overrides={},
            default_output_tokens=4096,
        )
        changed_keys = [r[0] for r in result.updated]
        assert 'test-model-a' in changed_keys
        assert updated['test-model-a']['modelTotalTokens'] == 99999

    def test_no_changes_when_identical(self, current_profiles, title_mappings):
        api_models = [
            {'id': 'test-model-a'},
            {'id': 'test-model-b'},
        ]
        updated, result = merge(
            current_profiles=current_profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={
                'test-model-a': 16384,  # Same as current
                'test-model-b': 32768,  # Same as current
            },
            output_token_overrides={},
            default_output_tokens=4096,
        )
        assert result.added == []
        assert result.updated == []
        assert result.deprecated == []
        assert set(result.unchanged) == {'test-model-a', 'test-model-b'}

    def test_already_deprecated_model_stays_unchanged(self, title_mappings):
        profiles = {
            'test-model-a': {
                'title': 'Test Model A',
                'model': 'test-model-a',
                'modelTotalTokens': 16384,
                'deprecated': True,
                'apikey': '',
            }
        }
        api_models = []  # Still absent
        updated, result = merge(
            current_profiles=profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        # Already deprecated — should be in unchanged, not deprecated again
        assert 'test-model-a' not in result.deprecated
        assert 'test-model-a' in result.unchanged

    def test_deprecated_model_reinstated_when_back_in_api(self, title_mappings):
        profiles = {
            'test-model-a': {
                'title': 'Test Model A',
                'model': 'test-model-a',
                'modelTotalTokens': 16384,
                'deprecated': True,
                # Marked by the sync, so the sync may lift it again. Without this the
                # mark is a human's and stays — see TestDeprecationIsNotUndoneByTheSync.
                'deprecatedBy': 'provider',
                'apikey': '',
            }
        }
        api_models = [{'id': 'test-model-a'}]  # Back in API
        updated, result = merge(
            current_profiles=profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={'test-model-a': 16384},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        assert updated['test-model-a'].get('deprecated') is None
        assert any(r[0] == 'test-model-a' and r[1] == 'deprecated' for r in result.updated)

    def test_new_profile_gets_apikey_field(self, current_profiles, title_mappings):
        api_models = [
            {'id': 'test-model-a'},
            {'id': 'test-model-b'},
            {'id': 'test-model-new'},
        ]
        updated, result = merge(
            current_profiles=current_profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={'test-model-new': 32768},
            output_token_overrides={},
            default_output_tokens=4096,
            extra_profile_fields={'apikey': ''},
        )
        new_profile = updated.get('test-model-new', {})
        assert 'apikey' in new_profile


class TestModelSources:
    """Tests for the new --model-source ordering and discovery semantics."""

    def test_default_model_sources_used_when_none_passed(self, current_profiles, title_mappings):
        """merge() must accept model_sources=None and fall back to default order."""
        api_models = [{'id': 'test-model-a'}]
        updated, result = merge(
            current_profiles=current_profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
            model_sources=None,  # explicit None — should default to all three
        )
        # No crash; existing profile is processed normally.
        assert 'test-model-a' in updated

    def test_provider_API_ctx_wins_with_default_order(self, current_profiles, title_mappings):
        """When the api_entry is from the provider API and has context_window, that value wins."""
        api_models = [
            {'id': 'test-model-a', 'context_window': 99999},  # _source defaults to 'provider API'
        ]
        updated, result = merge(
            current_profiles=current_profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
            model_sources=['provider', 'openrouter', 'litellm'],
        )
        assert updated['test-model-a']['modelTotalTokens'] == 99999
        assert updated['test-model-a'].get('_src_modelTotalTokens') == 'provider API'

    def test_openrouter_source_marks_modelSource(self, current_profiles, title_mappings):
        """An api_entry with _source='openrouter' produces modelSource='openrouter' on new profiles."""
        api_models = [
            {'id': 'test-model-new', '_source': 'openrouter', 'context_window': 32000},
        ]
        updated, result = merge(
            current_profiles=current_profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
            model_sources=['openrouter', 'litellm'],
            extra_profile_fields={'apikey': ''},
        )
        new_profile = updated['test-model-new']
        assert new_profile['modelSource'] == 'openrouter'
        assert new_profile['modelTotalTokens'] == 32000

    def test_config_override_wins_over_all_sources(self, current_profiles, title_mappings):
        """token_limit_overrides always wins, regardless of model_sources order or content."""
        api_models = [
            {'id': 'test-model-a', 'context_window': 50000},
        ]
        updated, result = merge(
            current_profiles=current_profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={'test-model-a': 123456},
            output_token_overrides={},
            default_output_tokens=4096,
            model_sources=['provider'],
        )
        assert updated['test-model-a']['modelTotalTokens'] == 123456
        assert updated['test-model-a'].get('_src_modelTotalTokens') == 'sync_models.config.json'


# ---------------------------------------------------------------------------
# patcher.py tests
# ---------------------------------------------------------------------------


class TestPatcher:
    def test_load_json5(self, sample_services_json_file):
        data = patcher_load(sample_services_json_file)
        assert 'preconfig' in data
        assert 'profiles' in data['preconfig']

    def test_get_profiles(self, sample_services_json_file, current_profiles):
        profiles = get_profiles(sample_services_json_file)
        assert set(profiles.keys()) == {'test-model-a', 'test-model-b'}
        assert profiles['test-model-a']['modelTotalTokens'] == 16384

    def test_patch_preserves_comments(self, sample_services_json_file):
        original = Path(sample_services_json_file).read_text(encoding='utf-8')
        assert '// Node configuration' in original

        new_profiles = {
            'test-model-a': {
                'title': 'Test Model A',
                'model': 'test-model-a',
                'modelTotalTokens': 16384,
                'apikey': '',
            },
            'test-model-c': {
                'title': 'Test Model C',
                'model': 'test-model-c',
                'modelTotalTokens': 65536,
                'apikey': '',
            },
        }
        result = patcher_patch(sample_services_json_file, new_profiles, dry_run=True)

        # Comments must survive
        assert '// Node configuration' in result
        assert '// Preconfig section' in result
        assert '// Available profiles' in result

        # New model must be present
        assert 'test-model-c' in result

        # Removed model must be gone
        assert 'test-model-b' not in result

    def test_patch_dry_run_does_not_write(self, sample_services_json_file):
        original = Path(sample_services_json_file).read_text(encoding='utf-8')
        new_profiles = {'only-new': {'title': 'Only New', 'model': 'only-new', 'modelTotalTokens': 1024}}
        patcher_patch(sample_services_json_file, new_profiles, dry_run=True)
        after = Path(sample_services_json_file).read_text(encoding='utf-8')
        assert original == after  # File must be untouched

    def test_patch_apply_writes_file(self, sample_services_json_file):
        new_profiles = {
            'test-model-a': {
                'title': 'Test Model A Updated',
                'model': 'test-model-a',
                'modelTotalTokens': 32000,
                'apikey': '',
            }
        }
        patcher_patch(sample_services_json_file, new_profiles, dry_run=False)

        # Re-read and verify
        updated_profiles = get_profiles(sample_services_json_file)
        assert 'test-model-a' in updated_profiles
        assert updated_profiles['test-model-a']['modelTotalTokens'] == 32000
        assert 'test-model-b' not in updated_profiles


# ---------------------------------------------------------------------------
# smoke.py tests
# ---------------------------------------------------------------------------


class TestSmokeTest:
    def test_pass_on_successful_call(self):
        from core.smoke import run

        client = MagicMock()
        completion = MagicMock()
        completion.choices = [MagicMock()]
        client.chat.completions.create.return_value = completion

        result = run('chat_openai_compat', client, 'gpt-test')
        assert result.passed()
        assert result.outcome == 'pass'

    def test_skip_on_auth_error(self):
        from core.smoke import run

        client = MagicMock()
        client.chat.completions.create.side_effect = Exception('403 Forbidden access_denied')

        result = run('chat_openai_compat', client, 'gpt-test')
        assert not result.passed()
        assert result.outcome == 'skip'

    def test_smoke_gates_new_model(self, current_profiles, title_mappings):
        """
        When a new model fails smoke test, it must not appear in the updated profiles.
        The sync pipeline in CloudProvider.sync() uses smoke to gate new models.
        """
        # Simulate what CloudProvider.sync() does:
        # new model "test-model-c" would be smoke-tested before adding
        client = MagicMock()
        client.chat.completions.create.side_effect = Exception('403 access_denied')

        result = run('chat_openai_compat', client, 'test-model-c')
        assert not result.passed()

        # Because smoke failed, we do NOT pass this model to merge()
        # so it should not appear in updated_profiles
        verified_models = []  # smoke failed → not included
        updated, merge_result = merge(
            current_profiles=current_profiles,
            api_models=verified_models,
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        assert 'test-model-c' not in updated

    def test_unknown_smoke_type_raises(self):
        from core.smoke import run

        with pytest.raises(KeyError):
            run('chat_unknown_provider', MagicMock(), 'some-model')


# ---------------------------------------------------------------------------
# reporter.py tests
# ---------------------------------------------------------------------------


class TestReporter:
    def _make_report(self, dry_run: bool = False) -> SyncReport:
        report = SyncReport(dry_run=dry_run)
        pr = ProviderReport(provider='llm_openai')
        pr.added = [('gpt-o3', {'title': 'GPT-o3', 'model': 'gpt-o3', 'modelTotalTokens': 200000})]
        pr.updated = [('gpt-4o', 'modelTotalTokens', 128000, 200000)]
        pr.deprecated = ['gpt-4-turbo']
        pr.skipped = [('gpt-o5-preview', '503 model_overloaded')]
        report.add(pr)
        return report

    def test_console_includes_provider_name(self):
        report = self._make_report()
        output = format_console(report)
        assert 'llm_openai' in output

    def test_console_shows_added_model(self):
        report = self._make_report()
        output = format_console(report)
        assert 'gpt-o3' in output

    def test_console_shows_deprecated_model(self):
        report = self._make_report()
        output = format_console(report)
        assert 'gpt-4-turbo' in output

    def test_pr_body_is_markdown(self):
        report = self._make_report()
        body = format_pr_body(report)
        assert '##' in body
        assert '`llm_openai`' in body

    def test_pr_body_dry_run_label(self):
        report = self._make_report(dry_run=True)
        body = format_pr_body(report)
        assert 'dry run' in body.lower()

    def test_pr_body_no_changes(self):
        report = SyncReport(dry_run=False)
        pr = ProviderReport(provider='llm_test')
        pr.unchanged_count = 5
        report.add(pr)
        body = format_pr_body(report)
        assert 'No changes' in body

    def test_error_provider_shown_in_console(self):
        report = SyncReport()
        pr = ProviderReport(provider='llm_broken')
        pr.error = 'Connection refused'
        report.add(pr)
        output = format_console(report)
        assert 'ERROR' in output

    def test_discovery_skipped_shown_in_console(self):
        """When discovery_skipped is set, the console output must surface the hint."""
        report = SyncReport()
        pr = ProviderReport(provider='llm_anthropic')
        pr.discovery_skipped = True
        pr.unchanged_count = 5
        report.add(pr)
        output = format_console(report)
        assert 'discovery skipped' in output.lower()

    def test_discovery_skipped_shown_in_pr_body(self):
        """When discovery_skipped is set, the PR body must include the warning even with no changes."""
        report = SyncReport()
        pr = ProviderReport(provider='llm_anthropic')
        pr.discovery_skipped = True
        pr.unchanged_count = 5
        report.add(pr)
        body = format_pr_body(report)
        assert 'Discovery skipped' in body
        assert 'llm_anthropic' in body


# ---------------------------------------------------------------------------
# CLI flag validation tests
# ---------------------------------------------------------------------------


class TestCliValidation:
    """argparse-level validation for the new flag set."""

    def _run_cli(self, *args):
        """Invoke sync_models.py as a subprocess and return (returncode, stderr)."""
        import subprocess
        import sys

        repo_root = Path(__file__).resolve().parents[3]
        script = repo_root / 'tools' / 'sync_models' / 'src' / 'sync_models.py'
        result = subprocess.run(
            [sys.executable, str(script), *args],
            capture_output=True,
            text=True,
            cwd=str(repo_root),
        )
        return result.returncode, result.stderr

    def test_allow_fallback_requires_enable_discovery(self):
        rc, stderr = self._run_cli('--provider', 'llm_openai', '--allow-fallback-discovery')
        assert rc != 0
        assert '--allow-fallback-discovery' in stderr
        assert '--enable-discovery' in stderr

    def test_duplicate_model_source_rejected(self):
        rc, stderr = self._run_cli(
            '--provider',
            'llm_openai',
            '--model-source',
            'provider',
            '--model-source',
            'provider',
        )
        assert rc != 0
        assert 'must not be repeated' in stderr.lower() or 'duplicate' in stderr.lower() or '--model-source' in stderr


# ---------------------------------------------------------------------------
# Swapped output tokens (context window reported as the completion limit)
# ---------------------------------------------------------------------------


class TestSwappedOutputTokens:
    def test_swapped_candidate_is_not_used_for_new_profile(self, current_profiles, title_mappings):
        # Source reports the same number for both fields — the swap signature.
        api_models = [
            {'id': 'test-model-a'},
            {'id': 'test-model-b'},
            {'id': 'test-model-c', 'context_window': 128000, 'max_output_tokens': 128000},
        ]
        updated, result = merge(
            current_profiles=current_profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
            output_limit_below_context=True,
        )
        profile = updated['test-model-c']
        assert profile['modelTotalTokens'] == 128000
        assert profile['modelOutputTokens'] == 4096

    def test_equal_values_kept_when_provider_has_no_separate_limit(self, current_profiles, title_mappings):
        # Mistral and xAI accept max_tokens up to the window, so equality is real data.
        api_models = [
            {'id': 'test-model-a'},
            {'id': 'test-model-b'},
            {'id': 'test-model-c', 'context_window': 128000, 'max_output_tokens': 128000},
        ]
        updated, _ = merge(
            current_profiles=current_profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        assert updated['test-model-c']['modelOutputTokens'] == 128000

    def test_genuine_output_limit_is_kept(self, current_profiles, title_mappings):
        api_models = [
            {'id': 'test-model-a'},
            {'id': 'test-model-b'},
            {'id': 'test-model-c', 'context_window': 128000, 'max_output_tokens': 32768},
        ]
        updated, _ = merge(
            current_profiles=current_profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        assert updated['test-model-c']['modelOutputTokens'] == 32768

    def test_override_still_wins_over_source(self, current_profiles, title_mappings):
        api_models = [
            {'id': 'test-model-a'},
            {'id': 'test-model-b'},
            {'id': 'test-model-c', 'context_window': 128000, 'max_output_tokens': 128000},
        ]
        updated, _ = merge(
            current_profiles=current_profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={'test-model-c': 16384},
            default_output_tokens=4096,
            output_limit_below_context=True,
        )
        assert updated['test-model-c']['modelOutputTokens'] == 16384

    def test_fallback_default_does_not_overwrite_existing_value(self, title_mappings):
        # A profile that already carries a real limit must survive a source that
        # only offers a swapped value — the 4096 default is for new profiles.
        profiles = {
            'test-model-a': {
                'title': 'Test Model A',
                'model': 'test-model-a',
                'modelSource': 'provider',
                'modelTotalTokens': 128000,
                'modelOutputTokens': 32768,
                'apikey': '',
            },
        }
        api_models = [{'id': 'test-model-a', 'context_window': 128000, 'max_output_tokens': 128000}]
        updated, _ = merge(
            current_profiles=profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
            output_limit_below_context=True,
        )
        assert updated['test-model-a']['modelOutputTokens'] == 32768

    def test_find_swapped_output_profiles(self):
        profiles = {
            'bad': {'model': 'm1', 'modelSource': 'provider', 'modelTotalTokens': 131072, 'modelOutputTokens': 131072},
            'good': {'model': 'm2', 'modelSource': 'provider', 'modelTotalTokens': 131072, 'modelOutputTokens': 32768},
            'no-output-key': {'model': 'm3', 'modelTotalTokens': 131072},
            'custom': {'model': ''},
        }
        assert find_swapped_output_profiles(profiles) == [('bad', 131072)]

    def test_deprecated_and_confirmed_profiles_are_not_reported(self):
        profiles = {
            'dead': {
                'model': 'm1',
                'deprecated': True,
                'modelTotalTokens': 131072,
                'modelOutputTokens': 131072,
            },
            'confirmed': {'model': 'm2', 'modelTotalTokens': 16384, 'modelOutputTokens': 16384},
            'suspect': {'model': 'm3', 'modelTotalTokens': 131072, 'modelOutputTokens': 131072},
        }
        assert find_swapped_output_profiles(profiles, confirmed_models={'m2'}) == [('suspect', 131072)]

    def test_native_only_skips_routed_aliases(self):
        profiles = {
            'native': {
                'model': 'm1',
                'modelSource': 'provider',
                'modelTotalTokens': 131072,
                'modelOutputTokens': 131072,
            },
            'routed': {
                'model': 'm2',
                'modelSource': 'openrouter',
                'modelTotalTokens': 131072,
                'modelOutputTokens': 131072,
            },
        }
        assert find_swapped_output_profiles(profiles, native_only=True) == [('native', 131072)]
        assert len(find_swapped_output_profiles(profiles)) == 2

    def test_catalogue_gate_is_clean(self):
        # The real gate: fails only where the provider caps completions below its
        # window and the profile came from that provider's own API.
        repo_root = Path(__file__).resolve().parents[3]
        config = sync_models._load_config()
        providers = sorted(sync_models._PROVIDER_REGISTRY)
        errors, _ = sync_models.check_swapped_outputs(repo_root, providers, config)
        assert not errors, 'Profiles sending the context window as max_tokens:\n' + '\n'.join(
            f'{p}: {k} ({v:,})' for p, k, v in errors
        )


# ---------------------------------------------------------------------------
# Deprecation authority
# ---------------------------------------------------------------------------


class TestSourceAuthority:
    def test_a_source_owns_the_profiles_it_discovered(self):
        assert _source_is_authoritative('provider', 'provider') is True
        assert _source_is_authoritative('provider', 'manual') is True
        assert _source_is_authoritative('openrouter', 'openrouter') is True
        assert _source_is_authoritative('litellm', 'litellm') is True

    def test_a_source_has_no_authority_over_another_source_profile(self):
        assert _source_is_authoritative('provider', 'openrouter') is False
        assert _source_is_authoritative('openrouter', 'provider') is False
        assert _source_is_authoritative('openrouter', 'manual') is False
        assert _source_is_authoritative('litellm', 'openrouter') is False

    def test_display_labels_are_not_accepted_as_keys(self):
        # Authority is decided on canonical keys only; a label must never reach here.
        assert _source_is_authoritative('Anthropic API', 'provider') is False
        assert _source_is_authoritative('OpenRouter', 'openrouter') is False
        assert _source_is_authoritative('something else', 'provider') is False


class TestDeprecationIsNotUndoneByTheSync:
    def _profile(self, **extra):
        base = {
            'title': 'Test Model A',
            'model': 'test-model-a',
            'modelSource': 'provider',
            'modelTotalTokens': 16384,
            'modelOutputTokens': 4096,
            'deprecated': True,
            'migration': "Please use 'test-model-b' instead",
            'apikey': '',
        }
        base.update(extra)
        return {'test-model-a': base}

    def test_hand_marked_profile_survives_the_model_reappearing(self, title_mappings):
        # No deprecatedBy — a human marked this. The provider listing still returning
        # the model is exactly the case that made someone mark it by hand.
        updated, _ = merge(
            current_profiles=self._profile(),
            api_models=[{'id': 'test-model-a'}],
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        assert updated['test-model-a'].get('deprecated') is True
        assert updated['test-model-a'].get('migration') == "Please use 'test-model-b' instead"

    def test_sync_marked_profile_is_lifted_when_the_model_returns(self, title_mappings):
        updated, result = merge(
            current_profiles=self._profile(deprecatedBy='provider'),
            api_models=[{'id': 'test-model-a'}],
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        profile = updated['test-model-a']
        assert profile.get('deprecated') is None
        assert profile.get('deprecatedBy') is None
        assert profile.get('migration') is None
        assert any(r[0] == 'test-model-a' and r[1] == 'deprecated' for r in result.updated)

    def test_an_authoritative_source_lifts_a_mark_another_source_applied(self, title_mappings):
        # A keyless run can stamp deprecatedBy='openrouter' on a 'provider' profile via
        # the expiration branch. Requiring the stamp to match would strand it deprecated
        # with no source able to clear it, so authority over the profile is what counts.
        updated, _ = merge(
            current_profiles=self._profile(deprecatedBy='openrouter'),
            api_models=[{'id': 'test-model-a'}],
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        assert updated['test-model-a'].get('deprecated') is None

    def test_a_source_without_authority_cannot_lift(self, title_mappings):
        updated, _ = merge(
            current_profiles=self._profile(modelSource='openrouter', deprecatedBy='openrouter'),
            api_models=[{'id': 'test-model-a'}],
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
            deprecation_source_key='provider',
        )
        assert updated['test-model-a'].get('deprecated') is True

    def test_a_standing_mark_is_reported_not_silent(self, title_mappings):
        _, result = merge(
            current_profiles=self._profile(),
            api_models=[{'id': 'test-model-a'}],
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        assert result.reappeared_deprecated == ['test-model-a']

    def test_deprecating_records_the_source(self, current_profiles, title_mappings):
        # test-model-b absent from the API, discovered by the native provider.
        updated, result = merge(
            current_profiles=current_profiles,
            api_models=[{'id': 'test-model-a'}],
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
            deprecation_source='Anthropic API',
            deprecation_source_key='provider',
        )
        assert 'test-model-b' in result.deprecated
        assert updated['test-model-b']['deprecatedBy'] == 'provider'


class TestReappearedDeprecatedIsReported:
    def test_a_provider_whose_only_finding_is_a_standing_mark_is_not_a_pure_skip(self):
        pr = ProviderReport(provider='llm_gemini')
        pr.reappeared_deprecated = ['gemini-3-pro-image']
        assert pr.has_changes() is True

    def test_it_survives_the_skip_path_in_the_console_output(self):
        pr = ProviderReport(provider='llm_gemini')
        pr.warning = 'ran without a key'
        pr.reappeared_deprecated = ['gemini-3-pro-image']
        report = SyncReport(providers=[pr])
        assert 'gemini-3-pro-image' in format_console(report)

    def test_it_survives_into_the_pr_body(self):
        pr = ProviderReport(provider='llm_gemini')
        pr.reappeared_deprecated = ['gemini-3-pro-image']
        assert 'gemini-3-pro-image' in format_pr_body(SyncReport(providers=[pr]))


# ---------------------------------------------------------------------------
# Re-verifying models already in the catalogue
# ---------------------------------------------------------------------------


class TestRetiredModelsDeprecation:
    def _profiles(self, model_source='openrouter'):
        return {
            'test-model-a': {
                'title': 'Test Model A',
                'model': 'test-model-a',
                'modelSource': model_source,
                'modelTotalTokens': 16384,
                'modelOutputTokens': 4096,
                'apikey': '',
            }
        }

    def test_a_direct_refusal_deprecates_regardless_of_who_discovered_it(self, title_mappings):
        # The provider API has no authority over an 'openrouter' profile when the
        # signal is absence from a listing. A refusal to run it is different.
        updated, result = merge(
            current_profiles=self._profiles(model_source='openrouter'),
            api_models=[{'id': 'test-model-a'}],
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
            retired_models={'test-model-a': '404 NOT_FOUND: no longer available'},
        )
        assert updated['test-model-a']['deprecated'] is True
        # Marked as call-verified, not as the source: the listing path must not lift it.
        assert updated['test-model-a']['deprecatedBy'] == CALL_VERIFIED
        assert 'test-model-a' in result.deprecated

    def test_the_providers_suggested_replacement_becomes_the_migration_note(self, title_mappings):
        updated, _ = merge(
            current_profiles=self._profiles(),
            api_models=[{'id': 'test-model-a'}],
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
            retired_models={
                'test-model-a': (
                    'This model models/gemini-2.5-flash is no longer available to new users. '
                    'Please update your code to use models/gemini-3.6-flash instead.'
                )
            },
        )
        assert 'models/gemini-3.6-flash' in updated['test-model-a']['migration']

    def test_a_hand_written_migration_note_is_kept(self, title_mappings):
        profiles = self._profiles()
        profiles['test-model-a']['migration'] = "Please use 'test-model-b' instead"
        updated, _ = merge(
            current_profiles=profiles,
            api_models=[{'id': 'test-model-a'}],
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
            retired_models={'test-model-a': '404 not found'},
        )
        assert updated['test-model-a']['migration'] == "Please use 'test-model-b' instead"

    def test_nothing_changes_without_verification(self, title_mappings):
        updated, result = merge(
            current_profiles=self._profiles(),
            api_models=[{'id': 'test-model-a'}],
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        assert updated['test-model-a'].get('deprecated') is None
        assert result.deprecated == []


class TestMigrationFromProvider:
    def test_extracts_the_named_replacement(self):
        note = _migration_from_provider('Please update your code to use models/gemini-3.6-flash.', 'Gemini API')
        assert "'models/gemini-3.6-flash'" in note

    def test_falls_back_when_no_replacement_is_named(self):
        note = _migration_from_provider('404 not found', 'Gemini API')
        assert 'Gemini API' in note

    def test_ignores_prose_that_is_not_a_model_id(self):
        note = _migration_from_provider('You must use a valid key to continue', 'Gemini API')
        assert 'Please select a current model' in note


class TestCallVerifiedMarksSurviveTheListing:
    """
    The premise of a call-verified retirement is that the provider still lists
    the model. So the listing path must not be able to lift one, or the next
    scheduled run — which never passes --verify-existing — resurrects it and
    deletes the provider's replacement note.
    """

    def _marked(self, deprecated_by):
        return {
            'test-model-a': {
                'title': 'Test Model A',
                'model': 'test-model-a',
                'modelSource': 'provider',
                'modelTotalTokens': 16384,
                'modelOutputTokens': 4096,
                'deprecated': True,
                'deprecatedBy': deprecated_by,
                'migration': "Model retired by the provider. Please use 'test-model-b' instead.",
                'apikey': '',
            }
        }

    def test_a_listing_run_does_not_resurrect_a_call_made_mark(self, title_mappings):
        updated, _ = merge(
            current_profiles=self._marked(CALL_VERIFIED),
            api_models=[{'id': 'test-model-a'}],  # still listed, as expected
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        assert updated['test-model-a']['deprecated'] is True
        assert 'test-model-b' in updated['test-model-a']['migration']

    def test_a_listing_run_still_lifts_a_listing_made_mark(self, title_mappings):
        updated, _ = merge(
            current_profiles=self._marked('provider'),
            api_models=[{'id': 'test-model-a'}],
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        assert updated['test-model-a'].get('deprecated') is None

    def test_a_passing_call_lifts_a_call_made_mark(self, title_mappings):
        updated, result = merge(
            current_profiles=self._marked(CALL_VERIFIED),
            api_models=[{'id': 'test-model-a'}],
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
            revived_models={'test-model-a'},
        )
        assert updated['test-model-a'].get('deprecated') is None
        assert updated['test-model-a'].get('deprecatedBy') is None
        assert any(r[0] == 'test-model-a' and r[1] == 'deprecated' for r in result.updated)

    def test_a_call_that_did_not_pass_leaves_it_marked(self, title_mappings):
        updated, _ = merge(
            current_profiles=self._marked(CALL_VERIFIED),
            api_models=[{'id': 'test-model-a'}],
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
            revived_models=set(),
        )
        assert updated['test-model-a']['deprecated'] is True


class TestFailureClassification:
    def test_an_explicit_retirement_is_the_only_thing_that_deprecates(self):
        error = _not_found('This model is no longer available to new users. Please use model-y')
        assert classify_failure(error).outcome == 'retired'

    def test_a_bare_404_is_reported_not_acted_on(self):
        # OpenAI answers this for a retired model and for one the key cannot reach.
        error = _not_found('The model `gpt-x` does not exist or you do not have access to it.')
        assert classify_failure(error).outcome == 'missing'

    def test_a_method_mismatch_is_not_a_retirement(self):
        error = _not_found('models/x is not found for API version v1beta, or is not supported for generateContent')
        assert classify_failure(error).outcome == 'missing'

    def test_a_transient_failure_never_looks_like_a_retirement(self):
        for message in ('429 rate limit exceeded', '503 service unavailable', 'connection timeout', 'overloaded'):
            assert classify_failure(Exception(message)).outcome == 'error', message

    def test_a_404_in_the_text_of_an_untyped_error_is_not_a_404(self):
        # The old string match turned any message mentioning 404 into a retirement.
        assert classify_failure(Exception('failed to fetch the 404 page')).outcome != 'retired'

    def test_an_auth_failure_is_not_a_retirement(self):
        assert classify_failure(Exception('401 unauthorized')).outcome == 'skip'
        assert classify_failure(Exception('permission denied for this model')).outcome == 'skip'


class TestOpenRouterExpirationRespectsOwnership:
    """
    An expiry OpenRouter publishes is evidence about the models it serves, not
    about one the native provider still supports. Acting on it regardless of
    ownership lets a keyless run hide a working model.
    """

    def _profile(self, model_source):
        return {
            'test-model-a': {
                'title': 'Test Model A',
                'model': 'test-model-a',
                'modelSource': model_source,
                'modelTotalTokens': 16384,
                'modelOutputTokens': 4096,
                'apikey': '',
            }
        }

    def _expired_entry(self):
        return [{'id': 'test-model-a', '_source': 'openrouter', 'expiration_date': '2026-01-01'}]

    def test_it_deprecates_a_profile_openrouter_owns(self, title_mappings):
        updated, result = merge(
            current_profiles=self._profile('openrouter'),
            api_models=self._expired_entry(),
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        assert updated['test-model-a']['deprecated'] is True
        assert updated['test-model-a']['deprecatedBy'] == 'openrouter'
        assert 'test-model-a' in result.deprecated

    def test_it_leaves_a_native_profile_alone(self, title_mappings):
        updated, result = merge(
            current_profiles=self._profile('provider'),
            api_models=self._expired_entry(),
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        assert updated['test-model-a'].get('deprecated') is None
        assert 'test-model-a' not in result.deprecated

    def test_it_leaves_a_hand_added_profile_alone(self, title_mappings):
        updated, _ = merge(
            current_profiles=self._profile('manual'),
            api_models=self._expired_entry(),
            title_mappings=title_mappings,
            token_overrides={},
            output_token_overrides={},
            default_output_tokens=4096,
        )
        assert updated['test-model-a'].get('deprecated') is None


class TestRetirementAnomaly:
    """
    A per-model verdict that arrives for the whole provider at once is not N
    retirements; it is one failure a level up. Retire an API version and every
    call answers with the same 404 and the same wording, which is exactly what
    the retirement phrases match.
    """

    def test_a_majority_verdict_is_treated_as_an_api_failure(self):
        assert is_retirement_anomaly(6, 10) is True
        assert is_retirement_anomaly(26, 26) is True

    def test_a_normal_handful_is_believed(self):
        # The real gemini case: five of twenty-six.
        assert is_retirement_anomaly(5, 26) is False
        assert is_retirement_anomaly(1, 3) is False

    def test_exactly_half_is_not_a_majority(self):
        assert is_retirement_anomaly(5, 10) is False

    def test_nothing_retired_is_never_an_anomaly(self):
        assert is_retirement_anomaly(0, 26) is False

    def test_nothing_verified_cannot_be_judged(self):
        # No calls were made, so there is no ratio to reason about.
        assert is_retirement_anomaly(3, 0) is False
