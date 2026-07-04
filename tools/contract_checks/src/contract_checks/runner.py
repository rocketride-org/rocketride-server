"""
Pure check functions — no pytest dependency.

Each ``verify_*`` returns a :class:`CheckResult` describing pass or fail.
The pytest layer aggregates results and asserts; the CLI prints them.
"""

from __future__ import annotations

import importlib
import inspect
import os
import signal
import threading
from dataclasses import dataclass
from typing import Optional

from contract_checks.engine_env import installed_version, normalize_dist_name, read_constraints
from contract_checks.manifest import AnyOf, HeavyClass, ImportRequirement


# Hard cap on heavy-class construction time. Anything longer is reported as a
# manifest bug — SDK constructors should never do I/O when the manifest writer
# claims they don't.
_CONSTRUCT_TIMEOUT_SEC = 2.0


@dataclass(frozen=True)
class CheckResult:
    """
    Result of one check (one import path / any-of group / chain / drift).

    Attributes:
        ok:      ``True`` on pass, ``False`` on hard fail. (Skip semantics
                 live one layer up in the CLI's per-package gating, not on
                 this dataclass.)
        message: Human-readable explanation. On pass: typically ``"ok"`` or
                 a short success note. On fail: includes what was checked
                 and how it failed.
        where:   Dotted identifier (e.g., ``"img2table.ocr._types"``) for
                 the symbol or class the check targeted. Used in output
                 lines so a reader can locate the upstream surface fast.
    """

    ok: bool
    message: str
    where: str = ''


# --------------------------------------------------------------------------- #
# Verifiers
# --------------------------------------------------------------------------- #


def verify_import(req: ImportRequirement) -> CheckResult:
    """
    Resolve a single ``from <module> import <symbol>, ...`` requirement.

    Mirrors Python's actual ``from X import Y`` semantics: first checks
    ``hasattr(X, 'Y')``; on miss, falls back to trying to import ``X.Y`` as
    a submodule. This matters for lazy-loaded subpackages — e.g.,
    ``from PIL import Image`` works at runtime because ``PIL.Image`` is a
    submodule, but ``hasattr(PIL, 'Image')`` returns False until something
    triggers the submodule import.

    Args:
        req: Requirement to verify.

    Returns:
        :class:`CheckResult` with ``ok=True`` when ``req.module`` imports
        cleanly AND every name in ``req.symbols`` is reachable either as
        an attribute or as an importable submodule. ``ok=False`` on the
        first import / attribute / submodule miss, with the message naming
        the offending module or symbol.
    """
    try:
        mod = importlib.import_module(req.module)
    except Exception as e:
        return CheckResult(
            ok=False,
            message=f'cannot import module {req.module!r}: {type(e).__name__}: {e}',
            where=req.module,
        )
    for sym in req.symbols:
        if hasattr(mod, sym):
            continue
        # Submodule fallback: `from PIL import Image` resolves via
        # `import PIL.Image` when Image isn't an attribute on the package.
        target = f'{req.module}.{sym}'
        try:
            importlib.import_module(target)
            continue
        except ModuleNotFoundError as e:
            # Only fall through to "symbol not found" when the *probed* module
            # is the missing one. A different missing name means the submodule
            # exists but a nested import failed — report that honestly.
            if e.name != target:
                return CheckResult(
                    ok=False,
                    message=f'importing submodule {target} raised ModuleNotFoundError: {e}',
                    where=target,
                )
        except ImportError as e:
            # Submodule exists but its import raised (circular import,
            # "cannot import name", …) — a real failure, not "not found".
            return CheckResult(
                ok=False,
                message=f'importing submodule {target} raised ImportError: {e}',
                where=target,
            )
        except Exception as e:
            return CheckResult(
                ok=False,
                message=f'importing submodule {target} raised {type(e).__name__}: {e}',
                where=target,
            )
        return CheckResult(
            ok=False,
            message=f'symbol {sym!r} not found in module {req.module!r}',
            where=target,
        )
    return CheckResult(ok=True, message='ok', where=req.module)


