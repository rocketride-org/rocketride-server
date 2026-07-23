# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

r"""Unit tests for rocketlib.paths (Windows long-path / component helpers).

These test the pure path helpers behind the fix for the Windows MAX_PATH bug in
the Python output nodes (issue #1415). The module is loaded directly from its
file so the tests run without the compiled engine (rocketlib/__init__ imports
engLib), and so the \\?\ prefix logic is exercised on every platform — not just
Windows.
"""

import importlib.util
import os
from pathlib import Path

import pytest

# Load rocketlib/paths.py directly, bypassing rocketlib/__init__ (which imports
# the native engLib and would fail to import in a raw checkout).
_PATHS_FILE = (
    Path(__file__).resolve().parents[2]
    / 'packages'
    / 'server'
    / 'engine-lib'
    / 'rocketlib-python'
    / 'lib'
    / 'rocketlib'
    / 'paths.py'
)
_spec = importlib.util.spec_from_file_location('rocketlib_paths_under_test', _PATHS_FILE)
paths = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(paths)

WINDOWS = os.name == 'nt'


# ---------------------------------------------------------------------------
# _win_extended_length — pure string transform, testable on any platform
# ---------------------------------------------------------------------------


def test_win_extended_length_drive_path():
    assert paths._win_extended_length('C:\\a\\b') == '\\\\?\\C:\\a\\b'


def test_win_extended_length_unc_path():
    # \\server\share\x -> \\?\UNC\server\share\x
    assert paths._win_extended_length('\\\\server\\share\\x') == '\\\\?\\UNC\\server\\share\\x'


def test_win_extended_length_leaves_extended_prefix_untouched():
    already = '\\\\?\\C:\\a\\b'
    assert paths._win_extended_length(already) == already


def test_win_extended_length_leaves_device_prefix_untouched():
    device = '\\\\.\\PhysicalDrive0'
    assert paths._win_extended_length(device) == device


def test_win_extended_length_idempotent():
    once = paths._win_extended_length('C:\\a\\b')
    assert paths._win_extended_length(once) == once
    once_unc = paths._win_extended_length('\\\\server\\share\\x')
    assert paths._win_extended_length(once_unc) == once_unc


# ---------------------------------------------------------------------------
# extended_length_path — platform-aware wrapper
# ---------------------------------------------------------------------------


def test_extended_length_path_empty_is_noop():
    assert paths.extended_length_path('') == ''


@pytest.mark.skipif(WINDOWS, reason='POSIX no-op branch only observable off Windows')
def test_extended_length_path_noop_on_posix():
    assert paths.extended_length_path('/tmp/some/very/long/path') == '/tmp/some/very/long/path'


@pytest.mark.skipif(not WINDOWS, reason='\\\\?\\ prefixing only happens on Windows')
def test_extended_length_path_prefixes_on_windows():
    out = paths.extended_length_path('C:\\a\\b')
    assert out == '\\\\?\\C:\\a\\b'


@pytest.mark.skipif(not WINDOWS, reason='requires Windows abspath semantics')
def test_extended_length_path_absolutizes_relative_input():
    out = paths.extended_length_path('rel\\sub\\file.txt')
    assert out.startswith('\\\\?\\')
    # No relative components survive in an extended-length path.
    assert '\\..\\' not in out
    assert out.endswith('rel\\sub\\file.txt')


@pytest.mark.skipif(not WINDOWS, reason='requires Windows')
def test_extended_length_path_idempotent_on_windows():
    once = paths.extended_length_path('C:\\a\\b')
    assert paths.extended_length_path(once) == once


@pytest.mark.skipif(not WINDOWS, reason='requires Windows')
def test_extended_length_path_supports_beyond_260_chars():
    long_path = 'C:\\out\\' + '\\'.join('segment_%03d' % i for i in range(40)) + '\\file.txt'
    assert len(long_path) > 260
    out = paths.extended_length_path(long_path)
    assert out == '\\\\?\\' + long_path


# ---------------------------------------------------------------------------
# shorten_path_component
# ---------------------------------------------------------------------------


def test_short_component_unchanged():
    assert paths.shorten_path_component('normal_name.txt') == 'normal_name.txt'


def test_component_at_limit_unchanged():
    name = 'a' * paths.DEFAULT_MAX_COMPONENT
    assert paths.shorten_path_component(name) == name


