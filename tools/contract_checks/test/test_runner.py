"""
Self-tests for the runner against an in-memory stub module.

Verifies that every ``verify_*`` returns the expected pass/fail shape for
known-present and known-missing attributes / imports / chains.
"""

from __future__ import annotations

import sys
import types

import pytest

from contract_checks.engine_env import normalize_dist_name
from contract_checks.manifest import AnyOf, HeavyClass, ImportRequirement
from contract_checks.runner import (
    verify_any_of,
    verify_class_attrs,
    verify_constraint_match,
    verify_heavy_class,
    verify_import,
)


@pytest.fixture
def stub_module():
    """Install a fake third-party module in sys.modules for the duration of one test."""
    name = '_contract_checks_stub'

    class _Indexes:
        """SDK sub-namespace exposing ``.create`` and ``.delete``."""

        def create(self):
            """Stub: takes no real action."""

        def delete(self):
            """Stub: takes no real action."""

    class _Tasks:
        """SDK sub-namespace exposing ``.create``."""

        def create(self):
            """Stub: takes no real action."""

    class Client:
        """Stand-in for an SDK client class — instance attrs populated in __init__."""

        def __init__(self, api_key='x', **_kwargs):
            """Set the same instance attributes a real SDK client would."""
            self.api_key = api_key
            self.indexes = _Indexes()
            self.tasks = _Tasks()

        @staticmethod
        def class_level_method():
            """Stub: exists at class level, used by verify_class_attrs tests."""

    mod = types.ModuleType(name)
    mod.Client = Client
    mod.PUBLIC_FLAG = True
    sys.modules[name] = mod
    try:
        yield name
    finally:
        sys.modules.pop(name, None)


# pytest fixtures always shadow their fixture name inside test signatures —
# disable pylint's redefined-outer-name complaint for the rest of the module.
# pylint: disable=redefined-outer-name


def test_verify_import_passes_when_module_and_symbols_exist(stub_module):
    """All-present case: module imports, every symbol is an attribute."""
    req = ImportRequirement(module=stub_module, symbols=('Client', 'PUBLIC_FLAG'))
    result = verify_import(req)
    assert result.ok, result.message


def test_verify_import_fails_when_module_missing():
    """Module that isn't installed at all yields a clear ImportError-shaped failure."""
    req = ImportRequirement(module='_definitely_not_installed_xyz_', symbols=())
    result = verify_import(req)
    assert not result.ok
    assert 'cannot import' in result.message


def test_verify_import_fails_when_symbol_missing(stub_module):
    """A symbol that's neither an attribute nor an importable submodule fails."""
    req = ImportRequirement(module=stub_module, symbols=('DoesNotExist',))
    result = verify_import(req)
    assert not result.ok
    assert 'DoesNotExist' in result.message


def test_verify_import_accepts_lazy_loaded_submodule():
    """
    Regression: `from PIL import Image` works at runtime because `PIL.Image`
    is a submodule — but ``hasattr(PIL, 'Image')`` is False before the
    submodule loads. ``verify_import`` must fall back to the submodule
    import path. Uses the stdlib's own ``xml`` package, which has a
    submodule ``xml.etree`` that's not an attribute on ``xml`` itself
    until something imports it — same shape as PIL.
    """
    import sys

    # Force xml to be unimported so we exercise the lazy-load fallback path.
    # `xml` is stdlib; safe to drop and re-import.
    for name in list(sys.modules):
        if name == 'xml' or name.startswith('xml.'):
            sys.modules.pop(name, None)

    req = ImportRequirement(module='xml', symbols=('etree',))
    result = verify_import(req)
    assert result.ok, result.message


def test_verify_import_reports_non_importerror_without_crashing(monkeypatch):
    """
    A module that raises a non-ImportError at import (version guard, missing
    native lib) must yield a failed CheckResult — not propagate and abort the
    whole run. Regression for the too-narrow `except ImportError`.
    """

    def _boom(_name, *_a, **_k):
        raise RuntimeError('native lib missing')

    monkeypatch.setattr('contract_checks.runner.importlib.import_module', _boom)
    result = verify_import(ImportRequirement(module='some_pkg', symbols=()))
    assert not result.ok
    assert 'RuntimeError' in result.message
    assert 'some_pkg' in result.message


