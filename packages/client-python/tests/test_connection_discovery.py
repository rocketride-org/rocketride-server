# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""Tests for the local engine connection discovery fallback."""

import json
import os
import unittest
from unittest.mock import mock_open, patch

from rocketride._connection_discovery import (
    connection_discovery_path,
    get_user_config_dir,
    read_connection_discovery,
)

VALID_INFO = {'uri': 'http://localhost:54321', 'apiKey': 'MYAPIKEY', 'pid': 4242, 'updatedAt': '2026-08-05T12:00:00Z'}


class TestGetUserConfigDir(unittest.TestCase):
    def test_matches_vscode_extension_layout_on_macos(self) -> None:
        """Must agree byte-for-byte with getUserConfigDir() in
        apps/vscode/src/engine/config/config-migration.ts -- both sides
        compute this path independently, with no runtime coordination.
        """
        with patch('rocketride._connection_discovery.sys.platform', 'darwin'):
            self.assertEqual(
                get_user_config_dir(),
                os.path.join(os.path.expanduser('~'), 'Library', 'Application Support', 'RocketRide'),
            )

    def test_matches_vscode_extension_layout_on_linux(self) -> None:
        with patch('rocketride._connection_discovery.sys.platform', 'linux'):
            self.assertEqual(get_user_config_dir(), os.path.join(os.path.expanduser('~'), '.config', 'RocketRide'))

    def test_matches_vscode_extension_layout_on_windows(self) -> None:
        with (
            patch('rocketride._connection_discovery.sys.platform', 'win32'),
            patch.dict(os.environ, {'LOCALAPPDATA': 'C:\\Users\\dev\\AppData\\Local'}, clear=False),
        ):
            self.assertEqual(get_user_config_dir(), os.path.join('C:\\Users\\dev\\AppData\\Local', 'RocketRide'))

    def test_windows_falls_back_when_localappdata_unset(self) -> None:
        with (
            patch('rocketride._connection_discovery.sys.platform', 'win32'),
            patch.dict(os.environ, {}, clear=True),
        ):
            self.assertEqual(
                get_user_config_dir(),
                os.path.join(os.path.expanduser('~'), 'AppData', 'Local', 'RocketRide'),
            )

    def test_discovery_path_is_under_engine_subdir(self) -> None:
        """Same engine/ subdirectory version.json and engine-<pid>.pid already live in."""
        self.assertEqual(
            connection_discovery_path(),
            os.path.join(get_user_config_dir(), 'engine', 'connection.json'),
        )


class TestReadConnectionDiscovery(unittest.TestCase):
    def _with_file(self, content: str):
        return patch('builtins.open', mock_open(read_data=content))

    def test_returns_none_when_file_does_not_exist(self) -> None:
        with patch('builtins.open', side_effect=FileNotFoundError):
            self.assertIsNone(read_connection_discovery())

    def test_returns_none_for_invalid_json(self) -> None:
        with self._with_file('not json'):
            self.assertIsNone(read_connection_discovery())

    def test_returns_none_when_json_is_not_an_object(self) -> None:
        for text in ('42', '"a string"', 'null', '[]'):
            with self.subTest(text=text), self._with_file(text):
                self.assertIsNone(read_connection_discovery())

    def test_returns_none_when_uri_missing_or_wrong_type(self) -> None:
        with self._with_file(json.dumps({'pid': 1})):
            self.assertIsNone(read_connection_discovery())
        with self._with_file(json.dumps({'uri': 123, 'pid': 1})):
            self.assertIsNone(read_connection_discovery())
        with self._with_file(json.dumps({'uri': '', 'pid': 1})):
            self.assertIsNone(read_connection_discovery())

    def test_returns_none_when_pid_missing_or_wrong_type(self) -> None:
        with self._with_file(json.dumps({'uri': VALID_INFO['uri']})):
            self.assertIsNone(read_connection_discovery())
        with self._with_file(json.dumps({'uri': VALID_INFO['uri'], 'pid': '4242'})):
            self.assertIsNone(read_connection_discovery())

    def test_returns_info_for_a_well_formed_live_entry(self) -> None:
        with (
            self._with_file(json.dumps(VALID_INFO)),
            patch('rocketride._connection_discovery._is_process_alive', return_value=True),
        ):
            self.assertEqual(read_connection_discovery(), VALID_INFO)

    def test_returns_none_for_a_dead_pid_by_default(self) -> None:
        """A crashed engine that never got to remove its own entry on exit
        must not hand back a port nothing is listening on anymore.
        """
        with (
            self._with_file(json.dumps(VALID_INFO)),
            patch('rocketride._connection_discovery._is_process_alive', return_value=False),
        ):
            self.assertIsNone(read_connection_discovery())

    def test_check_process_alive_false_skips_the_liveness_check(self) -> None:
        with (
            self._with_file(json.dumps(VALID_INFO)),
            patch('rocketride._connection_discovery._is_process_alive', return_value=False) as mock_alive,
        ):
            result = read_connection_discovery(check_process_alive=False)
        mock_alive.assert_not_called()
        self.assertEqual(result, VALID_INFO)

    def test_defaults_missing_apikey_and_updated_at_to_empty_string(self) -> None:
        with (
            self._with_file(json.dumps({'uri': VALID_INFO['uri'], 'pid': VALID_INFO['pid']})),
            patch('rocketride._connection_discovery._is_process_alive', return_value=True),
        ):
            result = read_connection_discovery()
        self.assertEqual(result, {'uri': VALID_INFO['uri'], 'apiKey': '', 'pid': VALID_INFO['pid'], 'updatedAt': ''})

    def test_ignores_unknown_extra_fields(self) -> None:
        with (
            self._with_file(json.dumps({**VALID_INFO, 'someFutureField': 'ignore me'})),
            patch('rocketride._connection_discovery._is_process_alive', return_value=True),
        ):
            self.assertEqual(read_connection_discovery(), VALID_INFO)


if __name__ == '__main__':
    unittest.main()
