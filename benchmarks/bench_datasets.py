"""Download and cache standard RAG benchmark datasets."""

from __future__ import annotations

import os
import socket
import urllib.request

CACHE_DIR = os.path.join(os.path.dirname(__file__), '.cache')

PAUL_GRAHAM_URL = 'https://raw.githubusercontent.com/run-llama/llama_index/main/docs/examples/data/paul_graham/paul_graham_essay.txt'


def paul_graham_essay() -> list[str]:
    """Return Paul Graham essay as a single-element list of strings.

    Downloads from LlamaIndex GitHub on first call, then caches locally
    in benchmarks/.cache/.
    """
    os.makedirs(CACHE_DIR, exist_ok=True)
    cached = os.path.join(CACHE_DIR, 'paul_graham_essay.txt')

    if not os.path.exists(cached):
        print(f'Downloading Paul Graham essay from {PAUL_GRAHAM_URL} ...')
        prev_timeout = socket.getdefaulttimeout()
        socket.setdefaulttimeout(30)
        try:
            urllib.request.urlretrieve(PAUL_GRAHAM_URL, cached)
        finally:
            socket.setdefaulttimeout(prev_timeout)
        print(f'Cached at {cached}')

    with open(cached, encoding='utf-8') as f:
        text = f.read()

    return [text]
