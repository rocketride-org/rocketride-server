"""
Manifest schema for per-component contract overrides.

A component author can drop an ``external_contracts.py`` into the component
directory to override or extend the AST-extracted contract. The file must
define a module-level ``MANIFEST`` of type :class:`ComponentManifest`.

Every entry can carry an optional ``applies_when`` PEP 440 version
specifier (e.g., ``"<2.0"``, ``">=1.0,<2.0"``) that gates the check on the
installed version of the entry's top-level package. When the spec doesn't
match the installed version, the dispatch loop emits a ``[SKIP]`` row and
moves on. When ``applies_when`` is omitted (the default), the entry is
checked unconditionally — fully backward-compatible with manifests written
before this field existed.
"""

from __future__ import annotations

import importlib.util
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# --------------------------------------------------------------------------- #
# Validation helper
# --------------------------------------------------------------------------- #


def _validate_applies_when(value: Optional[str], owner: str) -> None:
    """
    Fail loudly at manifest-load time on malformed ``applies_when`` strings.

    A typo like ``applies_when='<= 2.0 '`` (extra whitespace, trailing junk)
    should not silently be treated as "always applies" — that would erase
    the maintainer's intent. We try to parse the spec via ``packaging`` and
    re-raise with a clear error pointing at the owning entry.

    Args:
        value: The string the manifest author supplied (or ``None``).
        owner: Human-readable label for the entry that owns this field,
               used to make the error message locate-able.

    Raises:
        ValueError: When ``value`` is non-empty but not a valid PEP 440
                    specifier.
    """
    if value is None:
        return
    if not value.strip():
        raise ValueError(f'{owner}: applies_when must be None or a non-empty PEP 440 spec; got {value!r}')
    try:
        from packaging.specifiers import SpecifierSet  # local import: keep optional
    except ImportError:
        # If packaging isn't available at manifest load, we can't validate.
        # The dispatch loop surfaces a clear error when it tries to use it.
        return
    try:
        SpecifierSet(value)
    except Exception as e:
        raise ValueError(
            f'{owner}: malformed applies_when={value!r} (must be a PEP 440 specifier like "<2.0" or ">=1.0,<2.0"): {e}'
        )


# --------------------------------------------------------------------------- #
# Manifest dataclasses
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ImportRequirement:
    """
    A single ``from <module> import <symbol>, ...`` requirement.

    Attributes:
        module:       Dotted module path (e.g., ``"img2table.ocr._types"``).
        symbols:      Tuple of symbol names imported from ``module``. Empty
                      tuple for bare ``import <module>`` form.
        applies_when: Optional PEP 440 specifier (e.g., ``"<2.0"``). When
                      set, the check only runs if the installed version of
                      the top-level package (inferred from ``module``)
                      matches the spec; otherwise dispatch emits ``[SKIP]``.
                      ``None`` (default) means "always applies".
    """

    module: str
    symbols: tuple[str, ...] = ()
    applies_when: Optional[str] = None

    def __post_init__(self) -> None:
        """Validate ``applies_when`` at construction time."""
        _validate_applies_when(
            self.applies_when,
            owner=f'ImportRequirement(module={self.module!r})',
        )


@dataclass(frozen=True)
class AnyOf:
    """
    A group of :class:`ImportRequirement` alternatives — at least one must
    resolve.

    Used to express non-version-based fallbacks (e.g., ``cryptography`` OR
    ``pycryptodome``). For pure version splits, prefer individual
    :class:`ImportRequirement` entries each carrying ``applies_when`` —
    they express the intent more directly than ``AnyOf`` and don't depend
    on a try/except shim in the consuming code.

    Attributes:
        alternatives: Tuple of ``ImportRequirement`` alternatives.
        applies_when: Optional PEP 440 specifier. Package inferred from the
                      first alternative's ``module``. ``None`` means
                      "always applies".
    """

    alternatives: tuple[ImportRequirement, ...]
    applies_when: Optional[str] = None

    def __post_init__(self) -> None:
        """Validate ``applies_when`` at construction time."""
        first = self.alternatives[0].module if self.alternatives else '?'
        _validate_applies_when(self.applies_when, owner=f'AnyOf(first={first!r})')


@dataclass(frozen=True)
class HeavyClass:
    """
    A class whose attributes are populated dynamically in ``__init__`` (common
    SDK-client pattern). The framework constructs an instance using
    ``construct`` and walks each ``attr_chain`` via repeated ``getattr``.

    ``construct`` must be side-effect-free; if your SDK cannot be constructed
    without I/O, omit the heavy-class entry and accept class-only coverage
    for that symbol.

    Attributes:
        qualname:     Dotted name of the class (e.g., ``twelvelabs.TwelveLabs``).
        construct:    Python expression to eval in a namespace with the class
                      symbol injected (e.g., ``'TwelveLabs(api_key="x")'``).
        attr_chains:  Dotted attribute chains to walk on the constructed
                      instance (e.g., ``'indexes.create'``).
        source:       Optional ``"<file>:<line>"`` marker, set automatically for
                      auto-extracted heavy classes. Manual manifest entries
                      leave this empty.
        applies_when: Optional PEP 440 specifier. Package inferred from the
                      top-level of ``qualname``. ``None`` means
                      "always applies".
    """

    qualname: str
    construct: str
    attr_chains: tuple[str, ...]
    source: str = ''
    applies_when: Optional[str] = None

    def __post_init__(self) -> None:
        """Validate ``applies_when`` at construction time."""
        _validate_applies_when(
            self.applies_when,
            owner=f'HeavyClass(qualname={self.qualname!r})',
        )


@dataclass(frozen=True)
class ComponentManifest:
    """
    Per-component overlay on top of the AST-extracted contract.

    Every field is optional; missing fields fall back to the auto-extracted
    contract. Manifest entries replace auto-extracted entries that target
    the same module + symbol set (for imports) or the same qualname (for
    heavy classes) — see ``extractor._apply_manifest``.

    Attributes:
        imports:        Required imports. Replace-on-match against
                        auto-extracted entries.
        any_of_imports: Version-fallback groups; each requires at least one
                        alternative to resolve.
        heavy_classes:  SDK-client contracts to construct + walk.
                        Replace-on-match against auto-extracted entries
                        with the same ``qualname``.
        skip_packages:  Top-level package names to drop from the contract
                        entirely (auto-extracted + manifest).
    """

    imports: tuple[ImportRequirement, ...] = ()
    any_of_imports: tuple[AnyOf, ...] = ()
    heavy_classes: tuple[HeavyClass, ...] = ()
    skip_packages: frozenset[str] = field(default_factory=frozenset)


# --------------------------------------------------------------------------- #
# Manifest loader
# --------------------------------------------------------------------------- #


def load_manifest(component_dir: Path) -> Optional[ComponentManifest]:
    """
    Load ``<component_dir>/external_contracts.py`` if present.

    Imported via ``spec_from_file_location`` so loading is hermetic — no
    ``sys.modules`` pollution, no dependency on the engine's import path.

    Args:
        component_dir: Component directory to inspect.

    Returns:
        The module-level ``MANIFEST`` object if the file exists and exposes
        one; ``None`` otherwise.
    """
    manifest_path = component_dir / 'external_contracts.py'
    if not manifest_path.exists():
        return None

    spec = importlib.util.spec_from_file_location(f'_contract_checks_manifest_{component_dir.name}', manifest_path)
    if spec is None or spec.loader is None:
        return None

    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    manifest = getattr(mod, 'MANIFEST', None)
    if not isinstance(manifest, ComponentManifest):
        return None
    return manifest