def test_verify_import_reports_broken_submodule_not_symbol_missing(monkeypatch, stub_module):
    """
    A submodule that exists but whose import raises ModuleNotFoundError for a
    *nested* dependency must be reported as a real failure — not masked as
    'symbol not found'. Only a ModuleNotFoundError naming the probed module
    itself means the submodule is genuinely absent.
    """
    import importlib as _il

    real_import = _il.import_module
    target = f'{stub_module}.Widget'  # 'Widget' isn't an attr → probes submodule

    def _fake(name, *a, **k):
        if name == target:
            # Submodule exists but a nested import is missing.
            raise ModuleNotFoundError("No module named 'nested_dep'", name='nested_dep')
        return real_import(name, *a, **k)

    monkeypatch.setattr('contract_checks.runner.importlib.import_module', _fake)
    result = verify_import(ImportRequirement(module=stub_module, symbols=('Widget',)))
    assert not result.ok
    assert 'nested_dep' in result.message
    assert 'ModuleNotFoundError' in result.message
    # Must NOT be reported as a missing symbol.
    assert 'not found in module' not in result.message


def test_verify_any_of_passes_when_one_alternative_resolves(stub_module):
    """A successful second alternative is enough; earlier failures don't matter."""
    group = AnyOf(
        alternatives=(
            ImportRequirement(module='_missing_module_', symbols=()),
            ImportRequirement(module=stub_module, symbols=('Client',)),
        )
    )
    result = verify_any_of(group)
    assert result.ok


def test_verify_any_of_fails_when_no_alternative_resolves():
    """All-fail case yields one row whose message lists every alternative's reason."""
    group = AnyOf(
        alternatives=(
            ImportRequirement(module='_missing_a_', symbols=()),
            ImportRequirement(module='_missing_b_', symbols=()),
        )
    )
    result = verify_any_of(group)
    assert not result.ok
    assert 'no alternative resolved' in result.message


def test_verify_class_attrs_passes_for_existing_attrs(stub_module):
    """Class-level ``hasattr`` succeeds for declared classmethods/staticmethods."""
    result = verify_class_attrs(stub_module, 'Client', ['class_level_method'])
    assert result.ok


def test_verify_class_attrs_fails_for_missing_attr(stub_module):
    """A missing class-level attribute is reported with its name."""
    result = verify_class_attrs(stub_module, 'Client', ['nope'])
    assert not result.ok
    assert 'nope' in result.message


def test_verify_heavy_class_walks_chain_via_constructed_instance(stub_module):
    """All chains resolve via the constructed instance — happy path."""
    hc = HeavyClass(
        qualname=f'{stub_module}.Client',
        construct='Client(api_key="x")',
        attr_chains=('indexes.create', 'tasks.create'),
    )
    result = verify_heavy_class(hc)
    assert result.ok, result.message


def test_verify_heavy_class_fails_on_missing_chain(stub_module):
    """Chain breakage names the missing attribute in the failure message."""
    hc = HeavyClass(
        qualname=f'{stub_module}.Client',
        construct='Client(api_key="x")',
        attr_chains=('indexes.no_such_method',),
    )
    result = verify_heavy_class(hc)
    assert not result.ok
    assert 'no_such_method' in result.message


def test_verify_heavy_class_fails_with_source_in_message(stub_module):
    """Source marker (``file:line``) is preserved into the failure's ``where`` field."""
    hc = HeavyClass(
        qualname=f'{stub_module}.Client',
        construct='Client(api_key="x")',
        attr_chains=('indexes.no_such_method',),
        source='some/file.py:42',
    )
    result = verify_heavy_class(hc)
    assert not result.ok
    assert 'some/file.py:42' in result.where