def test_long_component_is_shortened_within_limit():
    name = 'x' * 400 + '.txt'
    out = paths.shorten_path_component(name)
    assert len(out) <= paths.DEFAULT_MAX_COMPONENT
    assert out != name


def test_long_component_preserves_extension():
    name = 'y' * 400 + '.txt'
    out = paths.shorten_path_component(name)
    assert out.endswith('.txt')


def test_long_component_is_deterministic():
    name = 'z' * 400 + '.md'
    assert paths.shorten_path_component(name) == paths.shorten_path_component(name)


def test_long_component_is_idempotent():
    name = 'q' * 400 + '.txt'
    once = paths.shorten_path_component(name)
    assert paths.shorten_path_component(once) == once


def test_distinct_long_inputs_map_to_distinct_outputs():
    # Names identical except for the tail must not collide (hash of full name).
    a = 'p' * 400 + 'A.txt'
    b = 'p' * 400 + 'B.txt'
    assert paths.shorten_path_component(a) != paths.shorten_path_component(b)


def test_pathological_long_extension_is_dropped_but_bounded():
    name = 'stem' + '.' + 'e' * 400  # extension alone exceeds the limit
    out = paths.shorten_path_component(name)
    assert len(out) <= paths.DEFAULT_MAX_COMPONENT


@pytest.mark.parametrize('max_len', [8, 16, 32, 64, 255])
def test_result_never_exceeds_max_len(max_len):
    name = 'w' * 1000 + '.dat'
    out = paths.shorten_path_component(name, max_len=max_len)
    assert len(out) <= max_len


def test_negative_max_len_rejected():
    with pytest.raises(ValueError):
        paths.shorten_path_component('a-name-well-over-the-limit', max_len=-1)


# ---------------------------------------------------------------------------
# UTF-16 code-unit budgeting (NTFS/SMB cap is 255 UTF-16 units, not code points)
# ---------------------------------------------------------------------------


def test_utf16_len_counts_astral_as_two_units():
    assert paths._utf16_len('a') == 1
    assert paths._utf16_len('\U0001f680') == 2  # 🚀 (astral) = 2 UTF-16 units
    assert paths._utf16_len('a\U0001f680b') == 4


def test_truncate_utf16_keeps_astral_chars_whole():
    rocket = '\U0001f680'
    # A 3-unit budget holds one 2-unit emoji but not a second; the leftover
    # unit is never used to split the surrogate pair.
    assert paths._truncate_utf16(rocket + rocket, 3) == rocket
    assert paths._truncate_utf16(rocket + rocket, 2) == rocket
    assert paths._truncate_utf16(rocket + rocket, 1) == ''
    assert paths._truncate_utf16('abc', 2) == 'ab'


def test_astral_component_bounded_in_utf16_units():
    # 200 emoji = 200 code points but 400 UTF-16 units: a naive len() check
    # passes at max_len=255 yet the name overflows the real NTFS/SMB limit.
    name = '\U0001f680' * 200 + '.txt'
    assert len(name) <= 255  # code-point count is misleadingly small...
    assert paths._utf16_len(name) > paths.DEFAULT_MAX_COMPONENT  # ...but UTF-16 isn't
    out = paths.shorten_path_component(name)
    assert paths._utf16_len(out) <= paths.DEFAULT_MAX_COMPONENT
    assert out.endswith('.txt')
    out.encode('utf-16-le')  # would raise on a split (lone) surrogate


# ---------------------------------------------------------------------------
# shorten_path_components
# ---------------------------------------------------------------------------


def test_components_preserve_forward_slash_separators():
    out = paths.shorten_path_components('a/b/c.txt')
    assert out == 'a/b/c.txt'


def test_components_preserve_backslash_separators():
    out = paths.shorten_path_components('a\\b\\c.txt')
    assert out == 'a\\b\\c.txt'


def test_components_preserve_mixed_separators_and_leading_slash():
    out = paths.shorten_path_components('/a/b\\c.txt')
    assert out == '/a/b\\c.txt'


def test_components_only_shortens_the_long_segment():
    long_seg = 'n' * 400
    out = paths.shorten_path_components(f'short/{long_seg}/tail.txt')
    parts = out.split('/')
    assert parts[0] == 'short'
    assert parts[2] == 'tail.txt'
    assert len(parts[1]) <= paths.DEFAULT_MAX_COMPONENT
    assert parts[1] != long_seg


def test_components_deterministic():
    p = f'dir/{"m" * 400}.txt'
    assert paths.shorten_path_components(p) == paths.shorten_path_components(p)
