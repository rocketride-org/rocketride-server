# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""The pipeline store block and the per-pipe packer (plan 9).

A pipeline's store listing is a ROOT block ``store`` inside the ``.pipe``
JSON, beside ``project_id``, ``name``, ``description`` and ``source`` (never
duplicated in the block): tagline, categories, tags, icon, readme, links,
mode and billing, mirroring an app's ``appManifest`` listing fields. Every
pipeline carries the block: the scaffold writes it, and the packer and the
deploy door add the default one to a pipe that has none. ``icon`` is
optional: a pipe without one leaves it unset and each UI shows its own
fallback; a declared icon must be in the pack.

A pipeline publishes PER PIPE, BY REFERENCE: :func:`pack_pipe` takes the
path of one ``.pipe`` and builds the zip the deploy door takes as ``data``
beside the pipeline dict — the pipe at the root under its own basename, the
declared readme and icon, and every file the README references (markdown
images and links, HTML ``<img src>``), laid out relative to the pipe file's
directory. There is no folder rule: two pipes in one folder are two pipes and
may share files. A pipe written without a ``store`` block is packed WITH the
default block (its ``readme`` kept only when README.md sits beside the pipe);
the file on disk is left as it is. The TypeScript twins are
``client/pipe-store.ts`` (the pure rules) and ``app-pack/pipe-bundle.ts``
(the Node packer).
"""

from __future__ import annotations

import io
import json
import os
import re
import zipfile
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import unquote

from ._app_scaffold import PLACEHOLDER_ICON_SVG
from .types.pipeline import BillingPlan, PipeStoreBlock

# ==== Limits ==================================================================

#: Fixed timestamp stamped on every zip entry (the app packer's value): two
#: packs of one pipe hash the same. Restated here rather than imported so the
#: packer never pulls the app packer's gitignore dependency.
ZIP_ENTRY_DATE_TIME = (1980, 1, 1, 0, 0, 0)

#: The icon cap (mirrors the app packer's MAX_ICON_BYTES).
MAX_ICON_BYTES = 256 * 1024

#: The cap on one README-referenced file (mirrors MAX_README_IMAGE_BYTES).
MAX_README_IMAGE_BYTES = 10 * 1024 * 1024

#: The readme cap (a store page, not a book).
MAX_PIPE_README_BYTES = 1024 * 1024

# ==== Store block =============================================================

#: The eight keys a ``store`` block may carry, in the scaffold's order.
STORE_KEYS = ('tagline', 'categories', 'tags', 'icon', 'readme', 'links', 'mode', 'billing', 'version')

#: The pipeline's own version, as an app's is in package.json: major.minor.patch
#: with an optional pre-release tag.
STORE_VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?')

#: The monetization modes, the app model.
STORE_MODES = ('free', 'subscription', 'paywall')

#: The app scaffold's placeholder icon, for a pipeline that wants one. The
#: pipeline scaffold writes no icon file and the default block names none.
PIPE_ICON_SVG = PLACEHOLDER_ICON_SVG

#: Pipe id grammar: one dot-free address segment (the developer id is attached at deploy).
_PIPE_ID_RE = re.compile(r'^[A-Za-z0-9_-]+$')

#: A markdown image or link: ``![alt](path)`` / ``[text](path)``, optional
#: title. The destination is angle-delimited (``<a b.png>``, spaces allowed;
#: group 1) or bare (group 2), where it may hold one level of balanced
#: parentheses (``plot(1).png``), as CommonMark allows.
_MARKDOWN_REF_RE = re.compile(
    r'!?\[[^\]]*\]\(\s*(?:<([^<>\n]*)>|((?:[^\s()<>]|\([^\s()]*\))+))(?:\s+["\'][^"\']*["\'])?\s*\)'
)

#: A markdown reference definition: ``[label]: path`` at the start of a line,
#: the destination of a reference-style image or link (``![alt][label]``);
#: angle-delimited (group 1, spaces allowed) or bare (group 2).
_MARKDOWN_DEF_RE = re.compile(r'^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:<([^<>\n]*)>|([^\s<>]+))', re.MULTILINE)

#: An HTML ``<img>`` tag (the tag name case-insensitive); group 1 = its attribute text.
_HTML_IMG_RE = re.compile(r'<img\b([^>]*)>', re.IGNORECASE)

#: One attribute token in a tag's attribute text: the name, then optionally
#: ``=`` and a double-quoted, single-quoted or bare value (the Assets pane's
#: rule, mirrored: a ``src=`` inside another attribute's VALUE is never a
#: token of its own).
_ATTRIBUTE_RE = re.compile(r'([^\s"\'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s"\'=<>`]+)))?')

#: Fenced code blocks (backtick or tilde fences) and inline code spans — never references.
_CODE_RE = re.compile(r'(```|~~~).*?\1|`[^`\n]*`', re.DOTALL)

#: A URL scheme prefix (``http:``, ``data:``, ``mailto:`` ...).
_SCHEME_RE = re.compile(r'^[A-Za-z][A-Za-z0-9+.-]*:')


def default_store_block() -> PipeStoreBlock:
    """The block a new pipeline is stamped with — a fresh dict each call.

    It names no icon: a pipeline without one leaves ``icon`` unset.

    Returns:
        The scaffold's default store block.
    """
    return {
        'version': '1.0.0',
        'tagline': '',
        'categories': ['pipeline'],
        'tags': [],
        'readme': './README.md',
        'links': {},
        'mode': 'free',
        'billing': {'plans': []},
    }


def pipe_readme_stub(display_name: str) -> str:
    """The scaffolded starter README of a pipeline — the app scaffold's twin.

    Args:
        display_name: The pipeline's display name.

    Returns:
        The README.md file content.
    """
    return (
        f'# {display_name}\n\n'
        f'{display_name} — a RocketRide pipeline.\n\n'
        '## What it does\n\n'
        'Describe your pipeline here — this README ships with the pipeline and appears on its store listing.\n'
    )


# ==== Paths (posix, pure) =====================================================


def normalize_posix_path(rel: str) -> str:
    """Normalise a posix path: separators unified, ``.`` dropped, ``..`` folded.

    A ``..`` with nothing to fold stays, so the caller can see an escape
    (``../x`` stays ``../x``).

    Args:
        rel: The path, either separator.

    Returns:
        The normalised posix path ('' for an empty one).
    """
    out: List[str] = []
    for segment in rel.replace('\\', '/').split('/'):
        if segment in ('', '.'):
            continue
        if segment == '..' and out and out[-1] != '..':
            out.pop()
        else:
            out.append(segment)
    return '/'.join(out)


def _posix_dirname(rel: str) -> str:
    """The posix directory of a path ('' for a bare file name)."""
    normalised = rel.replace('\\', '/')
    slash = normalised.rfind('/')
    return '' if slash < 0 else normalised[:slash]


def _check_relative_path(key: str, value: Any) -> str:
    """Check a declared icon/readme path by SPELLING, the server door's rule.

    Relative, and no ``..`` segment at all — not even one that would fold
    inside the tree (``a/../icon.svg``): the server refuses the declaration
    as written, so the client refuses it first. Containment on the real
    file system is the packer's check.

    Args:
        key: The block key, for the error.
        value: The declared value.

    Returns:
        The value, surrounding whitespace stripped (as the server reads it).

    Raises:
        ValueError: The path is not relative-and-inside, naming the key.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'store.{key} must be a non-empty relative path')
    value = value.strip()
    posix = value.replace('\\', '/')
    if posix.startswith('/') or re.match(r'^[A-Za-z]:', posix):
        raise ValueError(f'store.{key} must be a path relative to the pipe file, not "{value}"')
    if '..' in posix.split('/'):
        raise ValueError(f'store.{key} must stay inside the pipe file\'s directory, not "{value}"')
    return value