def verify_any_of(group: AnyOf) -> CheckResult:
    """
    Verify a multi-version fallback group.

    Args:
        group: Set of :class:`ImportRequirement` alternatives.

    Returns:
        :class:`CheckResult` with ``ok=True`` as soon as one alternative
        verifies — earlier alternatives that failed are not reported.
        ``ok=False`` only when every alternative failed; the message then
        carries each alternative's individual error indented for readability.
    """
    errors: list[str] = []
    for alt in group.alternatives:
        result = verify_import(alt)
        if result.ok:
            return CheckResult(
                ok=True,
                message=f'matched alternative {alt.module}',
                where=alt.module,
            )
        errors.append(f'  - {alt.module}: {result.message}')
    return CheckResult(
        ok=False,
        message='no alternative resolved:\n' + '\n'.join(errors),
        where=' | '.join(alt.module for alt in group.alternatives),
    )


def verify_class_attrs(module: str, symbol: str, attrs: list[str]) -> CheckResult:
    """
    Verify that a class exposes a set of attributes at the class level.

    Class-level only: no instance is constructed. Use this for SDKs whose
    attributes are declared as class methods or class variables. For SDKs
    that populate ``self.*`` in ``__init__``, use :func:`verify_heavy_class`
    instead.

    Args:
        module: Dotted module name to import (e.g., ``"numpy"``).
        symbol: Attribute name on the imported module that resolves to the
                class (e.g., ``"ndarray"``).
        attrs:  Class-level attribute names to check via ``hasattr``.

    Returns:
        :class:`CheckResult` with ``ok=True`` when every name in ``attrs``
        is an attribute of the class; ``ok=False`` with the missing names
        listed when one or more fail.
    """
    try:
        mod = importlib.import_module(module)
        cls = getattr(mod, symbol)
    except Exception as e:
        return CheckResult(
            ok=False,
            message=f'cannot reach {module}.{symbol}: {e}',
            where=f'{module}.{symbol}',
        )
    missing = [a for a in attrs if not hasattr(cls, a)]
    if missing:
        return CheckResult(
            ok=False,
            message=f'missing class-level attrs: {", ".join(missing)}',
            where=f'{module}.{symbol}',
        )
    return CheckResult(ok=True, message='ok', where=f'{module}.{symbol}')


