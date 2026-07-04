"""
Optional contract overrides for the ocr node.

You almost certainly don't need to touch this file.

----------------------------------------------------------------------
What this file is
----------------------------------------------------------------------
A small declarative manifest read by the ``check-externals`` framework
at ``tools/contract_checks/``. The framework verifies, in CI, that the
``img2table`` package still exposes the symbols this node depends on.
When upstream ships a breaking API change, CI tells us *before* it
ships to a customer.

For everything you'd want to know about the framework — how to read
its output, when to edit a manifest, what `applies_when` does — see:
    tools/contract_checks/README.md

----------------------------------------------------------------------
Why this manifest exists
----------------------------------------------------------------------
``img2table 2.0`` (released 2026-05-10) reorganised the OCR plug-in
API significantly:

* ``OCRInstance`` moved from ``img2table.ocr.base`` to
  ``img2table.ocr._types``.
* The ``content`` / ``to_ocr_dataframe`` contract was replaced by a
  single ``of()`` returning ``OCRData``.
* ``OCRDataframe`` (the v1 result type, in ``img2table.ocr.data``) is
  gone in v2.
* ``OCRData`` (the v2 result type, in ``img2table.ocr._types``) doesn't
  exist in v1.

The OCR node's ``IGlobal.py`` runs different code paths on v1 vs v2,
guarded by an ``_IMG2TABLE_V2`` flag. Both code paths import what they
need lazily inside the method that uses them. From a static-analysis
perspective each import looks unconditional, so the framework would
flag the unreachable v1 imports on a v2 install (and vice-versa).

This manifest expresses the version split directly: each version-only
import declares ``applies_when='<2.0'`` or ``applies_when='>=2.0'``.
The framework gates the check on the installed img2table version and
emits ``[SKIP]`` for entries that don't apply.

----------------------------------------------------------------------
When you'd modify this
----------------------------------------------------------------------
* img2table ships v3 with another module reshuffle
  -> add a third version-tagged entry (e.g.,
     ``applies_when='>=3.0'``) and adjust the older ones.
* The OCR node stops supporting img2table v1 entirely
  -> remove all ``applies_when='<2.0'`` entries.
* You add a new img2table import to ``IGlobal.py`` that's available on
  every version we care about
  -> nothing to do; auto-extraction will pick it up unconditionally.

----------------------------------------------------------------------
When you'd delete this entirely
----------------------------------------------------------------------
You can — but then auto-extraction sees the version-gated imports as
unconditional, and CI will go red on whichever img2table version is
installed. Don't delete unless the OCR node is also rewritten to import
only the common subset.
"""

from contract_checks.manifest import ComponentManifest, ImportRequirement

MANIFEST = ComponentManifest(
    imports=(
        # OCRInstance — the base class — lives in different modules on
        # v1 vs v2. Two version-tagged entries replace what would
        # otherwise be an AnyOf, and read more like a changelog.
        ImportRequirement(
            module='img2table.ocr.base',
            symbols=('OCRInstance',),
            applies_when='<2.0',
        ),
        ImportRequirement(
            module='img2table.ocr._types',
            symbols=('OCRInstance',),
            applies_when='>=2.0',
        ),
        # OCRDataframe — v1 result type, used by the legacy
        # `to_ocr_dataframe` code path. Removed in v2.
        ImportRequirement(
            module='img2table.ocr.data',
            symbols=('OCRDataframe',),
            applies_when='<2.0',
        ),
        # OCRData — v2 result type, returned by the new `of()` method.
        # Did not exist in v1.
        ImportRequirement(
            module='img2table.ocr._types',
            symbols=('OCRData',),
            applies_when='>=2.0',
        ),
    ),
)
