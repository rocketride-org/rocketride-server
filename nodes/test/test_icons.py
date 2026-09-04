"""Invariants over every node icon and every icon declaration in the tree.

Icons are collected at BUILD time by ``import.meta.webpackContext`` in
``packages/shared-ui/src/components/canvas/util/Icon.tsx`` (:51-53). The map is
keyed on **basename alone** -- ``file.replace(/\\.svg$/i, '')`` at :60, so the
directory is not part of the key -- and a miss falls back to the ``unknown``
icon (:67, :155), which is a chain-link rather than a broken-image glyph.

That fallback is why these defects need a test. A node whose icon declaration is
wrong does not render as broken; it renders as an ordinary-looking connector
node, so nothing reports itself and nobody investigates.

Discovery is reused from ``test_contracts`` rather than reimplemented -- it
already walks every ``service*.json`` and handles the JSONC comments and
trailing commas those files use.

Deliberately not asserted here: that two *different* basenames never hold
identical artwork. ``cloud_tts/elevenlabs.svg`` is currently a byte-for-byte
copy of ``audio_player/audio-player.svg``, and resolving that means sourcing a
vendor mark -- a product decision, tracked separately.
"""

import hashlib
import os
from collections import defaultdict
from xml.etree import ElementTree

from test.test_contracts import NODES_SRC, get_all_services


def _icons():
    """Map each icon basename to {digest: [repo-relative paths]}."""
    found = defaultdict(lambda: defaultdict(list))
    for root, _dirs, files in os.walk(NODES_SRC):
        for name in files:
            if not name.endswith('.svg'):
                continue
            path = os.path.join(root, name)
            with open(path, 'rb') as handle:
                digest = hashlib.md5(handle.read()).hexdigest()
            found[name][digest].append(os.path.relpath(path, NODES_SRC))
    return found


def _declared_services():
    """Every registered service definition, skipping unnamed fragments.

    Fragments under ``core/`` (``services.common*.json``) carry no ``title``
    and are merged into real definitions rather than registered on their own.
    """
    return [service for service in get_all_services() if service.title]


def test_every_declared_icon_resolves_to_a_file_that_exists():
    """The one class that puts a WRONG glyph in front of a user.

    Resolution is by basename across the whole tree, not per-directory, so a
    node may legitimately name an icon that another node ships.

    Found for real: ``remote/services.client.json`` declared ``remote.svg``,
    which had never existed in the repository's history. Because the ``nosaas``
    capability keeps that node out of every picker, it was only ever seen by
    self-hosted users opening an already-authored pipeline.
    """
    available = set(_icons())
    dangling = [
        f'{os.path.relpath(service.file_path, NODES_SRC)} declares icon {service.raw_data["icon"]!r}'
        for service in _declared_services()
        if service.raw_data.get('icon') and service.raw_data['icon'] not in available
    ]
    assert not dangling, 'these icons resolve to nothing and render the chain-link fallback:\n  ' + '\n  '.join(
        dangling
    )


def test_every_user_facing_service_declares_an_icon():
    """No icon at all renders inconsistently, not blankly.

    ``NodeHeader``, ``CreateNodePanel`` and ``NodeConfigPanel`` guard on
    ``service.icon`` and draw nothing; ``QuickAddPopup`` and
    ``TemplatePickerDialog`` do not guard and fall through to the chain-link. So
    the same node shows blank in one surface and a wrong glyph in another.

    ``internal`` services are exempt: they never reach a picker or a canvas card.
    """
    naked = [
        f'{os.path.relpath(service.file_path, NODES_SRC)} ({service.title})'
        for service in _declared_services()
        if not service.raw_data.get('icon') and 'internal' not in (service.raw_data.get('capabilities') or [])
    ]
    assert not naked, (
        'these user-facing services declare no icon, so they render blank on the node '
        'card and the chain-link in QuickAdd:\n  ' + '\n  '.join(naked)
    )


def test_every_svg_declares_a_viewbox():
    """A missing viewBox crops the glyph AND overflows the node card.

    The overflow pushes the node's title out of view, which reads exactly like
    an unregistered provider and sends you to the pipeline wiring instead of to
    the icon. Cheap to assert, expensive to diagnose.

    Parsed rather than scanned as text: the attribute has to be on the ROOT
    ``<svg>`` element and has to be non-empty. A substring search would pass on
    a ``viewBox`` mentioned in a comment or set on a nested element, and would
    fail on a valid file whose root tag happens to start beyond whatever byte
    window the search used.
    """
    missing = []
    for root, _dirs, files in os.walk(NODES_SRC):
        for name in sorted(files):
            if not name.endswith('.svg'):
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, NODES_SRC)
            try:
                node = ElementTree.parse(path).getroot()
            except ElementTree.ParseError as exc:
                missing.append(f'{rel} (unparseable: {exc})')
                continue
            if not (node.get('viewBox') or '').strip():
                missing.append(rel)

    assert not missing, (
        'these icons declare no viewBox on their root <svg>, so they render cropped '
        f'and overflow the node card, hiding the title: {missing}'
    )


def test_no_icon_basename_maps_to_two_different_files():
    """Sharing a basename is fine; sharing it with different artwork is not.

    Seven text nodes ship an identical ``util-text.svg`` and ``openai.svg``
    appears in five nodes -- whichever copy wins looks the same either way, so
    asserting global uniqueness would fail on all of that and be deleted within
    a week. The narrower invariant is what matters: two nodes shipping different
    artwork under one name means at least one renders a glyph that is not its
    own, chosen by bundler walk order rather than by intent.

    Found for real: ``gmail.svg`` in ``core/`` and ``tool_google_workspace/``
    differed. The difference was a single trailing newline and no glyph was
    actually wrong, which is exactly why a test is the right place for this -- a
    human diff of two near-identical files reaches for "close enough", and the
    next collision will not be a newline.
    """
    conflicts = {name: variants for name, variants in _icons().items() if len(variants) > 1}
    assert not conflicts, '\n'.join(
        [
            'These icon basenames are shipped with DIFFERENT contents by different nodes.',
            "Icons are keyed by basename at build time, so one node renders the other's",
            'artwork, chosen by build order. Either make the copies byte-identical or give',
            'the odd one out a distinct basename and update its services.json "icon" field.',
            '',
        ]
        + [
            f'  {name}:\n'
            + '\n'.join(f'    {digest[:8]}  {", ".join(paths)}' for digest, paths in sorted(variants.items()))
            for name, variants in sorted(conflicts.items())
        ]
    )


def test_shared_basenames_are_still_allowed():
    """The convention this file must not quietly tighten.

    If this ever finds zero shared basenames, the invariant above has been
    turned into global uniqueness -- which is not what the codebase does, and
    would mean someone renamed a lot of intentionally-shared files.
    """
    shared = [name for name, variants in _icons().items() if sum(len(p) for p in variants.values()) > 1]
    assert shared, 'expected intentionally-shared icon basenames (util-text.svg, openai.svg, ...)'