def verify_heavy_class(hc: HeavyClass) -> CheckResult:
    """
    Construct an SDK class and walk each declared attribute chain.

    The construction expression is ``eval()``'d in a fresh namespace holding
    the imported class symbol plus a whitelist of pure data-constructor
    builtins (``_EVAL_BUILTINS``) — ``open``/``__import__``/``exec`` and the
    like are not reachable. The eval is wrapped in a 2-second wall-clock cap
    (``signal.alarm`` on POSIX, watcher thread on Windows) — a timeout means
    the manifest entry is wrong: either the SDK is doing I/O during
    ``__init__``, or the construct expression is doing something heavier than
    dummy-arg construction.

    Args:
        hc: Heavy-class entry — either from a per-component manifest or
            auto-generated by the extractor's intra-procedural tracking.

    Returns:
        :class:`CheckResult` with ``ok=True`` when every chain in
        ``hc.attr_chains`` resolves via repeated ``getattr`` against the
        constructed instance. Failure cases:
          * Module / class import fails -> ``ok=False`` with the import error.
          * Construction times out -> ``ok=False`` with "construction timed out".
          * Construction raises -> ``ok=False`` with the exception type/message
            and a hint that ``construct`` needs override via manifest.
          * Chain walk hits a missing attribute -> ``ok=False`` with the chain,
            the breakpoint, and the construct expression for reproduction.
        On failure, ``where`` includes ``[<source>]`` when ``hc.source`` is
        set (i.e., the chain was auto-extracted from real source).
    """
    # A dotless qualname (e.g. a manifest typo `qualname='TwelveLabs'`) would
    # make rsplit return a 1-element list and crash the unpack. Fail it cleanly.
    if '.' not in hc.qualname:
        return CheckResult(
            ok=False,
            message=(f"invalid qualname {hc.qualname!r}: expected a dotted 'module.ClassName' path"),
            where=hc.qualname + (f' [{hc.source}]' if hc.source else ''),
        )
    module, class_name = hc.qualname.rsplit('.', 1)
    try:
        mod = importlib.import_module(module)
        cls = getattr(mod, class_name)
    except Exception as e:
        return CheckResult(
            ok=False,
            message=f'cannot reach {hc.qualname}: {e}',
            where=hc.qualname + (f' [{hc.source}]' if hc.source else ''),
        )

    # Refuse to construct anything that isn't a class. Auto-extraction
    # treats every `x = some_callable(...); x.attr(...)` pattern as a
    # heavy_class candidate, but `create_engine`, `pipeline`,
    # `ocr_predictor`, etc. are factory functions — eval'ing them with
    # dummy args either raises noisily (false-positive) or, worse, does
    # real I/O. Manifest entries get the same treatment so a wrong
    # qualname produces a clear error instead of a confusing trace.
    if not inspect.isclass(cls):
        kind = type(cls).__name__
        return CheckResult(
            ok=False,
            message=(
                f'{hc.qualname} is a {kind}, not a class — heavy_class can '
                f'only construct + walk real classes. If this is a factory '
                f'function whose return value you want to verify, add an '
                f'ImportRequirement entry for the symbol instead, or omit '
                f'the heavy_class entry.'
            ),
            where=hc.qualname + (f' [{hc.source}]' if hc.source else ''),
        )

    namespace = {'__builtins__': _EVAL_BUILTINS, class_name: cls}
    try:
        instance = _eval_with_timeout(hc.construct, namespace, _CONSTRUCT_TIMEOUT_SEC)
    except _ConstructionTimeout:
        msg = (
            f'construction timed out after {_CONSTRUCT_TIMEOUT_SEC}s '
            f'(expr: {hc.construct!r}) -> add a manifest entry with safer '
            f'dummy args, or remove the heavy_class entry'
        )
        return CheckResult(
            ok=False,
            message=msg,
            where=hc.qualname + (f' [{hc.source}]' if hc.source else ''),
        )
    except Exception as e:
        marker = f' [auto-extracted from {hc.source}]' if hc.source else ''
        msg = (
            f'failed to construct {hc.qualname}{marker}: '
            f'{type(e).__name__}: {e} (expr: {hc.construct!r}) -> '
            f'add a manifest entry to override'
        )
        return CheckResult(
            ok=False,
            message=msg,
            where=hc.qualname + (f' [{hc.source}]' if hc.source else ''),
        )

    for chain in hc.attr_chains:
        obj = instance
        walked: list[str] = []
        for part in chain.split('.'):
            if not hasattr(obj, part):
                return CheckResult(
                    ok=False,
                    message=(
                        f'attribute chain {chain!r} broke at .{part} '
                        f'(walked: .{".".join(walked) if walked else "<root>"}, '
                        f'construct: {hc.construct!r})'
                    ),
                    where=hc.qualname + (f' [{hc.source}]' if hc.source else ''),
                )
            obj = getattr(obj, part)
            walked.append(part)
        if not callable(obj) and not inspect.isclass(obj):
            # Many SDK property chains end at a sub-object that itself is
            # callable; a few end at scalar attributes. We only flag when the
            # final node is plainly neither.
            pass  # tolerated — the chain resolved, that's enough

    return CheckResult(
        ok=True,
        message=f'all {len(hc.attr_chains)} chain(s) resolved',
        where=hc.qualname,
    )