# ==== Billing =================================================================


def _normalize_amount_cents(value: Any) -> int | float:
    """Coerce a plan price to cents; missing = 0, anything non-numeric is an error."""
    if value is None:
        return 0
    if isinstance(value, bool):
        raise ValueError(f'Invalid billing plan amountCents: {json.dumps(value)}')
    if isinstance(value, (int, float)):
        cents: int | float = value
    elif isinstance(value, str) and value.strip():
        try:
            cents = float(value)
        except ValueError:
            cents = float('nan')
    else:
        cents = float('nan')
    if cents != cents or cents in (float('inf'), float('-inf')):
        raise ValueError(f'Invalid billing plan amountCents: {json.dumps(value)}')
    return int(cents) if float(cents).is_integer() else cents


def normalize_billing_plan(raw: Any) -> BillingPlan:
    """Project one raw plan into the typed shape, every other key carried verbatim.

    Args:
        raw: One entry of ``billing.plans``, straight from JSON.

    Returns:
        The typed plan.

    Raises:
        ValueError: A price that is not a number.
    """
    source = raw if isinstance(raw, dict) else {}
    # step: metadata never rides the verbatim spread — a non-dict value would
    # violate the plan shape; it re-enters only validated
    rest = {key: value for key, value in source.items() if key != 'metadata'}
    plan: Dict[str, Any] = {
        **rest,
        'nickname': source['nickname'] if isinstance(source.get('nickname'), str) else '',
        'amountCents': _normalize_amount_cents(source.get('amountCents')),
        'currency': source['currency'] if isinstance(source.get('currency'), str) else 'usd',
        'interval': source['interval'] if isinstance(source.get('interval'), str) else 'month',
    }
    if isinstance(source.get('metadata'), dict):
        plan['metadata'] = source['metadata']
    return plan  # type: ignore[return-value]