def test_verify_heavy_class_refuses_non_class_target(stub_module):
    """
    Regression: heavy_class refuses to construct a target that isn't a class.

    Auto-extraction emits heavy_class entries for any ``x = callable(...)``
    pattern, but factory functions like ``sqlalchemy.create_engine`` or
    ``transformers.pipeline`` aren't classes. Trying to call them with
    dummy args either errors noisily or, worse, performs real I/O. The
    runner short-circuits before the eval to avoid both.
    """
    # Add a plain function to the stub module — same shape as a factory.
    mod = sys.modules[stub_module]
    mod.factory_func = lambda *_args, **_kwargs: object()

    hc = HeavyClass(
        qualname=f'{stub_module}.factory_func',
        construct='factory_func("x")',
        attr_chains=('foo',),
    )
    result = verify_heavy_class(hc)
    assert not result.ok
    assert 'not a class' in result.message
    assert 'factory_func' in result.where


def test_verify_heavy_class_dotless_qualname_fails_without_crashing(stub_module):
    """
    Regression: a manifest qualname with no module prefix (``'TwelveLabs'``)
    must produce a clean failure, not a ``ValueError`` from unpacking the
    1-element ``rsplit`` result.
    """
    hc = HeavyClass(
        qualname='TwelveLabs',  # no dot
        construct='TwelveLabs()',
        attr_chains=('indexes.create',),
    )
    result = verify_heavy_class(hc)
    assert not result.ok
    assert 'invalid qualname' in result.message


def test_verify_heavy_class_construct_cannot_reach_dangerous_builtins(stub_module):
    """
    The construction eval runs with builtins locked to pure data constructors.
    A construct that reaches for ``open`` (or any non-whitelisted builtin)
    fails with a NameError-shaped construction error rather than executing it.
    """
    hc = HeavyClass(
        qualname=f'{stub_module}.Client',
        construct='Client(handle=open("/etc/passwd"))',
        attr_chains=('indexes.create',),
    )
    result = verify_heavy_class(hc)
    assert not result.ok
    assert 'failed to construct' in result.message


def test_verify_heavy_class_construct_allows_set_dummy(stub_module):
    """
    The whitelist still admits ``set()`` — the dummy generator emits it for
    set-literal args, so locking builtins must not break legitimate constructs.
    """
    hc = HeavyClass(
        qualname=f'{stub_module}.Client',
        construct='Client(tags=set())',
        attr_chains=('indexes.create',),
    )
    result = verify_heavy_class(hc)
    assert result.ok, result.message


# --------------------------------------------------------------------------- #
# Trust-gradient dispatch (cli._checks_for_package)
# --------------------------------------------------------------------------- #


def test_auto_extracted_heavy_class_failure_demotes_to_skip(stub_module, tmp_path):
    """
    Auto-extracted heavy_class failures (``hc.source`` set) become SKIP rows,
    not FAIL — the framework guessed and the guess didn't pan out. Add a
    manifest entry if you want to make the chain a hard requirement.
    """
    from contract_checks.cli import _checks_for_package
    from contract_checks.extractor import ComponentContract

    contract = ComponentContract(
        tree_name='self-test',
        component_name='c',
        component_dir=tmp_path,
        heavy_classes=[
            HeavyClass(
                qualname=f'{stub_module}.Client',
                construct='Client(api_key="x")',
                attr_chains=('indexes.no_such_method',),
                source='some/file.py:42',  # ← marks it auto-extracted
            ),
        ],
    )
    triples = list(_checks_for_package(contract, stub_module))
    # Should contain a SKIP row (from the demotion) — NOT a FAIL.
    heavy_rows = [t for t in triples if 'Client' in t[1]]
    assert any(t[0] == 'skip' for t in heavy_rows), heavy_rows
    assert not any(t[0] == 'fail' for t in heavy_rows), heavy_rows


