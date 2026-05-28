"""
Command-line runner for the check-externals framework.

This is the implementation of ``builder check-externals:run``. It walks the
configured trees, extracts each component's contract, and runs the verifier
functions against the engine's installed package versions.

Invoked via the wrapper at ``tools/contract_checks/cli.py``:

    engine tools/contract_checks/cli.py [--tree=NAME] [--package=NAME]
                                        [--pattern=SUBSTR] [--no-install]

Exit code: 0 if there are no failures (skipped checks don't count as failures),
1 otherwise. Skipped status (yellow) is used when a third-party package isn't
installed in the engine env — the framework's job is to flag interface drift,
not absence.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import re
import sys
from pathlib import Path
from typing import Optional

from contract_checks.engine_env import (
    depends,
    ensure_constraints,
    installed_version,
    requirements_file_disabled,
    requirements_file_skipped,
    version_matches,
)
from contract_checks.extractor import (
    ComponentContract,
    extract_component,
    iter_components,
)
from contract_checks.runner import (
    verify_any_of,
    verify_constraint_match,
    verify_heavy_class,
    verify_import,
)
from contract_checks.trees import SCANNED_TREES, Tree


# --------------------------------------------------------------------------- #
# Per-package check dispatch
# --------------------------------------------------------------------------- #


def _check_applies(applies_when: Optional[str], package: str) -> tuple[bool, str]:
    """
    Decide whether an entry's ``applies_when`` matches the installed version.

    Args:
        applies_when: PEP 440 specifier from the entry (``None`` = no
                      constraint, always applies).
        package:      Top-level package name whose installed version to
                      compare against the spec.

    Returns:
        ``(True, '')`` when the check should run (no constraint, or spec
        matches the installed version). ``(False, reason)`` when the check
        should be skipped — reason is a human-readable string the dispatch
        loop puts in the ``[SKIP]`` row.
    """
    if not applies_when:
        return True, ''
    installed = installed_version(package)
    if installed is None:
        return False, f'applies_when={applies_when!r}, package not installed'
    try:
        if version_matches(applies_when, installed):
            return True, ''
        return False, f'applies_when={applies_when!r}, installed={installed}'
    except Exception as e:
        return False, f'malformed applies_when={applies_when!r}: {e}'


def _checks_for_package(contract: ComponentContract, package: str):
    """
    Yield one ``(status, where, message)`` triple per check touching ``package``.

    Each entry's ``applies_when`` is consulted first; entries that don't
    apply to the installed version yield ``('skip', where, reason)`` without
    running the underlying verifier.

    Args:
        contract: The component's resolved contract (AST + manifest overlay).
        package:  Top-level package name (e.g., ``"twelvelabs"``).

    Yields:
        Tuples of ``(status, where, message)`` where ``status`` is one of
        ``'ok'``, ``'skip'``, ``'fail'``; ``where`` names the symbol or
        chain that was checked; ``message`` is a short explanation for the
        output row.
    """

    def _top(name: str) -> str:
        """Return the top-level package name from a dotted module/qualname."""
        return name.split('.', 1)[0]

    def _emit_result(r) -> tuple[str, str, str]:
        """Map a :class:`CheckResult` to a ``(status, where, message)`` triple."""
        return ('ok' if r.ok else 'fail', r.where, r.message)

    for req in contract.imports:
        if _top(req.module) != package:
            continue
        applies, reason = _check_applies(req.applies_when, package)
        if not applies:
            yield ('skip', req.module, reason)
            continue
        yield _emit_result(verify_import(req))

    for group in contract.any_of_imports:
        if not any(_top(alt.module) == package for alt in group.alternatives):
            continue
        applies, reason = _check_applies(group.applies_when, package)
        if not applies:
            where = ' | '.join(alt.module for alt in group.alternatives)
            yield ('skip', where, reason)
            continue
        yield _emit_result(verify_any_of(group))

    for hc in contract.heavy_classes:
        if _top(hc.qualname) != package:
            continue
        applies, reason = _check_applies(hc.applies_when, package)
        if not applies:
            yield ('skip', hc.qualname, reason)
            continue
        result = verify_heavy_class(hc)
        if not result.ok and hc.source:
            # Auto-extracted heavy_class (hc.source is set by the extractor).
            # The AST guessed at a (construct, chain) pair; if construction
            # fails, that's a guess that didn't pan out — not a real upstream
            # drift signal. Demote to SKIP so it doesn't block CI. A
            # maintainer who wants to enforce this chain should declare the
            # HeavyClass in a manifest (where it would stay a hard FAIL).
            yield (
                'skip',
                result.where,
                f'auto-extracted heavy_class could not be verified ({result.message})',
            )
            continue
        yield _emit_result(result)

    yield _emit_result(verify_constraint_match(package))


# --------------------------------------------------------------------------- #
# Requirements-file filter
# --------------------------------------------------------------------------- #


# PEP 508 line-shape: pull the distribution name from the start of a
# non-comment requirement line. Strips version specifiers, environment
# markers, and extras. Insensitive to leading whitespace.
_REQUIREMENT_LINE = re.compile(r'^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)')


def _normalize_distribution_name(name: str) -> str:
    """
    Apply PEP 503 normalization to a distribution name.

    Args:
        name: Raw distribution name (e.g., ``"PyYAML"``, ``"langchain_core"``).

    Returns:
        Lowercase form with runs of ``-``, ``_``, ``.`` collapsed to a
        single ``-`` (e.g., ``"pyyaml"``, ``"langchain-core"``).
    """
    return re.sub(r'[-_.]+', '-', name).lower()


def parse_requirements_distributions(req_file: Path) -> set[str]:
    """
    Read a ``requirements.txt`` and return the set of distribution names.

    Recognises the common subset of PEP 508 / pip requirements grammar:
    blank lines and ``#`` comments are skipped; lines beginning with ``-``
    (``-r other.txt``, ``-e .``, ``--extra-index-url ...``) are skipped;
    everything else has its leading distribution name extracted via
    :data:`_REQUIREMENT_LINE`, then normalised via
    :func:`_normalize_distribution_name`.

    Args:
        req_file: Path to a requirements.txt file.

    Returns:
        Set of PEP 503-normalized distribution names found in the file.

    Raises:
        FileNotFoundError: When ``req_file`` doesn't exist.
    """
    distributions: set[str] = set()
    for raw in req_file.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or line.startswith('-'):
            continue
        match = _REQUIREMENT_LINE.match(line)
        if match:
            distributions.add(_normalize_distribution_name(match.group(1)))
    return distributions


def resolve_distributions_to_modules(distributions: set[str]) -> set[str]:
    """
    Map a set of pip distribution names to their top-level Python module names.

    Some packages have a different module name than their pip name
    (``Pillow`` → ``PIL``, ``PyYAML`` → ``yaml``, ``langchain-core`` →
    ``langchain_core``). ``importlib.metadata.packages_distributions``
    knows the true mapping for any installed distribution; fall back to a
    name-mangle heuristic (lowercase, ``-`` → ``_``) when a distribution
    isn't installed in the engine env.

    Args:
        distributions: PEP 503-normalized distribution names.

    Returns:
        Set of top-level Python module names. May contain more than one
        entry per distribution when the distribution provides multiple
        top-level modules.
    """
    # Build the inverted lookup: normalized-dist-name -> [module names].
    dist_to_modules: dict[str, list[str]] = {}
    for module_name, dists in importlib.metadata.packages_distributions().items():
        for dist in dists:
            dist_to_modules.setdefault(_normalize_distribution_name(dist), []).append(module_name)

    modules: set[str] = set()
    for dist in distributions:
        if dist in dist_to_modules:
            modules.update(dist_to_modules[dist])
        else:
            # Distribution not installed — guess the module name from the
            # pip name. Works for the common case (langchain-core →
            # langchain_core) but misses outliers (Pillow → PIL).
            modules.add(dist.replace('-', '_'))
    return modules


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #


def _emit(triple_id: str, where: str, status: str, message: str, verbose: bool) -> None:
    """
    Print one result row, respecting verbosity.

    Non-verbose mode prints only ``FAIL`` rows. Verbose mode prints
    ``OK``, ``SKIP``, and ``FAIL`` — full transparency for debugging.

    Args:
        triple_id: ``<tree>/<component>/<package>`` identifier.
        where:     Dotted name of the symbol or class the check targeted.
        status:    One of ``'ok'``, ``'skip'``, ``'fail'``.
        message:   Short human-readable explanation.
        verbose:   When ``False``, OK and SKIP rows are suppressed.
    """
    if status != 'fail' and not verbose:
        return
    tag = {'ok': 'OK  ', 'skip': 'SKIP', 'fail': 'FAIL'}[status]
    suffix = f': {where}' if where else ''
    print(f'[{tag}] {triple_id}{suffix}: {message}')


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def _find_tree(name: str) -> Optional[Tree]:
    """Return the :class:`Tree` in :data:`SCANNED_TREES` whose name matches, or None."""
    for tree in SCANNED_TREES:
        if tree.name == name:
            return tree
    return None


def _build_parser() -> argparse.ArgumentParser:
    """Construct the argparse parser for the ``check-externals:run`` CLI."""
    parser = argparse.ArgumentParser(
        prog='check-externals',
        description='Verify 3rd-party Python module interfaces used by the engine.',
    )
    parser.add_argument(
        '--tree',
        action='append',
        help='Limit checks to these trees. Repeat for multiple: '
        '--tree=nodes --tree=ai. Valid names: nodes, ai, client-python, '
        'rocketlib.',
    )
    parser.add_argument(
        '--package',
        action='append',
        help='Limit checks to these third-party packages (top-level names). '
        'Repeat for multiple: --package=requests --package=img2table. '
        'OR semantics within the flag.',
    )
    parser.add_argument(
        '--pattern',
        '-k',
        action='append',
        help='Substring filter applied to each triple id '
        '"<tree>/<component>/<package>". Repeat for multiple patterns '
        'with OR semantics: --pattern=img --pattern=twelve.',
    )
    parser.add_argument(
        '--no-install',
        action='store_true',
        help='Skip per-component depends() install; rely on whatever is already in the engine env.',
    )
    parser.add_argument(
        '--fail-on-missing',
        action='store_true',
        help='Treat missing packages as failures instead of skips (off by default).',
    )
    parser.add_argument(
        '--requirements',
        metavar='FILE',
        action='append',
        help='Limit checks to packages listed in the given requirements.txt file. '
        'Pip distribution names are mapped to top-level Python module names '
        'via importlib.metadata.packages_distributions; repeat for multiple '
        'files (the resolved package sets are unioned). Combine with '
        '--tree, --package, and --pattern as needed.',
    )
    parser.add_argument(
        '--verbose',
        '-v',
        action='store_true',
        help='Print OK and SKIP rows in addition to FAIL. Default prints only '
        'FAIL rows; the summary line ("N passed, M skipped, K failed") '
        'always prints regardless.',
    )
    parser.add_argument(
        '--install-all',
        action='store_true',
        help='Ignore `# contract-check: skip-install` markers in requirements '
        'files and install everything. PR lanes respect markers (fast); '
        'nightly lanes use this flag for full coverage.',
    )
    return parser


def _install_all_requirements(trees, *, install_all: bool, verbose: bool) -> None:
    """
    Walk every ``requirement*.txt`` under each scanned tree and install via
    ``depends()``, honouring ``# contract-check: skip-install`` markers
    unless ``install_all`` is set.

    Matches the engine's own ``requirement*.txt`` glob in
    ``packages/server/engine-lib/rocketlib-python/lib/depends.py``. Recursive,
    so model-bundle files like
    ``packages/ai/src/ai/common/models/audio/requirements_kokoro.txt``
    get picked up (they were invisible to the previous per-component finder).

    Each file is fed to ``depends()`` exactly once across the session,
    deduped by absolute path. The engine's ``depends._processed`` set
    further dedupes inside the engine.

    Args:
        trees:       Iterable of :class:`Tree` configs to walk.
        install_all: When True, install every file regardless of marker.
                     When False, skip files carrying
                     ``# contract-check: skip-install`` and emit a stderr
                     line naming the file + reason.
        verbose:     When True, also emit one stderr line per file
                     ``depends()`` is called on (for trace visibility).
    """
    seen: set[Path] = set()
    for tree in trees:
        if not tree.root.exists():
            continue
        for req in sorted(tree.root.rglob('requirement*.txt')):
            if not req.is_file():
                continue
            req = req.resolve()
            if req in seen:
                continue
            seen.add(req)

            # `disable` is checked FIRST and is strictly stronger than
            # `skip-install` — disabled files are never installed by the
            # framework, even under --install-all. Use it for fundamental
            # incompatibilities (e.g., surya/trocr's opencv conflict) where
            # attempting install just produces a guaranteed [install-failed]
            # line and wastes CI time. Paired with `# contract-check: ignore`
            # on the consuming imports so the contract isn't checked either.
            #
            # Install-layer status lines ([disable], [skip-install],
            # [install-all], [install]) go to STDOUT alongside the contract
            # check output ([OK]/[SKIP]/[FAIL]) so a single redirect
            # captures the full transcript. Only [install-failed] goes to
            # STDERR since it's a real failure event.
            disabled, disable_reason = requirements_file_disabled(req)
            if disabled:
                msg = f'[disable] {req}'
                if disable_reason:
                    msg += f': {disable_reason}'
                print(msg)
                continue

            skipped, reason = requirements_file_skipped(req)
            if skipped and not install_all:
                msg = f'[skip-install] {req}'
                if reason:
                    msg += f': {reason}'
                print(msg)
                continue
            if skipped and install_all:
                print(f'[install-all] {req}: bypassing skip-install marker')

            if verbose:
                print(f'[install] {req}')
            try:
                depends(str(req))
            except Exception as e:
                # Don't abort the run — a single failing file shouldn't
                # cost coverage of every other file. Make the failure
                # visible in CI logs so it can be triaged (e.g., a
                # previously installable file starting to conflict).
                # Files with fundamental incompatibilities should use the
                # stronger `# contract-check: disable` marker so they never
                # reach this branch.
                print(
                    f'[install-failed] {req}: {type(e).__name__}: {e}',
                    file=sys.stderr,
                )


def main(argv: Optional[list[str]] = None) -> int:
    """Entry point. Returns 0 on success, 1 on any failure, 2 on bad arg."""
    args = _build_parser().parse_args(argv)

    # --tree: list[str] when supplied (action='append'); resolve every name
    # to a Tree object, dedupe (preserving first occurrence), fail loudly on
    # any unknown name. Empty/None means "all scanned trees".
    trees: list[Tree]
    if args.tree:
        trees = []
        seen_names: set[str] = set()
        for name in args.tree:
            if name in seen_names:
                continue
            tree = _find_tree(name)
            if tree is None:
                print(f'unknown tree: {name!r}', file=sys.stderr)
                return 2
            trees.append(tree)
            seen_names.add(name)
    else:
        trees = list(SCANNED_TREES)

    # --requirements: list[str] when supplied; union the resolved module set
    # across every file. Restricts the per-package loop below.
    allowed_modules: Optional[set[str]] = None
    if args.requirements:
        allowed_modules = set()
        for req_str in args.requirements:
            req_path = Path(req_str)
            if not req_path.exists():
                print(f'error: requirements file not found: {req_path}', file=sys.stderr)
                return 2
            distributions = parse_requirements_distributions(req_path)
            allowed_modules |= resolve_distributions_to_modules(distributions)
        if not allowed_modules:
            print(
                'warning: --requirements parsed to 0 packages; nothing will run',
                file=sys.stderr,
            )

    # --package / --pattern: list[str] when supplied; treated as OR within
    # the flag (any match accepts the row).
    package_filter: Optional[set[str]] = set(args.package) if args.package else None
    pattern_filter: Optional[list[str]] = args.pattern if args.pattern else None

    if not args.no_install:
        ensure_constraints()
        # Recursive install hook: walks every requirement*.txt under each
        # tree (matching the engine's own glob) and feeds each to depends().
        # Files carrying `# contract-check: skip-install` are bypassed unless
        # --install-all is set. This subsumes the old per-component
        # requirements_finder mechanism (which only saw the exact filename
        # `requirements.txt` and only at the tree-root immediate subdir).
        _install_all_requirements(trees, install_all=args.install_all, verbose=args.verbose)

    passed = skipped = failed = 0

    for tree in trees:
        for component_dir in iter_components(tree):
            contract = extract_component(tree, component_dir)

            for package in contract.packages:
                if package_filter is not None and package not in package_filter:
                    continue
                if allowed_modules is not None and package not in allowed_modules:
                    continue
                triple_id = f'{tree.name}/{component_dir.name}/{package}'
                if pattern_filter is not None and not any(p in triple_id for p in pattern_filter):
                    continue

                # Mirror pytest.importorskip: a missing top-level package is
                # SKIP, not FAIL — we report interface drift, not absence.
                if importlib.util.find_spec(package) is None:
                    if args.fail_on_missing:
                        _emit(triple_id, package, 'fail', 'package not installed in engine env', args.verbose)
                        failed += 1
                    else:
                        _emit(triple_id, package, 'skip', 'package not installed in engine env', args.verbose)
                        skipped += 1
                    continue

                for status, where, message in _checks_for_package(contract, package):
                    _emit(triple_id, where, status, message, args.verbose)
                    if status == 'ok':
                        passed += 1
                    elif status == 'skip':
                        skipped += 1
                    else:
                        failed += 1

    total = passed + skipped + failed
    print(f'\n{passed} passed, {skipped} skipped, {failed} failed ({total} checks total)')
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
