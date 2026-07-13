# =============================================================================
# MIT License — Copyright (c) 2026 Aparavi Software AG
# (full text in depends.py)
# =============================================================================

"""Unit tests for ``venv_env`` — per-env overlay layout, planning, and the switch.

Pure/filesystem-only; no engine or ``uv`` needed. Uses ``tmp_path`` for overlays.
"""

from __future__ import annotations

import os

import venv_env as V


# --- the ROCKETRIDE_SERVER_USE_VENV switch (§4.15) --------------------------


def test_use_venv_mode_states():
    assert V.use_venv_mode({}) == V.USE_AUTO  # unset
    assert V.use_venv_mode({'ROCKETRIDE_SERVER_USE_VENV': '0'}) == V.USE_OFF
    assert V.use_venv_mode({'ROCKETRIDE_SERVER_USE_VENV': '1'}) == V.USE_ON
    assert V.use_venv_mode({'ROCKETRIDE_SERVER_USE_VENV': 'yes'}) == V.USE_AUTO  # unknown -> auto


def test_scoping_enabled_semantics():
    # off: never; on: always; auto: only with an isolated group
    assert V.scoping_enabled(V.USE_OFF, has_isolated_group=True) is False
    assert V.scoping_enabled(V.USE_ON, has_isolated_group=False) is True
    assert V.scoping_enabled(V.USE_AUTO, has_isolated_group=True) is True
    assert V.scoping_enabled(V.USE_AUTO, has_isolated_group=False) is False


# --- id shortening + MAX_PATH friendliness (§4.9) ---------------------------


def test_short_id_rules():
    assert V.short_id(None) == V.DEFAULT_ID
    assert V.short_id('') == V.DEFAULT_ID
    assert V.short_id('----') == V.DEFAULT_ID  # all separators -> default
    assert V.short_id('main') == 'main'  # short readable id kept
    assert V.short_id('group_1') == 'group1'  # separators stripped
    assert V.short_id('0d4f3caa-1234-5678-9abc') == '0d4f3caa'  # GUID -> first 8 hex
    assert len(V.short_id('0d4f3caa-1234-5678-9abc')) == 8


def test_env_dir_layout():
    exe = os.path.join('X:', 'engine')
    d = V.env_dir(exe, '0d4f3caa-1111-2222', 'group_7')
    parts = d.replace('\\', '/').split('/')
    assert parts[-3:] == ['venvs', '0d4f3caa', 'group7']
    # missing project_id -> shared 'default'; missing env_id -> 'main'
    assert V.env_dir(exe, None, None).replace('\\', '/').endswith('venvs/default/main')


def test_env_paths_names():
    p = V.env_paths(os.path.join('X:', 'e', 'venvs', 'p', 'main'))
    assert os.path.basename(p.site_packages) == 'site-packages'
    assert os.path.basename(p.combined) == 'combined.txt'
    assert os.path.basename(p.constraints) == 'constraints.txt'
    assert os.path.basename(p.hash_file) == 'requirements.hash'
    assert os.path.basename(p.lock_file) == 'install.lock'


# --- hash / combine ---------------------------------------------------------


def _req(tmp_path, name, body):
    f = tmp_path / name
    f.write_text(body, encoding='utf-8')
    return str(f)


def test_requirements_hash_order_independent_and_content_sensitive(tmp_path):
    a = _req(tmp_path, 'a.txt', 'tabulate==0.8.10\n')
    b = _req(tmp_path, 'b.txt', 'six==1.16.0\n')
    assert V.requirements_hash([a, b]) == V.requirements_hash([b, a])  # order-independent
    h1 = V.requirements_hash([a])
    (tmp_path / 'a.txt').write_text('tabulate==0.9.0\n', encoding='utf-8')  # content change
    assert V.requirements_hash([a]) != h1


def test_write_combined_concatenates_with_headers(tmp_path):
    a = _req(tmp_path, 'a.txt', 'tabulate==0.8.10\n')
    b = _req(tmp_path, 'b.txt', 'six==1.16.0\n')
    out = str(tmp_path / 'combined.txt')
    V.write_combined([a, b], out)
    text = (tmp_path / 'combined.txt').read_text(encoding='utf-8')
    assert 'tabulate==0.8.10' in text and 'six==1.16.0' in text
    assert text.count('# Source:') == 2


# --- plan_install drift + overlay creation ----------------------------------