def test_manifest_heavy_class_failure_stays_fail(stub_module, tmp_path):
    """
    Manifest-declared heavy_class failures (``hc.source`` empty) stay FAIL —
    the maintainer asserted this contract; a break is real signal.
    """
    from contract_checks.cli import _checks_for_package
    from contract_checks.extractor import ComponentContract

    contract = ComponentContract(
        tree_name='self-test',
        component_name='c',
        component_dir=tmp_path,
        heavy_classes=[
            HeavyClass(
                qualname=f'{stub_module}.Client',
                construct='Client(api_key="x")',
                attr_chains=('indexes.no_such_method',),
                source='',  # ← manual manifest entry
            ),
        ],
    )
    triples = list(_checks_for_package(contract, stub_module))
    heavy_rows = [t for t in triples if 'Client' in t[1]]
    assert any(t[0] == 'fail' for t in heavy_rows), heavy_rows


def test_auto_extracted_heavy_class_chain_success_still_passes(stub_module, tmp_path):
    """
    Demotion is failure-only: auto-extracted heavy_class entries whose chains
    DO resolve still report OK. The framework keeps detecting real coverage,
    it just doesn't block when its guesses can't be verified.
    """
    from contract_checks.cli import _checks_for_package
    from contract_checks.extractor import ComponentContract

    contract = ComponentContract(
        tree_name='self-test',
        component_name='c',
        component_dir=tmp_path,
        heavy_classes=[
            HeavyClass(
                qualname=f'{stub_module}.Client',
                construct='Client(api_key="x")',
                attr_chains=('indexes.create', 'tasks.create'),
                source='some/file.py:42',
            ),
        ],
    )
    triples = list(_checks_for_package(contract, stub_module))
    heavy_rows = [t for t in triples if 'Client' in t[1]]
    assert any(t[0] == 'ok' for t in heavy_rows), heavy_rows
    assert not any(t[0] == 'fail' for t in heavy_rows), heavy_rows


# --------------------------------------------------------------------------- #
# Multi-value CLI flag handling
# --------------------------------------------------------------------------- #


def test_cli_parser_accepts_repeated_tree_flag():
    """``--tree=nodes --tree=ai`` accumulates into a list, single use still works."""
    from contract_checks.cli import _build_parser

    parser = _build_parser()
    single = parser.parse_args(['--tree=nodes'])
    assert single.tree == ['nodes']

    multi = parser.parse_args(['--tree=nodes', '--tree=ai'])
    assert multi.tree == ['nodes', 'ai']

    none_given = parser.parse_args([])
    assert none_given.tree is None


def test_cli_parser_accepts_repeated_package_flag():
    """Same accumulation behavior for --package."""
    from contract_checks.cli import _build_parser

    parser = _build_parser()
    multi = parser.parse_args(['--package=requests', '--package=img2table'])
    assert multi.package == ['requests', 'img2table']


def test_cli_parser_accepts_repeated_pattern_flag():
    """Same for --pattern (short form -k also accumulates)."""
    from contract_checks.cli import _build_parser

    parser = _build_parser()
    multi = parser.parse_args(['--pattern=img', '-k', 'twelve'])
    assert multi.pattern == ['img', 'twelve']


def test_cli_parser_accepts_repeated_requirements_flag():
    """Same for --requirements."""
    from contract_checks.cli import _build_parser

    parser = _build_parser()
    multi = parser.parse_args(['--requirements=a.txt', '--requirements=b.txt'])
    assert multi.requirements == ['a.txt', 'b.txt']


# --------------------------------------------------------------------------- #
# Version-matching helper (engine_env.version_matches)
# --------------------------------------------------------------------------- #


def test_version_matches_simple_specs():
    """Sanity checks: each PEP 440 operator behaves as advertised."""
    from contract_checks.engine_env import version_matches

    # Greater-than-or-equal
    assert version_matches('>=2.0', '2.0.0') is True
    assert version_matches('>=2.0', '2.1.0') is True
    assert version_matches('>=2.0', '1.9.9') is False

    # Less-than
    assert version_matches('<2.0', '1.9.9') is True
    assert version_matches('<2.0', '2.0.0') is False

    # Compound range
    assert version_matches('>=1.0,<2.0', '1.5.0') is True
    assert version_matches('>=1.0,<2.0', '2.0.0') is False

    # Compatible release
    assert version_matches('~=1.4', '1.4.99') is True
    assert version_matches('~=1.4', '2.0.0') is False

    # Exact equality
    assert version_matches('==2.0.0', '2.0.0') is True
    assert version_matches('==2.0.0', '2.0.1') is False