# ==== Validation ==============================================================


def validate_store_block(store: Any) -> PipeStoreBlock:
    """Check a ``store`` block and return it typed, plans normalised.

    Args:
        store: The block as read from the ``.pipe`` JSON.

    Returns:
        The validated block.

    Raises:
        ValueError: Naming the offending key or value: not an object, an
            unknown key, a non-string tagline, a non-string-list
            categories/tags, a bad icon/readme path, non-string links, an
            unknown mode, or malformed billing.
    """
    if not isinstance(store, dict):
        raise ValueError('store must be a JSON object')
    # step: the key set is closed — a typo never rides silently
    for key in store:
        if key not in STORE_KEYS:
            raise ValueError(f'store: unknown key "{key}" (allowed: {", ".join(STORE_KEYS)})')
    out: Dict[str, Any] = {}
    if 'tagline' in store:
        if not isinstance(store['tagline'], str):
            raise ValueError('store.tagline must be a string')
        out['tagline'] = store['tagline']
    if 'version' in store:
        if not isinstance(store['version'], str) or not STORE_VERSION.fullmatch(store['version']):
            raise ValueError('store.version must be a version such as 1.0.0 (major.minor.patch)')
        out['version'] = store['version']
    for key in ('categories', 'tags'):
        if key not in store:
            continue
        items = store[key]
        if not isinstance(items, list) or any(not isinstance(item, str) for item in items):
            raise ValueError(f'store.{key} must be a list of strings')
        out[key] = list(items)
    if 'icon' in store:
        out['icon'] = _check_relative_path('icon', store['icon'])
    if 'readme' in store:
        out['readme'] = _check_relative_path('readme', store['readme'])
    if 'links' in store:
        links = store['links']
        if not isinstance(links, dict) or any(not isinstance(url, str) for url in links.values()):
            raise ValueError('store.links must map labels to URL strings')
        out['links'] = dict(links)
    if 'mode' in store:
        if store['mode'] not in STORE_MODES:
            raise ValueError(f'store.mode must be {", ".join(STORE_MODES)}, not {json.dumps(store["mode"])}')
        out['mode'] = store['mode']
    if 'billing' in store:
        billing = store['billing']
        if not isinstance(billing, dict) or not isinstance(billing.get('plans'), list):
            raise ValueError('store.billing must be { plans: [...] }')
        # step: the raw shape is the server door's — an extra billing key or
        # a plan that is not an object is refused here, never normalised away
        unknown = [key for key in billing if key != 'plans']
        if unknown:
            raise ValueError(f'store.billing: unknown key "{unknown[0]}" (allowed: plans)')
        if any(not isinstance(plan, dict) for plan in billing['plans']):
            raise ValueError('store.billing.plans must be a list of plan objects')
        out['billing'] = {'plans': [normalize_billing_plan(plan) for plan in billing['plans']]}
    return out  # type: ignore[return-value]


