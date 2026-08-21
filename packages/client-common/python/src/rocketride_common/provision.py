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

"""
Workspace provisioning operations shared by RocketRide client front-ends:
agent docs bundle install, services catalog sync, stub marker merge,
gitignore entries, and ``/client/*`` artifact vendoring.

Everything here is plain stdlib (fs + urllib + zipfile) — no IDE or
framework APIs. Progress reporting is a caller-supplied callback.

Behavioral twin of ``client-common/typescript``'s ``provision.ts`` —
changes here must be mirrored there.
"""

import io
import json
import os
import re
import urllib.error
import urllib.request
import zipfile
from typing import Any, Callable, Dict, Optional

# Marker protocol delimiting the managed section of agent stub files
MARKER_BEGIN = '<!-- ROCKETRIDE:BEGIN -->'
MARKER_END = '<!-- ROCKETRIDE:END -->'

# Filename shape of installed agent docs — the install sweep's scope
DOC_FILE_PATTERN = re.compile(r'^ROCKETRIDE_.*\.md$')

# Workspace stamp file holding the installed bundle's content hash
DOCS_STAMP_FILE = '.version'

# Gitignore entries every provisioned workspace carries (exact names)
GITIGNORE_ENTRIES = ('.rocketride/', '.env')

# Progress line sink; consumers route it to their own output/logger
ProgressSink = Callable[[str], None]


def to_http_base(uri: str) -> str:
    """
    Normalize a connect URI to an http(s) base URL for /client/* downloads.

    Args:
        uri: The DAP connect URI (ws/wss/http/https).

    Returns:
        The http(s) origin with path noise stripped.
    """
    base = re.sub(r'^ws:', 'http:', uri, flags=re.IGNORECASE)
    base = re.sub(r'^wss:', 'https:', base, flags=re.IGNORECASE)
    base = re.sub(r'/task/service/?$', '', base, flags=re.IGNORECASE)
    return base.rstrip('/')


def write_if_changed(file_path: str, content: bytes) -> bool:
    """
    Write a file only when its content changed. Creates parent dirs.

    Args:
        file_path: Destination path.
        content: New content bytes.

    Returns:
        True when the file was written.
    """
    if os.path.isfile(file_path):
        with open(file_path, 'rb') as f:
            if f.read() == content:
                return False
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    with open(file_path, 'wb') as f:
        f.write(content)
    return True


def fetch_artifact(base: str, route: str, label: str, timeout: float = 60) -> bytes:
    """
    Download one /client/* artifact from the server.

    Args:
        base: The server's http(s) base URL.
        route: Route under the base (e.g. ``client/shell``).
        label: Human label for error messages.
        timeout: Request timeout in seconds.

    Returns:
        The artifact bytes.

    Raises:
        RuntimeError: When the server does not serve the artifact.
    """
    url = f'{base}/{route}'
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as err:
        raise RuntimeError(f'{base} does not serve the {label} (HTTP {err.code})') from err


def install_docs_bundle(workspace_root: str, base: str, on_progress: Optional[ProgressSink] = None) -> bool:
    """
    Install the agent docs bundle into ``<workspace>/.rocketride/docs``
    with the sweep rule.

    Downloads GET /client/docs (docs.zip), compares its manifest hash to
    the workspace stamp, and on change deletes every ``ROCKETRIDE_*`` doc
    before unpacking the new set — renamed/retired docs cannot linger,
    while non-matching files a user added survive. Stubs land under
    ``.rocketride/docs/stubs/``.

    Args:
        workspace_root: Workspace directory.
        base: The server's http(s) base URL.
        on_progress: Progress line sink.

    Returns:
        True when docs were installed or refreshed.
    """
    progress = on_progress or (lambda line: None)
    docs_dir = os.path.join(workspace_root, '.rocketride', 'docs')
    stamp_path = os.path.join(docs_dir, DOCS_STAMP_FILE)

    # step: download and read the bundle manifest
    bundle = fetch_artifact(base, 'client/docs', 'agent docs bundle (docs.zip)')
    archive = zipfile.ZipFile(io.BytesIO(bundle))
    manifest: Dict[str, Any] = {'hash': '', 'files': []}
    if 'manifest.json' in archive.namelist():
        manifest = json.loads(archive.read('manifest.json').decode('utf-8'))
    bundle_hash = str(manifest.get('hash', ''))

    # step: unchanged bundle — stamp matches, nothing to do
    if bundle_hash and os.path.isfile(stamp_path):
        with open(stamp_path, 'r', encoding='utf-8') as f:
            if f.read().strip() == bundle_hash:
                progress('Agent docs already up to date.')
                return False

    # step: sweep — remove every ROCKETRIDE_* doc so renamed/retired docs
    # cannot fossilize; anything else in the directory survives
    if os.path.isdir(docs_dir):
        for file_name in os.listdir(docs_dir):
            if DOC_FILE_PATTERN.match(file_name):
                os.remove(os.path.join(docs_dir, file_name))

    # step: unpack the new set (docs at the root, stubs under stubs/)
    os.makedirs(docs_dir, exist_ok=True)
    for entry_name in archive.namelist():
        normalized = entry_name.replace('\\', '/')
        if normalized.endswith('/') or normalized == 'manifest.json' or '..' in normalized:
            continue
        target = os.path.join(docs_dir, normalized)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'wb') as f:
            f.write(archive.read(entry_name))
    if bundle_hash:
        with open(stamp_path, 'w', encoding='utf-8') as f:
            f.write(bundle_hash + '\n')
    progress(f'Agent docs installed ({len(manifest.get("files", []))} files).')
    return True