def test_version_matches_propagates_bad_spec():
    """Malformed specs raise — caller (cli dispatch) catches and reports."""
    from contract_checks.engine_env import version_matches

    with pytest.raises(Exception):
        version_matches('<= not a spec', '2.0.0')


# --------------------------------------------------------------------------- #
# Requirements file parser (cli.parse_requirements_distributions)
# --------------------------------------------------------------------------- #


def test_requirements_parser_extracts_basic_names(tmp_path):
    """Plain names, pinned versions, and range specifiers all yield the name."""
    from contract_checks.cli import parse_requirements_distributions

    req = tmp_path / 'requirements.txt'
    req.write_text(
        'requests\npymysql==1.2.0\ncryptography>=46.0.7\nnumpy~=1.24\n',
        encoding='utf-8',
    )
    assert parse_requirements_distributions(req) == {
        'requests',
        'pymysql',
        'cryptography',
        'numpy',
    }


def test_requirements_parser_skips_comments_and_blanks(tmp_path):
    """``#`` lines, blank lines, and inline comments after a name are ignored or stripped."""
    from contract_checks.cli import parse_requirements_distributions

    req = tmp_path / 'requirements.txt'
    req.write_text(
        '# header comment\n\nrequests  # we use this for HTTP\n   \n# another comment\npymysql\n',
        encoding='utf-8',
    )
    assert parse_requirements_distributions(req) == {'requests', 'pymysql'}


def test_requirements_parser_skips_options_lines(tmp_path):
    """Lines starting with ``-`` (``-r``, ``-e``, ``--extra-index-url``) are skipped."""
    from contract_checks.cli import parse_requirements_distributions

    req = tmp_path / 'requirements.txt'
    req.write_text(
        '-r other.txt\n--extra-index-url https://example.com/simple\n-e .\nrequests\n',
        encoding='utf-8',
    )
    assert parse_requirements_distributions(req) == {'requests'}


def test_requirements_parser_normalises_per_pep_503(tmp_path):
    """``PyYAML`` and ``py_yaml`` both collapse to ``pyyaml``; ``langchain-core`` survives."""
    from contract_checks.cli import parse_requirements_distributions

    req = tmp_path / 'requirements.txt'
    req.write_text(
        'PyYAML\nlangchain_core\nPillow\n',
        encoding='utf-8',
    )
    # PEP 503: lowercase + runs of -/_/. become a single -.
    assert parse_requirements_distributions(req) == {
        'pyyaml',
        'langchain-core',
        'pillow',
    }


def test_resolve_distributions_to_modules_handles_known_mismatches():
    """For installed packages, packages_distributions gives true module names."""
    from contract_checks.cli import resolve_distributions_to_modules

    # `packaging` is in the engine env (transitive of pip/uv). Its module name
    # happens to match its distribution name, but the function path is the
    # one we care about — it shouldn't raise and should include the module.
    modules = resolve_distributions_to_modules({'packaging'})
    assert 'packaging' in modules


def test_resolve_distributions_to_modules_falls_back_for_uninstalled():
    """Unknown distributions get the heuristic name-mangle (dash → underscore)."""
    from contract_checks.cli import resolve_distributions_to_modules

    modules = resolve_distributions_to_modules({'definitely-not-installed-xyz'})
    assert 'definitely_not_installed_xyz' in modules


# --------------------------------------------------------------------------- #
# requirements_file_skipped (skip-install marker detection)
# --------------------------------------------------------------------------- #


