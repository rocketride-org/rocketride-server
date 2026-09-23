"""Invariants over every node icon and every icon declaration in the tree.

Icons are resolved SERVER-SIDE, per directory. The engine reads each
``services*.json`` and resolves its ``"icon"`` field relative to **that file's
own directory** -- ``(path / iconName).resolve()`` in
``packages/server/engine-lib/engLib/store/services/services.cpp`` (:1686-1691),
where ``path`` is the directory the service file was loaded from. A reference
that does not resolve there logs ``Icon : **** MISSING ****`` and the node
reaches the client with no icon content, whatever other node happens to ship a
file of the same name. The client registry
(``registerServiceIcons`` in ``apps/shared/src/components/canvas/util/Icon.tsx``
:154) is built from that response, and a miss falls back to the ``unknown``
icon, which is a chain-link rather than a broken-image glyph.

That fallback is why these defects need a test. A node whose icon declaration is
wrong does not render as broken; it renders as an ordinary-looking connector
node, so nothing reports itself and nobody investigates.

Discovery is reused from ``test_contracts`` rather than reimplemented -- it
already walks every ``service*.json`` and handles the JSONC comments and
trailing commas those files use.

Deliberately NOT asserted here. Both belong to ``scripts/audit-icons.mjs``,
which already covers them at the severity the icon co-location refactor chose,
and a second copy of either rule in pytest could only drift from it:

* Two nodes shipping the same basename with DIFFERENT artwork. Legal since
  co-location -- each icon resolves inside its own directory and the services
  summary de-duplicates by content, so ``core/onedrive.svg`` differing from
  ``tool_microsoft_365/onedrive.svg`` is not a defect. Rule 4 of the audit
  reports it as a warning: "we duplicate by design".
* Two DIFFERENT basenames holding identical artwork.
  ``cloud_tts/elevenlabs.svg`` is currently a byte-for-byte copy of
  ``audio_player/audio-player.svg``, and resolving that means sourcing a vendor
  mark -- a product decision, tracked separately.
"""

import os
from xml.etree import ElementTree

from test.test_contracts import NODES_SRC, get_all_services


def _declared_services():
    """Every registered service definition, skipping unnamed fragments.

    Fragments under ``core/`` (``services.common*.json``) carry no ``title``
    and are merged into real definitions rather than registered on their own.
    """
    return [service for service in get_all_services() if service.title]


def test_every_declared_icon_resolves_to_a_file_in_its_own_directory():
    """The one class that puts a WRONG glyph in front of a user.

    Resolution is per-directory: the engine looks for the icon next to the
    ``services*.json`` that declares it and nowhere else. A file of the same
    name under some other node is NOT a match, so this must not be checked
    against a tree-wide set of basenames -- doing so silently passes a
    declaration the engine goes on to log as MISSING, which is precisely the
    defect below.

    Found for real: ``remote/services.client.json`` declared ``remote.svg``,
    which had never existed in the repository's history. Because the ``nosaas``
    capability keeps that node out of every picker, it was only ever seen by
    self-hosted users opening an already-authored pipeline.
    """
    dangling = []
    for service in _declared_services():
        icon = service.raw_data.get('icon')
        if not icon:
            continue
        if not os.path.isfile(os.path.join(os.path.dirname(service.file_path), icon)):
            dangling.append(f'{os.path.relpath(service.file_path, NODES_SRC)} declares icon {icon!r}')

    assert not dangling, (
        'these icons do not resolve next to the service file that declares them, so the '
        'engine logs them MISSING and the node renders the chain-link fallback:\n  ' + '\n  '.join(dangling)
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