# ==== README references =======================================================


def _is_local_reference(ref: str) -> bool:
    """Whether a reference names a local file: no scheme, not protocol-relative, not an anchor."""
    if ref == '' or ref.startswith('#') or ref.startswith('//'):
        return False
    return _SCHEME_RE.match(ref) is None


# A character reference in an attribute value: numeric, or one of the five
# names every reader of this scanner decodes (the TS SDK and the editor pane
# carry the same table). Terminated by ';' only: HTML5's legacy no-semicolon
# names (``&notes`` -> ``\u00acotes``) are not applied, so a filename keeps its
# ampersand unless it is written as a reference.
_CHARACTER_REFERENCE_RE = re.compile(r'&(#x([0-9a-f]+)|#(\d+)|([a-z]+));', re.IGNORECASE)
_NAMED_CHARACTER_REFERENCES = {'amp': '&', 'quot': '"', 'lt': '<', 'gt': '>', 'apos': "'"}


def _decode_attribute(value: str) -> str:
    """Decode the character references in an HTML attribute value with the
    one table the TS SDK and the editor pane use, so every reader names the
    same file. An unknown or unterminated reference stays as written.

    Args:
        value: The value as written between the quotes.

    Returns:
        The decoded value.
    """

    def _one(match: 're.Match[str]') -> str:
        name = match.group(4)
        if name is not None:
            return _NAMED_CHARACTER_REFERENCES.get(name.lower(), match.group(0))
        code = int(match.group(2), 16) if match.group(2) is not None else int(match.group(3))
        return chr(code) if 0 < code <= 0x10FFFF else match.group(0)

    return _CHARACTER_REFERENCE_RE.sub(_one, value)


def _img_src_of(attrs: str) -> str:
    """The ``src`` an ``<img>`` tag names: its first ``src`` attribute (the one
    the browser keeps when it repeats), read by tokenizing the attributes in order,
    its character references decoded (``a&amp;b.png`` names ``a&b.png``). Markdown
    destinations are not decoded; only HTML attributes carry character references here.

    Args:
        attrs: The tag's attribute text.

    Returns:
        The source as the browser reads it, or '' when the tag has none.
    """
    for match in _ATTRIBUTE_RE.finditer(attrs):
        if match.group(1).lower() == 'src':
            return _decode_attribute(match.group(2) or match.group(3) or match.group(4) or '')
    return ''


def scan_readme_references(markdown: str) -> List[str]:
    """The relative files a README references.

    Markdown images and links (inline, and the ``[label]: path`` definitions
    of reference-style ones) and HTML ``<img src>``, in order of
    appearance, de-duplicated, percent-decoded, with any query string or
    fragment stripped. URLs (``http(s)://``, ``data:``, ``mailto:`` and
    every other scheme), protocol-relative refs and ``#anchors`` are
    skipped, as is anything inside code.

    Args:
        markdown: The README text.

    Returns:
        The references, relative to the README.
    """
    text = _CODE_RE.sub('', markdown)
    found = [(match.start(), match.group(1) or match.group(2) or '') for match in _MARKDOWN_REF_RE.finditer(text)]
    found += [(match.start(), match.group(1) or match.group(2) or '') for match in _MARKDOWN_DEF_RE.finditer(text)]
    found += [(match.start(), _img_src_of(match.group(1))) for match in _HTML_IMG_RE.finditer(text)]
    found.sort(key=lambda item: item[0])
    refs: List[str] = []
    for _, raw in found:
        if not _is_local_reference(raw):
            continue
        # step: a fragment or query never names a file
        ref = unquote(raw.split('#')[0].split('?')[0])
        if ref and ref not in refs:
            refs.append(ref)
    return refs


