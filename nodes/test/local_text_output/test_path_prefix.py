# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for local_text_output exclude-prefix handling."""

import importlib.util
from pathlib import Path


_MODULE_FILE = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'local_text_output' / 'path_prefix.py'
_spec = importlib.util.spec_from_file_location('local_text_output_path_prefix_under_test', _MODULE_FILE)
path_prefix = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(path_prefix)


def test_no_exclude_preserves_complete_source_path():
    assert path_prefix.strip_exclude_prefix('/data/folder/report.md', 'N/A') == '/data/folder/report.md'


def test_empty_exclude_preserves_existing_behavior():
    assert path_prefix.strip_exclude_prefix('/data/folder/report.md', '') == '/data/folder/report.md'


def test_prefix_without_trailing_separator_is_removed_at_boundary():
    assert path_prefix.strip_exclude_prefix('/data/job/report.md', '/data/job') == '/report.md'


def test_prefix_with_trailing_separator_is_removed_once():
    assert path_prefix.strip_exclude_prefix('/data/job/report.md', '/data/job/') == 'report.md'


def test_later_matching_segment_is_preserved():
    assert path_prefix.strip_exclude_prefix('/data/archive/data/report.md', '/data') == '/archive/data/report.md'


def test_partial_path_component_is_rejected():
    assert path_prefix.strip_exclude_prefix('/data/jobs/report.md', '/data/job') is None


def test_unrelated_prefix_is_rejected():
    assert path_prefix.strip_exclude_prefix('/data/job/report.md', '/other') is None


def test_exact_path_match_produces_empty_relative_path():
    assert path_prefix.strip_exclude_prefix('/data/job', '/data/job') == ''


def test_windows_separator_is_a_path_boundary():
    assert path_prefix.strip_exclude_prefix(r'C:\data\job\report.md', r'C:\data\job') == r'\report.md'


def test_windows_partial_path_component_is_rejected():
    assert path_prefix.strip_exclude_prefix(r'C:\data\jobs\report.md', r'C:\data\job') is None


def test_mixed_separator_is_accepted_as_a_path_boundary():
    assert path_prefix.strip_exclude_prefix(r'C:\data\job/report.md', r'C:\data\job') == '/report.md'