def verify_constraint_match(package: str) -> CheckResult:
    """
    Detect drift between the engine's resolved pin and what's installed.

    Reads the engine-produced ``cache/constraints.txt`` (populated by
    ``uv pip compile``) and compares its pin for ``package`` against the
    version currently importable via ``importlib.metadata``. When they
    diverge, the engine *would* install a different version on a fresh
    bootstrap — a silent change that the per-symbol verifiers wouldn't
    notice today but would surface as breakage tomorrow.

    Args:
        package: Top-level package name. Normalised to PEP 503 canonical form
                 before lookup so import-style names (``langchain_core``) match
                 distribution-style constraint keys (``langchain-core``).

    Returns:
        :class:`CheckResult`:
          * ``ok=True, message="not in constraints (...)"`` — package isn't
            pinned in constraints (transitive-only or absent). Nothing to
            check; informational.
          * ``ok=True, message="not installed in current env"`` —
            ``importlib.metadata`` doesn't know about the package. Caller
            should treat this the same as a missing-package skip.
          * ``ok=True, message="installed X matches pin"`` — no drift.
          * ``ok=False, message="installed X but constraints pin Y -- ..."``
            — drift detected; lane fails.
    """
    pinned = read_constraints().get(normalize_dist_name(package))
    if pinned is None:
        return CheckResult(
            ok=True,
            message=f'{package} not in constraints (transitive-only or absent)',
            where=package,
        )
    installed = installed_version(package)
    if installed is None:
        return CheckResult(
            ok=True,
            message=f'{package} not installed in current env',
            where=package,
        )
    if installed != pinned:
        return CheckResult(
            ok=False,
            message=(
                f'installed {installed} but constraints pin {pinned} -- '
                f'engine would install {pinned} on a fresh bootstrap'
            ),
            where=package,
        )
    return CheckResult(ok=True, message=f'installed {installed} matches pin', where=package)


# --------------------------------------------------------------------------- #
# Internals
# --------------------------------------------------------------------------- #


# Heavy-class construction eval()s its expression with builtins locked to this
# whitelist of pure data constructors — blocks open/__import__/exec/eval/etc.
# while still allowing the dummy generator's `set()` output and plain literal
# constructors a hand-written manifest `construct` might use.
_EVAL_BUILTINS = {
    'set': set,
    'frozenset': frozenset,
    'dict': dict,
    'list': list,
    'tuple': tuple,
    'bytes': bytes,
    'bytearray': bytearray,
    'str': str,
    'int': int,
    'float': float,
    'bool': bool,
}


class _ConstructionTimeout(Exception):
    """Raised by ``_eval_with_timeout`` when the timeout fires first."""


def _eval_with_timeout(expr: str, namespace: dict, timeout_sec: float):
    """
    Evaluate a Python expression with a hard wall-clock cap.

    Uses ``signal.setitimer`` on POSIX (precise, low overhead). Falls back
    to a daemon-thread watcher on Windows since ``SIGALRM`` is unavailable
    there; the thread leak window on a timeout is the remainder of the
    process lifetime, which we accept because heavy-class construction
    timeouts indicate manifest bugs that should be fixed anyway.

    Args:
        expr:        Python source-text expression to evaluate.
        namespace:   Globals dict passed to :func:`eval` — should already
                     contain any symbols the expression refers to.
        timeout_sec: Wall-clock cap. After this many seconds, the eval is
                     abandoned and :class:`_ConstructionTimeout` is raised.

    Returns:
        The evaluated value on success.

    Raises:
        _ConstructionTimeout: When the timeout fires first.
        Exception: Whatever the eval'd expression raises (re-raised on the
                   main thread in the Windows path).
    """
    if os.name != 'nt' and hasattr(signal, 'SIGALRM'):

        def _handler(_signum, _frame):
            """``SIGALRM`` handler: trip the timeout sentinel exception."""
            raise _ConstructionTimeout()

        old = signal.signal(signal.SIGALRM, _handler)
        signal.setitimer(signal.ITIMER_REAL, timeout_sec)
        try:
            return eval(expr, namespace)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old)

    # Windows / no SIGALRM: run in a thread and join with timeout.
    result: list = [None]
    exc: list[Optional[BaseException]] = [None]

    def _run():
        """Thread body: eval the expression, capture result or exception."""
        try:
            result[0] = eval(expr, namespace)
        except BaseException as e:  # noqa: BLE001 - re-raised on main thread
            exc[0] = e

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout_sec)
    if t.is_alive():
        # Best-effort: we cannot interrupt the thread, but we report the timeout
        # and let the daemon thread die with the interpreter. The leak window
        # is the remainder of the pytest session.
        raise _ConstructionTimeout()
    if exc[0] is not None:
        raise exc[0]
    return result[0]
