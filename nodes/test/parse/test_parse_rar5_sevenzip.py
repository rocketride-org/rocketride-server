# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
End-to-end guard for the parse node's RAR5 path through 7-Zip-JBinding.

    webhook -> parse -> response_text

``TikaApi.init()`` treats a 7-Zip-JBinding load failure as non-fatal: it logs a warning,
``ConfigBuilder`` keeps Tika's junrar ``RarParser`` (RAR4 only) and every other format still
parses. A pipeline that sends a PDF therefore passes even when the Java load path
(``SevenZipLoader.load()``) or
``RarSevenZipParser`` is broken. Only a RAR5 archive goes through that path, so this test
builds one (one stored file, no compression, standard library only) and requires its content
in the response.
"""

from __future__ import annotations

import json
import platform
import sys
import uuid
import zlib

import pytest

RAR5_SIGNATURE = b'Rar!\x1a\x07\x01\x00'
MARKER = 'rar5-through-sevenzipjbinding-' + uuid.uuid4().hex


def _vint(n: int) -> bytes:
    """RAR 5.0 variable-length integer: little-endian base 128, high bit continues."""
    out = bytearray()
    while True:
        byte, n = n & 0x7F, n >> 7
        out.append(byte | 0x80 if n else byte)
        if not n:
            return bytes(out)


def _header(htype: int, hflags: int, body: bytes) -> bytes:
    """One RAR 5.0 header: CRC32 | size (vint) | type (vint) | flags (vint) | body."""
    rest = _vint(htype) + _vint(hflags) + body
    sized = _vint(len(rest)) + rest
    return zlib.crc32(sized).to_bytes(4, 'little') + sized


def rar5_stored(name: str, data: bytes) -> bytes:
    """
    Build a one-file RAR 5.0 archive with the file stored uncompressed.

    Args:
        name: File name inside the archive.
        data: File content.

    Returns:
        The archive bytes: signature, main header, file header + data, end header.
    """
    name_bytes = name.encode('utf-8')
    file_body = (
        _vint(0x0004)  # file flags: data CRC32 present
        + _vint(len(data))  # unpacked size
        + _vint(0o100644)  # attributes (Unix mode)
        + zlib.crc32(data).to_bytes(4, 'little')
        + _vint(0)  # compression: version 0, not solid, method 0 (store), 128 KB dictionary
        + _vint(1)  # host OS: Unix
        + _vint(len(name_bytes))
        + name_bytes
    )
    # header flags 0x0002: a data area follows; its size comes right after the flags
    file_header = _header(2, 0x0002, _vint(len(data)) + file_body)
    return RAR5_SIGNATURE + _header(1, 0, _vint(0)) + file_header + data + _header(5, 0, _vint(0))


COMPONENTS = [
    {
        'id': 'webhook_1',
        'provider': 'webhook',
        'config': {'hideForm': True, 'mode': 'Source', 'parameters': {}, 'type': 'webhook'},
    },
    {'id': 'parse_1', 'provider': 'parse', 'config': {}, 'input': [{'lane': 'tags', 'from': 'webhook_1'}]},
    {'id': 'response_1', 'provider': 'response_text', 'config': {}, 'input': [{'lane': 'text', 'from': 'parse_1'}]},
]


def test_rar5_archive_builder_is_well_formed():
    """The helper writes a RAR 5.0 signature and header layout 7-Zip accepts."""
    blob = rar5_stored('hello.txt', b'hello')
    assert blob.startswith(RAR5_SIGNATURE)
    assert b'hello.txt' in blob and blob.endswith(_header(5, 0, _vint(0)))


@pytest.mark.skipif(
    sys.platform == 'darwin' and platform.machine() == 'arm64',
    reason='sevenzipjbinding 16.02-2.01 ships a Mac-x86_64 binding only, so 7-Zip is off on Apple Silicon until #2734',
)
async def test_parse_extracts_text_from_a_rar5_archive(client):
    """
    A RAR5 archive's content must come out of parse: 7-Zip-JBinding loaded and used by Tika.

    Args:
        client: Connected RocketRide client (fixture).
    """
    archive = rar5_stored('note.txt', f'The archive says: {MARKER}\n'.encode('utf-8'))
    pipeline = {'project_id': str(uuid.uuid4()), 'source': 'webhook_1', 'components': COMPONENTS}
    result = await client.use(pipeline=pipeline)
    token = result['token']
    try:
        # parse skips an object whose size is 0; the size travels in objinfo, not in the bytes
        objinfo = {'name': 'probe.rar', 'size': len(archive)}
        pipe = await client.pipe(token, objinfo=objinfo, mime_type='application/x-rar-compressed')
        await pipe.open()
        await pipe.write(archive)
        response = await pipe.close()
    finally:
        await client.terminate(token)
    assert MARKER in json.dumps(response), (
        'the RAR5 content did not reach the response: 7-Zip-JBinding was not loaded (TikaApi.init() '
        "logs 'RAR5 support disabled') or RarSevenZipParser is not wired; response: "
        f'{json.dumps(response)[:600]}'
    )