def test_requirements_file_skipped_returns_false_without_marker(tmp_path):
    """Plain requirements file without the marker = not skipped."""
    from contract_checks.engine_env import requirements_file_skipped

    req = tmp_path / 'requirements.txt'
    req.write_text('requests\npymysql==1.2.0\n', encoding='utf-8')

    skipped, reason = requirements_file_skipped(req)
    assert skipped is False
    assert reason == ''


def test_requirements_file_skipped_detects_marker_without_reason(tmp_path):
    """`# contract-check: skip-install` alone returns True with empty reason."""
    from contract_checks.engine_env import requirements_file_skipped

    req = tmp_path / 'requirements.txt'
    req.write_text('# contract-check: skip-install\nsurya-ocr\n', encoding='utf-8')

    skipped, reason = requirements_file_skipped(req)
    assert skipped is True
    assert reason == ''


def test_requirements_file_skipped_extracts_reason(tmp_path):
    """Text after the marker is returned as the reason string."""
    from contract_checks.engine_env import requirements_file_skipped

    req = tmp_path / 'requirements.txt'
    req.write_text(
        '# contract-check: skip-install  reason: opencv pin conflict\nsurya-ocr\n',
        encoding='utf-8',
    )

    skipped, reason = requirements_file_skipped(req)
    assert skipped is True
    assert reason == 'opencv pin conflict'


def test_requirements_file_skipped_extracts_reason_without_reason_prefix(tmp_path):
    """Reason text doesn't have to begin with `reason:` — anything after marker counts."""
    from contract_checks.engine_env import requirements_file_skipped

    req = tmp_path / 'requirements.txt'
    req.write_text(
        '# contract-check: skip-install  opt-in feature, install on nightly\nkokoro\n',
        encoding='utf-8',
    )

    skipped, reason = requirements_file_skipped(req)
    assert skipped is True
    assert reason == 'opt-in feature, install on nightly'


def test_requirements_file_skipped_finds_marker_anywhere_in_file(tmp_path):
    """Marker can appear at the top, bottom, or interleaved — substring scan."""
    from contract_checks.engine_env import requirements_file_skipped

    req = tmp_path / 'requirements.txt'
    req.write_text(
        '# top header comment\nsurya-ocr\n\n# contract-check: skip-install  reason: late marker\n',
        encoding='utf-8',
    )

    skipped, reason = requirements_file_skipped(req)
    assert skipped is True
    assert reason == 'late marker'


def test_requirements_marker_detected_with_two_comments_on_one_line(tmp_path):
    """
    Regression: a line with TWO '#' comments where the marker is the second
    one (e.g. `pkg  # note  # contract-check: disable`) must still register.
    The scanner uses substring search, not "startswith after the first '#'",
    so the leading comment doesn't hide the marker.
    """
    from contract_checks.engine_env import (
        requirements_file_disabled,
        requirements_file_skipped,
    )

    skip_two = tmp_path / 'skip_two.txt'
    skip_two.write_text(
        'kokoro>=0.9.4  # legacy note  # contract-check: skip-install  reason: heavy\n',
        encoding='utf-8',
    )
    skipped, reason = requirements_file_skipped(skip_two)
    assert skipped is True
    assert reason == 'heavy'

    disable_two = tmp_path / 'disable_two.txt'
    disable_two.write_text(
        'surya-ocr  # legacy detector  # contract-check: disable  reason: opencv pin\n',
        encoding='utf-8',
    )
    disabled, reason = requirements_file_disabled(disable_two)
    assert disabled is True
    assert reason == 'opencv pin'


def test_requirements_file_skipped_returns_false_on_missing_file(tmp_path):
    """Non-existent file = not skipped, empty reason; no exception raised."""
    from contract_checks.engine_env import requirements_file_skipped

    missing = tmp_path / 'does_not_exist.txt'
    skipped, reason = requirements_file_skipped(missing)
    assert skipped is False
    assert reason == ''


# --------------------------------------------------------------------------- #
# requirements_file_disabled (NEVER install, even under --install-all)
# --------------------------------------------------------------------------- #