def pipe_store_files(
    store: Optional[PipeStoreBlock], readme_text: Optional[str], readme_path: Optional[str]
) -> Dict[str, List[str]]:
    """The files a pipeline's store listing names, relative to the PIPE's directory.

    ``declared`` is the readme and icon that are set; ``referenced`` is every
    README reference resolved against the README's own directory. Paths are
    normalised posix; a reference that escapes upward keeps its leading
    ``..`` so the packer can refuse it by name.

    Args:
        store: The validated block (None = no listing).
        readme_text: The README content (None = none read).
        readme_path: The README path relative to the pipe's directory.

    Returns:
        ``{'declared': [...], 'referenced': [...]}``.
    """
    declared: List[str] = []
    if store and store.get('readme'):
        declared.append(normalize_posix_path(store['readme']))
    if store and store.get('icon'):
        declared.append(normalize_posix_path(store['icon']))
    referenced: List[str] = []
    if readme_text is not None and readme_path is not None:
        base = _posix_dirname(normalize_posix_path(readme_path))
        for ref in scan_readme_references(readme_text):
            resolved = normalize_posix_path(f'{base}/{ref}' if base else ref)
            if resolved and resolved not in referenced:
                referenced.append(resolved)
    return {'declared': declared, 'referenced': referenced}


# ==== Types ===================================================================


@dataclass
class PackedPipe:
    """The result of :func:`pack_pipe`."""

    pipeline: Dict[str, Any]
    """The pipeline dict (the packed ``.pipe`` JSON, display ``name`` filled)."""
    store: Optional[PipeStoreBlock]
    """The validated store block, always set: the pipe's own, or the default block the packer added."""
    files: List[str] = field(default_factory=list)
    """Paths packed, relative to the pipe file's directory, in zip order."""
    data: bytes = b''
    """The zip bytes to pass as ``deploy.add(pipeline, kind='pipe', data=...)``."""
    warnings: List[str] = field(default_factory=list)
    """Advisory notes (an undeclared readme)."""


# ==== Reads ===================================================================


def _read_contained(pipe_dir: str, rel: str, cap: int) -> bytes:
    """Read one file of the pipe's tree, refusing a real location outside it.

    ``open()`` follows symlinks: a link inside the tree pointing at a file
    outside it would pack that file, and a ``..`` reference would read a
    sibling's. Every read resolves the real path and requires it under the
    real directory of the pipe. The size is checked BEFORE the read, so an
    oversized file is reported, never loaded.

    Args:
        pipe_dir: The pipe file's directory.
        rel: The path relative to it (posix).
        cap: The role's byte cap (readme, icon, or any referenced file).

    Returns:
        The bytes.

    Raises:
        ValueError: Naming the path when it is missing, not a file, outside,
            or over its cap.
    """
    if rel.split('/')[0] == '..':
        raise ValueError(f"{rel} resolves outside the pipe file's directory")
    root = os.path.realpath(pipe_dir)
    abs_path = os.path.join(pipe_dir, *rel.split('/'))
    if not os.path.exists(abs_path):
        raise ValueError(f'{rel} does not exist beside the pipe')
    real = os.path.realpath(abs_path)
    if os.path.commonpath([root, real]) != root or real == root:
        raise ValueError(f"{rel} resolves outside the pipe file's directory")
    if not os.path.isfile(real):
        raise ValueError(f'{rel} is not a file')
    if os.path.getsize(real) > cap:
        raise ValueError(f'{rel} exceeds {cap} bytes')
    with open(real, 'rb') as handle:
        return handle.read()


# ==== Pack ====================================================================


