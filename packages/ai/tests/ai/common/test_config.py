"""Tests for ai.common.config module."""

import sys
from pathlib import Path
from typing import Any, Dict, Optional
from unittest.mock import MagicMock


# Ensure src is in path
src_path = Path(__file__).parent.parent.parent.parent / 'src'
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))


class MockIJson(dict):
    """Mock IJson class that supports isinstance checks and dict methods."""


# Mock external dependencies BEFORE importing ai modules
mock_rocketlib = MagicMock()
mock_rocketlib.getServiceDefinition = MagicMock()
mock_rocketlib.warning = MagicMock()
mock_rocketlib.IJson = MockIJson
sys.modules['rocketlib'] = mock_rocketlib
sys.modules['depends'] = MagicMock()
sys.modules['json5'] = MagicMock()

# Now import the module
from ai.common.config import Config


class TestGetNodeConfigDeprecatedProfiles:
    """Test cases for deprecated profile warning functionality."""

    def _make_service_with_profile(self, profile_name: str, profile_config: Dict[str, Any], default_profile: Optional[str] = None) -> Dict[str, Any]:
        """
        Helper to create a mock service definition.

        Ensures the default profile exists in profiles by inserting it when missing.
        """
        profiles = {profile_name: profile_config}
        resolved_default = default_profile or profile_name

        if resolved_default not in profiles:
            profiles[resolved_default] = profile_config

        return {'preconfig': {'default': resolved_default, 'profiles': profiles}}

    def test_deprecated_default_profile_emits_warning(self):
        """Test that a deprecated default profile emits a warning with migration message."""
        profile_name = 'test-profile'
        profile_config = {'model': 'test-model', 'deprecated': True, 'migration': 'Please use test-profile-v2 instead'}
        mock_rocketlib.getServiceDefinition.return_value = self._make_service_with_profile(profile_name, profile_config)
        mock_rocketlib.warning.reset_mock()

        connConfig = {}
        result = Config.getNodeConfig('test-service', connConfig)

        mock_rocketlib.warning.assert_called_once_with(f'Default profile "{profile_name}" is deprecated. Please use test-profile-v2 instead')
        assert result['model'] == 'test-model'

    def test_deprecated_explicit_profile_emits_warning(self):
        """Test that an explicitly selected deprecated profile emits a warning."""
        profile_name = 'old-profile'
        profile_config = {'model': 'old-model', 'deprecated': True, 'migration': 'Please use new-profile instead'}
        mock_rocketlib.getServiceDefinition.return_value = self._make_service_with_profile(profile_name, profile_config, default_profile='other-profile')
        mock_rocketlib.warning.reset_mock()

        connConfig = {'profile': profile_name}
        result = Config.getNodeConfig('test-service', connConfig)

        mock_rocketlib.warning.assert_called_once_with(f'Profile "{profile_name}" is deprecated. Please use new-profile instead')
        assert result['model'] == 'old-model'

    def test_deprecated_profile_without_migration_key(self):
        """Test that a deprecated profile without migration key uses fallback text."""
        profile_name = 'legacy-profile'
        profile_config = {'model': 'legacy-model', 'deprecated': True}
        mock_rocketlib.getServiceDefinition.return_value = self._make_service_with_profile(profile_name, profile_config)
        mock_rocketlib.warning.reset_mock()

        connConfig = {}
        result = Config.getNodeConfig('test-service', connConfig)

        mock_rocketlib.warning.assert_called_once_with(f'Default profile "{profile_name}" is deprecated. Please use a current profile instead.')
        assert result['model'] == 'legacy-model'

    def test_non_deprecated_profile_no_warning(self):
        """Test that a non-deprecated profile does not emit a warning."""
        profile_name = 'current-profile'
        profile_config = {'model': 'current-model'}
        mock_rocketlib.getServiceDefinition.return_value = self._make_service_with_profile(profile_name, profile_config)
        mock_rocketlib.warning.reset_mock()

        connConfig = {}
        result = Config.getNodeConfig('test-service', connConfig)

        mock_rocketlib.warning.assert_not_called()
        assert result['model'] == 'current-model'

    def test_deprecated_explicit_profile_without_migration(self):
        """Test explicit deprecated profile without migration uses fallback text."""
        profile_name = 'old-explicit-profile'
        profile_config = {'model': 'old-model', 'deprecated': True}
        mock_rocketlib.getServiceDefinition.return_value = self._make_service_with_profile(profile_name, profile_config, default_profile='other-profile')
        mock_rocketlib.warning.reset_mock()

        connConfig = {'profile': profile_name}
        result = Config.getNodeConfig('test-service', connConfig)

        mock_rocketlib.warning.assert_called_once_with(f'Profile "{profile_name}" is deprecated. Please use a current profile instead.')
        assert result['model'] == 'old-model'

    def test_deprecated_false_does_not_warn(self):
        """Test that a profile with deprecated=false does not emit a warning."""
        profile_name = 'safe-profile'
        profile_config = {'model': 'safe-model', 'deprecated': False}
        mock_rocketlib.getServiceDefinition.return_value = self._make_service_with_profile(profile_name, profile_config)
        mock_rocketlib.warning.reset_mock()

        connConfig = {}
        result = Config.getNodeConfig('test-service', connConfig)

        mock_rocketlib.warning.assert_not_called()
        assert result['model'] == 'safe-model'
