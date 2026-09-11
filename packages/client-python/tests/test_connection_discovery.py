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
    is_loopback_discovery_uri,
    read_connection_discovery,
)

VALID_INFO = {'uri': 'http://localhost:54321', 'pid': 4242, 'updatedAt': '2026-08-05T12:00:00Z'}


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


class TestIsLoopbackDiscoveryUri(unittest.TestCase):
    def test_accepts_standard_loopback_spellings(self) -> None:
        for uri in ('http://localhost:54321', 'http://LOCALHOST:1', 'http://127.0.0.1:54321', 'http://[::1]:54321'):
            with self.subTest(uri=uri):
                self.assertTrue(is_loopback_discovery_uri(uri))

    def test_rejects_non_loopback_hosts(self) -> None:
        for uri in ('http://attacker.example.com:54321', 'http://192.168.1.5:54321', 'http://8.8.8.8:53'):
            with self.subTest(uri=uri):
                self.assertFalse(is_loopback_discovery_uri(uri))

    def test_rejects_alternate_ip_encodings_rather_than_guess(self) -> None:
        """`ipaddress.ip_address` deliberately doesn't accept these -- deny by
        default rather than reimplement every alternate IPv4 spelling.
        """
        for uri in ('http://0177.0.0.1:1', 'http://2130706433:1', 'http://127.1:1'):
            with self.subTest(uri=uri):
                self.assertFalse(is_loopback_discovery_uri(uri))

    def test_rejects_malformed_uri_without_raising(self) -> None:
        for uri in ('not a uri', '', 'http://', '://'):
            with self.subTest(uri=uri):
                self.assertFalse(is_loopback_discovery_uri(uri))


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

    def test_returns_none_when_uri_is_not_an_absolute_http_uri(self) -> None:
        for uri in ('localhost:54321', 'ws://localhost:54321', 'not a uri', 'file:///etc/passwd'):
            with self.subTest(uri=uri), self._with_file(json.dumps({'uri': uri, 'pid': 1})):
                self.assertIsNone(read_connection_discovery())

    def test_returns_none_when_pid_missing_or_wrong_type(self) -> None:
        with self._with_file(json.dumps({'uri': VALID_INFO['uri']})):
            self.assertIsNone(read_connection_discovery())
        with self._with_file(json.dumps({'uri': VALID_INFO['uri'], 'pid': '4242'})):
            self.assertIsNone(read_connection_discovery())

    def test_returns_none_when_pid_is_a_bool(self) -> None:
        """`bool` is a subclass of `int` in Python -- `pid: true` must not
        pass as pid 1.
        """
        with self._with_file(json.dumps({'uri': VALID_INFO['uri'], 'pid': True})):
            self.assertIsNone(read_connection_discovery())

    def test_returns_none_when_pid_is_zero_or_negative(self) -> None:
        for pid in (0, -4242):
            with self.subTest(pid=pid), self._with_file(json.dumps({'uri': VALID_INFO['uri'], 'pid': pid})):
                self.assertIsNone(read_connection_discovery())

    def test_returns_none_for_a_non_loopback_uri_even_with_a_live_pid(self) -> None:
        """The core of the fix: a discovery file naming an attacker-controlled
        host must never be trusted, regardless of everything else being
        well-formed and the pid being alive.
        """
        malicious = {'uri': 'http://attacker.example.com:5565', 'pid': 4242, 'updatedAt': ''}
        with (
            self._with_file(json.dumps(malicious)),
            patch('rocketride._connection_discovery._is_process_alive', return_value=True),
        ):
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

    def test_defaults_missing_updated_at_to_empty_string(self) -> None:
        with (
            self._with_file(json.dumps({'uri': VALID_INFO['uri'], 'pid': VALID_INFO['pid']})),
            patch('rocketride._connection_discovery._is_process_alive', return_value=True),
        ):
            result = read_connection_discovery()
        self.assertEqual(result, {'uri': VALID_INFO['uri'], 'pid': VALID_INFO['pid'], 'updatedAt': ''})

    def test_ignores_a_legacy_api_key_field(self) -> None:
        """A file written by a pre-#1851-fix extension still has `apiKey`;
        the reader must not resurrect it onto the returned info.
        """
        with (
            self._with_file(json.dumps({**VALID_INFO, 'apiKey': 'MYAPIKEY'})),
            patch('rocketride._connection_discovery._is_process_alive', return_value=True),
        ):
            self.assertEqual(read_connection_discovery(), VALID_INFO)

    def test_ignores_unknown_extra_fields(self) -> None:
        with (
            self._with_file(json.dumps({**VALID_INFO, 'someFutureField': 'ignore me'})),
            patch('rocketride._connection_discovery._is_process_alive', return_value=True),
        ):
            self.assertEqual(read_connection_discovery(), VALID_INFO)