def test_requirements_file_disabled_detects_marker(tmp_path):
    """`# contract-check: disable` is recognised, reason extracted."""
    from contract_checks.engine_env import requirements_file_disabled

    req = tmp_path / 'requirements.txt'
    req.write_text(
        '# contract-check: disable  reason: opencv pin conflict\nsurya-ocr\n',
        encoding='utf-8',
    )
    disabled, reason = requirements_file_disabled(req)
    assert disabled is True
    assert reason == 'opencv pin conflict'


def test_requirements_file_disabled_returns_false_without_marker(tmp_path):
    """Plain file = not disabled."""
    from contract_checks.engine_env import requirements_file_disabled

    req = tmp_path / 'requirements.txt'
    req.write_text('requests\n', encoding='utf-8')
    disabled, _ = requirements_file_disabled(req)
    assert disabled is False


def test_requirements_file_skipped_and_disabled_are_independent(tmp_path):
    """A file with `skip-install` is not flagged as `disable`d, and vice versa."""
    from contract_checks.engine_env import (
        requirements_file_disabled,
        requirements_file_skipped,
    )

    skip_only = tmp_path / 'skip.txt'
    skip_only.write_text('# contract-check: skip-install\nkokoro\n', encoding='utf-8')
    assert requirements_file_skipped(skip_only)[0] is True
    assert requirements_file_disabled(skip_only)[0] is False

    disable_only = tmp_path / 'disable.txt'
    disable_only.write_text('# contract-check: disable\nsurya-ocr\n', encoding='utf-8')
    assert requirements_file_skipped(disable_only)[0] is False
    assert requirements_file_disabled(disable_only)[0] is True


def test_install_loop_disable_wins_over_install_all(tmp_path, capsys, monkeypatch):
    """
    Regression: a file marked `# contract-check: disable` is NEVER passed to
    depends(), even when ``install_all=True``. The stronger marker beats the
    override flag — this is the whole reason `disable` exists (fundamental
    install conflicts where attempting install just guarantees a failure).
    Status line goes to STDOUT, not STDERR.
    """
    from contract_checks.cli import _install_all_requirements
    from contract_checks.trees import Tree

    (tmp_path / 'requirements_disabled.txt').write_text(
        '# contract-check: disable  reason: known conflict\nsurya-ocr\n',
        encoding='utf-8',
    )

    calls: list[str] = []

    def _fake_depends(path: str) -> None:
        """Test stub: would record the call if reached. Must NOT be reached."""
        calls.append(path)

    monkeypatch.setattr('contract_checks.cli.depends', _fake_depends)

    tree = Tree(
        name='self-test',
        root=tmp_path,
        internal_packages=frozenset(),
    )

    # Even with install_all=True, disabled files are never installed.
    _install_all_requirements([tree], install_all=True, verbose=False)
    assert calls == []
    captured = capsys.readouterr()
    assert '[disable]' in captured.out, captured.out
    assert 'known conflict' in captured.out
    # And the install-all bypass line is NOT emitted for disabled files.
    assert '[install-all]' not in captured.out


# --------------------------------------------------------------------------- #
# Install loop — depends() propagates errors, install loop catches per-file
# --------------------------------------------------------------------------- #


def test_install_loop_continues_on_per_file_failure(tmp_path, capsys, monkeypatch):
    """
    The install hook MUST NOT abort the run when one requirements file fails.
    It catches per-file, emits a `[install-failed]` line on stderr, and
    proceeds to the next file. Validates the Option-B design from the plan.
    """
    from contract_checks.cli import _install_all_requirements
    from contract_checks.trees import Tree

    # Two fake requirements files in the tmp tree.
    (tmp_path / 'requirements_good.txt').write_text('requests\n', encoding='utf-8')
    (tmp_path / 'requirements_bad.txt').write_text('definitely-broken\n', encoding='utf-8')

    # Monkey-patch depends() to fail for the "bad" file and succeed for the others.
    calls: list[str] = []

    def _fake_depends(path: str) -> None:
        """Test stub: succeeds for *good* files, raises for *bad* ones."""
        calls.append(path)
        if 'bad' in path:
            raise RuntimeError('uv pip install error: simulated failure')

    monkeypatch.setattr('contract_checks.cli.depends', _fake_depends)

    tree = Tree(
        name='self-test',
        root=tmp_path,
        internal_packages=frozenset(),
    )
    _install_all_requirements([tree], install_all=False, verbose=False)

    # Both files were attempted.
    assert any('good' in c for c in calls)
    assert any('bad' in c for c in calls)

    # The failure was reported on stderr; the good install didn't trigger a line.
    err = capsys.readouterr().err
    assert '[install-failed]' in err
    assert 'requirements_bad.txt' in err
    assert 'simulated failure' in err
    # Sanity: the good file wasn't reported as failed (stderr only carries
    # [install-failed] lines, so the good file must not appear at all).
    assert 'requirements_good.txt' not in err