def test_plan_install_creates_overlay_and_detects_drift(tmp_path):
    exe = str(tmp_path)
    req = _req(tmp_path, 'r.txt', 'tabulate==0.8.10\n')

    plan = V.plan_install(exe, 'proj-guid-aaaa', 'main', [req])
    # overlay created, first run needs a rebuild, combined written
    assert os.path.isdir(plan.paths.site_packages)
    assert plan.needs_rebuild is True
    assert os.path.isfile(plan.paths.combined)

    # simulate a completed install: mark hash + create a constraints file
    V.mark_installed(plan)
    open(plan.paths.constraints, 'w').close()

    # unchanged requirements -> no rebuild
    plan2 = V.plan_install(exe, 'proj-guid-aaaa', 'main', [req])
    assert plan2.needs_rebuild is False

    # changed requirements -> rebuild again
    (tmp_path / 'r.txt').write_text('tabulate==0.9.0\n', encoding='utf-8')
    plan3 = V.plan_install(exe, 'proj-guid-aaaa', 'main', [req])
    assert plan3.needs_rebuild is True


def test_plan_install_default_env_when_no_project_id(tmp_path):
    # §4.14: no project_id -> shared default overlay, still works
    plan = V.plan_install(str(tmp_path), None, None, [])
    assert plan.paths.env_dir.replace('\\', '/').endswith('venvs/default/main')
    assert os.path.isdir(plan.paths.site_packages)


# --- uv install argv (scoped via --target) ----------------------------------


def test_build_install_argv_targets_overlay():
    argv = V.build_install_argv(
        uv_path='uv',
        python_exe='py',
        requirements_path='r.txt',
        target_site='/venvs/p/main/site-packages',
        constraints_path='c.txt',
        excludes_path='ex.txt',
    )
    assert argv[:3] == ['uv', 'pip', 'install']
    # target overlay + constraints + excludes all present, in order
    assert argv[argv.index('--target') + 1] == '/venvs/p/main/site-packages'
    assert argv[argv.index('-r') + 1] == 'r.txt'
    assert argv[argv.index('-c') + 1] == 'c.txt'
    assert '--no-build-isolation' in argv
    assert argv[argv.index('--excludes') + 1] == 'ex.txt'


def test_build_install_argv_optional_flags_omitted():
    argv = V.build_install_argv('uv', 'py', 'r.txt', '/site')
    assert '-c' not in argv and '--excludes' not in argv


# --- run_scoped_install orchestration (injected side effects) ---------------


def _stub_discover(files):
    def _d(providers):
        _d.called_with = list(providers)
        return files

    _d.called_with = None
    return _d


def test_run_scoped_install_off_is_noop(tmp_path):
    d = _stub_discover([])
    calls = []
    site = V.run_scoped_install(
        str(tmp_path),
        'p',
        'main',
        ['webhook'],
        discover=d,
        compile_and_install=lambda plan: calls.append('install'),
        mode=V.USE_OFF,
    )
    assert site is None  # legacy/base path
    assert d.called_with is None  # discover not even called
    assert calls == []  # nothing installed


def test_run_scoped_install_on_installs_and_overlays(tmp_path):
    req = _req(tmp_path, 'r.txt', 'tabulate==0.8.10\n')
    d = _stub_discover([req])
    installed, overlaid = [], []
    site = V.run_scoped_install(
        str(tmp_path),
        'proj-aaaa',
        'main',
        ['webhook', 'detect'],
        discover=d,
        compile_and_install=lambda plan: installed.append(plan.paths.site_packages),
        on_overlay=overlaid.append,
        mode=V.USE_ON,
    )
    assert site.endswith('site-packages')
    assert d.called_with == ['webhook', 'detect']
    assert installed == [site]  # compile+install ran (first run = drift)
    assert overlaid == [site]  # overlay hook invoked with the overlay
    assert os.path.isfile(V.env_paths(os.path.dirname(site)).hash_file)  # marked installed


def test_run_scoped_install_skips_install_when_up_to_date(tmp_path):
    req = _req(tmp_path, 'r.txt', 'tabulate==0.8.10\n')
    d = _stub_discover([req])

    def ci(plan):
        open(plan.paths.constraints, 'w').close()  # simulate uv producing constraints
        ci.n += 1

    ci.n = 0
    V.run_scoped_install(str(tmp_path), 'p', 'main', ['x'], discover=d, compile_and_install=ci, mode=V.USE_ON)
    assert ci.n == 1
    # unchanged reqs + constraints present -> no reinstall
    V.run_scoped_install(str(tmp_path), 'p', 'main', ['x'], discover=d, compile_and_install=ci, mode=V.USE_ON)
    assert ci.n == 1


def test_run_scoped_install_auto_needs_isolated_group(tmp_path):
    req = _req(tmp_path, 'r.txt', 'x\n')
    base = dict(discover=_stub_discover([req]), compile_and_install=lambda plan: None, mode=V.USE_AUTO)
    assert V.run_scoped_install(str(tmp_path), 'p', 'main', ['x'], has_isolated_group=False, **base) is None
    assert V.run_scoped_install(str(tmp_path), 'p', 'main', ['x'], has_isolated_group=True, **base) is not None
