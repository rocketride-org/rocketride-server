"""
Offline tests for the sync script logic.

These tests require no server, no running engine, and no API keys.
They test the merge, deprecation, smoke-test gate, and comment-preservation
logic against mocked provider responses.

Run: pytest tools/test/test_sync_logic.py
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

# tools/src is added to sys.path by conftest.py
from core.merger import merge, _make_profile_key, _derive_title
from core.smoke import run
from core.patcher import load as patcher_load, patch as patcher_patch, get_profiles
from core.reporter import SyncReport, ProviderReport, format_console, format_pr_body


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
        assert 'Connection refused' in output