def test_install_loop_install_all_overrides_marker(tmp_path, capsys, monkeypatch):
    """
    With `install_all=True`, files carrying the skip-install marker are
    attempted (and the bypass is logged), instead of being silently skipped.
    """
    from contract_checks.cli import _install_all_requirements
    from contract_checks.trees import Tree

    # Marked file — would be skipped under default behaviour.
    (tmp_path / 'requirements_marked.txt').write_text(
        '# contract-check: skip-install  reason: test marker\nrequests\n',
        encoding='utf-8',
    )

    calls: list[str] = []

    def _fake_depends(path: str) -> None:
        """Test stub: succeeds for any input, records the call."""
        calls.append(path)

    monkeypatch.setattr('contract_checks.cli.depends', _fake_depends)

    tree = Tree(
        name='self-test',
        root=tmp_path,
        internal_packages=frozenset(),
    )

    # Default: marker honoured, depends() NOT called. The status line
    # goes to STDOUT (install-layer chatter belongs with check output).
    _install_all_requirements([tree], install_all=False, verbose=False)
    assert calls == []
    out = capsys.readouterr().out
    assert '[skip-install]' in out

    # --install-all: marker bypassed, depends() called, bypass logged on STDOUT.
    _install_all_requirements([tree], install_all=True, verbose=False)
    assert len(calls) == 1
    out = capsys.readouterr().out
    assert '[install-all]' in out
    assert 'bypassing skip-install marker' in out


# --------------------------------------------------------------------------- #
# Constraint-drift: PEP 503 name normalization
# --------------------------------------------------------------------------- #


def test_normalize_dist_name_folds_separators_and_case():
    """Hyphens, underscores, and dots collapse to '-'; the name lowercases."""
    assert normalize_dist_name('langchain_core') == 'langchain-core'
    assert normalize_dist_name('Langchain-Core') == 'langchain-core'
    assert normalize_dist_name('zope.interface') == 'zope-interface'
    assert normalize_dist_name('a__b--c..d') == 'a-b-c-d'


def test_constraint_match_resolves_import_name_to_distribution_pin(monkeypatch):
    """
    Regression: an import-style name (``langchain_core``) must match the
    distribution-style constraints key (``langchain-core``). Lowercasing alone
    missed this, so drift on any `_`-vs-`-` package was silently skipped.
    """
    monkeypatch.setattr('contract_checks.runner.read_constraints', lambda: {'langchain-core': '0.3.1'})
    monkeypatch.setattr('contract_checks.runner.installed_version', lambda pkg: '0.3.1')
    result = verify_constraint_match('langchain_core')
    assert result.ok is True
    assert 'matches pin' in result.message


def test_constraint_match_detects_drift_across_separator(monkeypatch):
    """Drift is still flagged when names differ only by separator style."""
    monkeypatch.setattr('contract_checks.runner.read_constraints', lambda: {'langchain-core': '0.3.1'})
    monkeypatch.setattr('contract_checks.runner.installed_version', lambda pkg: '0.2.0')
    result = verify_constraint_match('langchain_core')
    assert result.ok is False
    assert 'constraints pin 0.3.1' in result.message