def _first_sentence(description: Optional[str]) -> str:
    """
    Extract the first sentence from an HTML description string.

    Strips HTML tags first. The strip loops until idempotent so nested or
    malformed tags like ``<scri<x>pt>`` collapse fully — a single regex
    pass would leave ``<script>`` behind after consuming only the inner
    ``<x>``. Defense-in-depth: the output lands in a JSON catalog file,
    not rendered as HTML, but the consumer surface may grow.

    Args:
        description: Raw (possibly HTML) description.

    Returns:
        The first sentence, tags stripped.
    """
    if not description:
        return ''
    stripped = description
    while True:
        next_pass = re.sub(r'<[^>]*>', '', stripped)
        if next_pass == stripped:
            break
        stripped = next_pass
    text = stripped.strip()
    # Take first sentence (ends with . ! or ?)
    match = re.match(r'^[^.!?]*[.!?]', text)
    return match.group(0).strip() if match else text


def _sanitize_service_name(name: str) -> str:
    """
    Sanitize a service name so it is safe to use as a filename.

    Only ``[a-zA-Z0-9._-]`` characters are kept; everything else is
    replaced with ``_``. Each leading dot is replaced individually to
    preserve name uniqueness.

    Args:
        name: Raw service name from the server.

    Returns:
        Filename-safe name.
    """
    safe = re.sub(r'[^a-zA-Z0-9._-]', '_', name)
    return re.sub(r'^\.+', lambda match: '_' * len(match.group(0)), safe)


def sync_service_catalog(
    workspace_root: str, services: Dict[str, Any], on_progress: Optional[ProgressSink] = None
) -> None:
    """
    Sync the services catalog + per-component schemas into .rocketride/.

    Writes one schema file per component, removes schemas for components
    the server no longer has, and writes the master catalog (name,
    classType, first-sentence description, lanes, optional invoke).

    Args:
        workspace_root: Workspace directory.
        services: The services map from the client's ``get_services()``.
        on_progress: Progress line sink.
    """
    progress = on_progress or (lambda line: None)
    schema_dir = os.path.join(workspace_root, '.rocketride', 'schema')
    os.makedirs(schema_dir, exist_ok=True)

    # step: one schema file per component; track for obsolete cleanup
    expected = set()
    for name, definition in services.items():
        safe_name = _sanitize_service_name(name)
        schema_path = os.path.join(schema_dir, f'{safe_name}.json')
        # Defense-in-depth after sanitization: the resolved path must stay
        # strictly inside the schema directory
        if not os.path.abspath(schema_path).startswith(os.path.abspath(schema_dir) + os.sep):
            progress(f'Skipped schema write for unsafe service name: {name}')
            continue
        expected.add(f'{safe_name}.json')
        write_if_changed(schema_path, json.dumps(definition, indent=2).encode('utf-8'))

    # step: remove schemas for components the server no longer has
    for file_name in os.listdir(schema_dir):
        if file_name not in expected:
            os.remove(os.path.join(schema_dir, file_name))

    # step: the master catalog
    catalog = []
    for name, definition in services.items():
        entry: Dict[str, Any] = {
            'name': name,
            'classType': definition.get('classType', []),
            'description': _first_sentence(definition.get('description')),
            'lanes': definition.get('lanes', {}),
        }
        if definition.get('invoke') is not None:
            entry['invoke'] = definition['invoke']
        catalog.append(entry)
    write_if_changed(
        os.path.join(workspace_root, '.rocketride', 'services-catalog.json'),
        json.dumps(catalog, indent=2).encode('utf-8'),
    )
    progress(f'Service catalog synced ({len(catalog)} components).')