class TestIsProcessAliveWindows(unittest.TestCase):
    """`_is_process_alive` dispatches to a ctypes-based probe on win32 instead
    of `os.kill(pid, 0)`, which maps to a real Win32 action there rather than
    a pure existence check.
    """

    def _mock_kernel32(self, *, open_handle, exit_code=None, get_exit_code_ok=True, last_error=0):
        mock_dll = unittest.mock.MagicMock()
        mock_dll.OpenProcess.return_value = open_handle

        def _get_exit_code_process(_handle, ref):
            if get_exit_code_ok:
                ref._obj.value = exit_code
            return 1 if get_exit_code_ok else 0

        mock_dll.GetExitCodeProcess.side_effect = _get_exit_code_process
        return mock_dll, last_error

    def test_alive_when_still_active(self) -> None:
        import ctypes

        from rocketride._connection_discovery import _is_process_alive_windows

        mock_dll, _ = self._mock_kernel32(open_handle=1234, exit_code=259)  # STILL_ACTIVE
        with (
            patch('rocketride._connection_discovery.sys.platform', 'win32'),
            patch.object(ctypes, 'WinDLL', return_value=mock_dll, create=True),
        ):
            self.assertTrue(_is_process_alive_windows(4242))
        mock_dll.CloseHandle.assert_called_once_with(1234)

    def test_dead_when_exit_code_is_not_still_active(self) -> None:
        import ctypes

        from rocketride._connection_discovery import _is_process_alive_windows

        mock_dll, _ = self._mock_kernel32(open_handle=1234, exit_code=0)
        with (
            patch('rocketride._connection_discovery.sys.platform', 'win32'),
            patch.object(ctypes, 'WinDLL', return_value=mock_dll, create=True),
        ):
            self.assertFalse(_is_process_alive_windows(4242))

    def test_dead_when_open_process_fails_with_invalid_parameter(self) -> None:
        import ctypes

        from rocketride._connection_discovery import _is_process_alive_windows

        mock_dll = unittest.mock.MagicMock()
        mock_dll.OpenProcess.return_value = 0
        with (
            patch('rocketride._connection_discovery.sys.platform', 'win32'),
            patch.object(ctypes, 'WinDLL', return_value=mock_dll, create=True),
            patch.object(ctypes, 'get_last_error', return_value=87, create=True),  # ERROR_INVALID_PARAMETER
        ):
            self.assertFalse(_is_process_alive_windows(4242))

    def test_assumed_alive_when_open_process_fails_for_another_reason(self) -> None:
        """E.g. access denied for a live process owned by another user --
        can't confirm dead, so don't discard the hint.
        """
        import ctypes

        from rocketride._connection_discovery import _is_process_alive_windows

        mock_dll = unittest.mock.MagicMock()
        mock_dll.OpenProcess.return_value = 0
        with (
            patch('rocketride._connection_discovery.sys.platform', 'win32'),
            patch.object(ctypes, 'WinDLL', return_value=mock_dll, create=True),
            patch.object(ctypes, 'get_last_error', return_value=5, create=True),  # ERROR_ACCESS_DENIED
        ):
            self.assertTrue(_is_process_alive_windows(4242))

    def test_is_process_alive_dispatches_to_windows_probe_on_win32(self) -> None:
        from rocketride._connection_discovery import _is_process_alive

        with (
            patch('rocketride._connection_discovery.sys.platform', 'win32'),
            patch('rocketride._connection_discovery._is_process_alive_windows', return_value=True) as mock_probe,
        ):
            self.assertTrue(_is_process_alive(4242))
        mock_probe.assert_called_once_with(4242)


if __name__ == '__main__':
    unittest.main()