def _added_store_block(pipe_dir: str) -> PipeStoreBlock:
    """The store block the packer adds to a pipe that has none.

    The default block, its ``readme`` kept only when that file sits beside
    the pipe (nobody declared it, so its absence is not an error). It names
    no icon.

    Args:
        pipe_dir: The pipe file's directory.

    Returns:
        The block to add.
    """
    block = default_store_block()
    if 'readme' in block:
        readme = os.path.join(pipe_dir, *normalize_posix_path(block['readme']).split('/'))
        if not os.path.isfile(readme):
            del block['readme']
    return block


def pack_pipe(pipe_path: str) -> PackedPipe:
    """Pack one pipeline into the deploy zip.

    Entries: the ``.pipe`` at the root under its own basename, then — in
    code-point order — the declared readme and icon and every file the
    README references, each at its path relative to the pipe file's
    directory.

    A pipe with a ``store`` block is packed as its bytes on disk. A pipe
    without one is packed with the default block appended as its last key,
    serialized as UTF-8 JSON with two-space indentation and a trailing
    newline; the returned dict carries the same block, so the dict and the
    zip's ``.pipe`` are one pipeline.

    Args:
        pipe_path: The ``.pipe`` file.

    Returns:
        The pipeline dict, the store block, the zip, and any warnings.

    Raises:
        ValueError: The path is not a ``.pipe``, the JSON is invalid, the
            store block is invalid, a declared or referenced file is missing
            or resolves outside the pipe's directory, or a cap is breached.
    """
    # Step 1: the pipe, parsed (the artifact the server snapshots)
    base = os.path.basename(pipe_path)
    if not base.endswith('.pipe'):
        raise ValueError(f'{pipe_path} is not a .pipe file')
    if not os.path.isfile(pipe_path):
        raise ValueError(f'{pipe_path} does not exist')
    pipe_dir = os.path.dirname(pipe_path) or '.'
    with open(pipe_path, 'rb') as handle:
        pipe_bytes = handle.read()
    try:
        pipe = json.loads(pipe_bytes.decode('utf-8'))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(f'{base} is not valid JSON: {exc}') from exc
    if not isinstance(pipe, dict):
        raise ValueError(f'{base} must hold a JSON object')
    stem = base[: -len('.pipe')]

    # Step 2: the store block — every packed pipe carries one. An authored
    # block rides in the file's own bytes; a pipe without one is packed with
    # the default block appended, so the zip's .pipe and the dict sent beside
    # it are the same pipeline (the display-name fill stays the dict's alone:
    # the server fills the bundle's name before it compares)
    authored = 'store' in pipe
    packed_pipe = pipe if authored else {**pipe, 'store': _added_store_block(pipe_dir)}
    packed_bytes = (
        pipe_bytes if authored else (json.dumps(packed_pipe, indent=2, ensure_ascii=False) + '\n').encode('utf-8')
    )
    store = validate_store_block(packed_pipe['store'])
    pipeline = {**packed_pipe, 'name': str(pipe.get('name') or stem)}
    warnings: List[str] = []
    if not store.get('readme'):
        warnings.append('store.readme is not declared, so the listing has no page')

    # Step 3: the declared files, each under its cap (checked before the read)
    entries: Dict[str, bytes] = {}
    readme_rel = normalize_posix_path(store['readme']) if store.get('readme') else None
    readme_text: Optional[str] = None
    if readme_rel:
        readme = _read_contained(pipe_dir, readme_rel, MAX_PIPE_README_BYTES)
        entries[readme_rel] = readme
        readme_text = readme.decode('utf-8', errors='replace')
    if store.get('icon'):
        icon_rel = normalize_posix_path(store['icon'])
        entries[icon_rel] = _read_contained(pipe_dir, icon_rel, MAX_ICON_BYTES)

    # Step 4: the README's references, resolved against the README and laid
    # out relative to the pipe; an upward escape is refused by name, and so
    # is another .pipe at the root (the door takes exactly one)
    for rel in pipe_store_files(store, readme_text, readme_rel)['referenced']:
        if rel in entries or rel == base:
            continue
        if rel.endswith('.pipe') and '/' not in rel:
            raise ValueError(f'{rel} is another pipeline at the root: a README may not reference a sibling .pipe')
        entries[rel] = _read_contained(pipe_dir, rel, MAX_README_IMAGE_BYTES)

    # Step 5: the zip — pipe first, then code-point order, fixed timestamps:
    # identical bytes on every pack
    buffer = io.BytesIO()
    files: List[str] = []
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:

        def add(rel: str, data: bytes) -> None:
            """One deterministic entry."""
            info = zipfile.ZipInfo(rel, date_time=ZIP_ENTRY_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            zf.writestr(info, data)
            files.append(rel)

        add(base, packed_bytes)
        for rel in sorted(entries):
            add(rel, entries[rel])
    return PackedPipe(pipeline=pipeline, store=store, files=files, data=buffer.getvalue(), warnings=warnings)


# ==== Scaffold ================================================================


def scaffold_pipe(workspace_root: str, pipe_id: str, *, name: Optional[str] = None, dir: str = 'pipelines') -> dict:
    """Scaffold a new pipeline — the ONE scaffold behind ``rocketride pipe new``
    and ``client.deploy.create_pipe()``.

    Writes ``<dir>/<pipe_id>/<pipe_id>.pipe`` with the default ``store``
    block, a ``README.md`` stub, and an empty ``assets/`` directory. No icon
    file is written: the default block names none.

    Args:
        workspace_root: The workspace folder that owns ``<dir>``.
        pipe_id: The pipeline id: one dot-free segment of letters, digits,
            ``_`` or ``-`` (the deploying organization's developer id is
            attached at deploy, never written into the file).
        name: Display name (default: the id).
        dir: The pipelines directory, relative to the workspace.

    Returns:
        The created pipeline with the TypeScript ``CreatedPipe`` keys:
        ``folder``, ``pipePath`` and ``files`` (workspace-relative POSIX
        paths).

    Raises:
        ValueError: An invalid id, a ``dir`` that resolves outside the
            workspace, or an output file that already exists.
    """
    # step: identity — validate before touching disk
    if not _PIPE_ID_RE.match(pipe_id):
        raise ValueError(f'Pipeline id "{pipe_id}" is invalid — one dot-free segment of letters, digits, _ or -.')
    folder_rel = f'{normalize_posix_path(dir) or "pipelines"}/{pipe_id}'
    folder_abs = os.path.join(os.path.abspath(workspace_root), *folder_rel.split('/'))
    # step: containment — `dir` is workspace-relative by contract; a `..`
    # or a symlink that leaves the workspace is refused before any write
    root_real = os.path.realpath(workspace_root)
    folder_real = os.path.realpath(folder_abs)
    if os.path.commonpath([root_real, folder_real]) != root_real or folder_real == root_real:
        raise ValueError(f'"{folder_rel}" must resolve to a folder inside the workspace.')
    pipe_rel = f'{folder_rel}/{pipe_id}.pipe'

    # step: the files — components first (the layout the editor expects),
    # identity and the listing block after
    display_name = name or pipe_id
    pipe = {
        'components': [],
        'project_id': pipe_id,
        'name': display_name,
        'description': '',
        'store': default_store_block(),
    }
    files = [
        (f'{pipe_id}.pipe', json.dumps(pipe, indent=2) + '\n'),
        ('README.md', pipe_readme_stub(display_name)),
    ]
    # step: every output is checked before the first write, and each is
    # created exclusively — an existing README is never replaced (two pipes
    # may share a folder; a fresh scaffold in an empty one is fine)
    for rel, _ in files:
        if os.path.exists(os.path.join(folder_abs, rel)):
            raise ValueError(f'"{folder_rel}/{rel}" already exists — pick another id or remove the file.')
    os.makedirs(os.path.join(folder_abs, 'assets'), exist_ok=True)
    for rel, content in files:
        with open(os.path.join(folder_abs, rel), 'x', encoding='utf-8', newline='\n') as handle:
            handle.write(content)
    return {'folder': folder_rel, 'pipePath': pipe_rel, 'files': [f'{folder_rel}/{rel}' for rel, _ in files]}