def merge_stub_content(existing: str, stub_content: str) -> str:
    """
    Merge stub content into existing file content using the marker
    protocol: replace between markers when present, else append with a
    separator, else the stub alone.

    Args:
        existing: Current target file content ('' when absent).
        stub_content: The stub template (with or without markers).

    Returns:
        The merged file content.
    """
    has_markers = MARKER_BEGIN in stub_content and MARKER_END in stub_content
    if has_markers:
        begin = stub_content.index(MARKER_BEGIN)
        end = stub_content.index(MARKER_END) + len(MARKER_END)
        block = stub_content[begin:end]
    else:
        block = f'{MARKER_BEGIN}\n{stub_content}\n{MARKER_END}'

    if existing == '':
        return stub_content if has_markers else block + '\n'
    begin_idx = existing.find(MARKER_BEGIN)
    end_idx = existing.find(MARKER_END)
    if begin_idx != -1 and end_idx != -1 and end_idx > begin_idx:
        # Replace the existing marked section
        return existing[:begin_idx] + block + existing[end_idx + len(MARKER_END) :]
    # Append with separator
    return existing.rstrip() + '\n\n' + block + '\n'


def strip_stub_content(content: str) -> str:
    """
    Remove the marked block (markers + content between) from a string.

    Args:
        content: The file content.

    Returns:
        The content without the managed block, whitespace-collapsed.
    """
    begin_idx = content.find(MARKER_BEGIN)
    end_idx = content.find(MARKER_END)
    if begin_idx == -1 or end_idx == -1 or end_idx <= begin_idx:
        return content
    before = content[:begin_idx]
    after = content[end_idx + len(MARKER_END) :]
    return re.sub(r'\n{3,}', '\n\n', before + after).strip()


def install_stub(workspace_root: str, stub_source: str, stub_target: str) -> bool:
    """
    Install one agent stub from the workspace's downloaded docs bundle.

    Reads ``.rocketride/docs/stubs/<stub_source>`` and merges it into
    ``<workspace>/<stub_target>`` via the marker protocol. Line-ending
    normalized change detection avoids dirtying the repo.

    Args:
        workspace_root: Workspace directory.
        stub_source: Stub filename inside the bundle's stubs/ dir.
        stub_target: Target path relative to the workspace root.

    Returns:
        True when the target was created or updated.

    Raises:
        RuntimeError: When the stub is not present in the docs bundle.
    """
    stub_path = os.path.join(workspace_root, '.rocketride', 'docs', 'stubs', stub_source)
    if not os.path.isfile(stub_path):
        raise RuntimeError(
            f'Stub {stub_source} is not present in the docs bundle — connect to a server to sync docs first'
        )
    with open(stub_path, 'r', encoding='utf-8') as f:
        stub_content = f.read()
    target_path = os.path.join(workspace_root, stub_target)
    existing = ''
    if os.path.isfile(target_path):
        with open(target_path, 'r', encoding='utf-8') as f:
            existing = f.read()
    merged = merge_stub_content(existing, stub_content)
    if merged.replace('\r\n', '\n') == existing.replace('\r\n', '\n'):
        return False
    os.makedirs(os.path.dirname(target_path) or '.', exist_ok=True)
    with open(target_path, 'w', encoding='utf-8') as f:
        f.write(merged)
    return True


def ensure_gitignore(workspace_root: str) -> bool:
    """
    Ensure the standard entries are git-ignored (exact-name patterns, so
    a committed ``.env.example`` is unaffected). Creates ``.gitignore``
    when absent; appends only missing entries.

    Args:
        workspace_root: Workspace directory.

    Returns:
        True when ``.gitignore`` was created or updated.
    """
    gitignore_path = os.path.join(workspace_root, '.gitignore')
    existing = ''
    if os.path.isfile(gitignore_path):
        with open(gitignore_path, 'r', encoding='utf-8') as f:
            existing = f.read()
    lines = [line.strip() for line in existing.splitlines()]
    missing = [entry for entry in GITIGNORE_ENTRIES if entry not in lines]
    if not missing:
        return False
    next_content = (existing.rstrip() + '\n' + '\n'.join(missing) + '\n').lstrip('\n')
    with open(gitignore_path, 'w', encoding='utf-8') as f:
        f.write(next_content)
    return True
