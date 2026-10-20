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
Where node packages come from when nothing else serves them: dist/nodes beside
the server in a build, else the assets of this engine's release, cached under
the engine cache by digest.
"""

import contextlib
import glob
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

from depends import engine_cache_dir
from rocketlib import getVersion

RELEASES = 'https://github.com/rocketride-org/rocketride-server/releases/download'


def _beside(*parts: str) -> str:
    """A path next to the folder the engine runs from."""
    return os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(sys.executable)), os.pardir, *parts))


def _local(file: str) -> str:
    """The file in dist/nodes, next to the server the engine runs from."""
    return _beside('nodes', file)


def _cached(file: str) -> str:
    return os.path.join(engine_cache_dir(create=True), 'nodes', file)


def _tags() -> list:
    """The release the VS Code extension installed this engine from, then the usual tags."""
    installed = []
    for path in glob.glob(_beside('version*.json')):
        with contextlib.suppress(OSError, ValueError, KeyError):
            installed.append(json.loads(_read(path))['tag'])
    version = getVersion()['version']
    return [*installed, f'server-v{version}', f'server-v{version}-prerelease']


def _download(file: str) -> bytes:
    """The release asset, from the first release that has it."""
    tags = _tags()
    for tag in tags:
        try:
            with urllib.request.urlopen(f'{RELEASES}/{tag}/{file}', timeout=15) as response:
                return response.read()
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
    raise FileNotFoundError(f'{file} is not in releases {", ".join(tags)}')


def save(path: str, data: bytes) -> bytes:
    """Write a file whole or not at all: another process may be reading it."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    staging = f'{path}.{os.getpid()}.tmp'
    with open(staging, 'wb') as file:
        file.write(data)
    os.replace(staging, path)
    return data


def _read(path: str) -> bytes:
    with open(path, 'rb') as file:
        return file.read()


def read_index() -> bytes:
    """index.json: the local one, else the release's, else the last one downloaded."""
    if os.path.exists(_local('index.json')):
        return _read(_local('index.json'))
    try:
        return save(_cached('index.json'), _download('index.json'))
    except OSError:
        if os.path.exists(_cached('index.json')):
            return _read(_cached('index.json'))
        raise


def read_package(name: str, sha256: str) -> bytes:
    """<name>.rrnode: the local one, else the cached copy of that digest, else the release's."""
    if os.path.exists(_local(f'{name}.rrnode')):
        return _read(_local(f'{name}.rrnode'))
    cached = _cached(f'{sha256}.rrnode')
    if os.path.exists(cached) and hashlib.sha256(data := _read(cached)).hexdigest() == sha256:
        return data
    data = _download(f'{name}.rrnode')
    if hashlib.sha256(data).hexdigest() != sha256:
        raise ValueError(f'The release asset {name}.rrnode does not match the index')
    return save(cached, data)
