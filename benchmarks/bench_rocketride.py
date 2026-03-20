"""
Benchmark: RocketRide with ALL native C++ nodes.

C++ chunker (11x faster) + C++ inverted index (3.5x faster expected)
vs LangChain pure Python.
"""

import ctypes
import gc
import hashlib
import mimetypes
import os
import sys
import time
from ctypes import c_char_p, c_int32, c_uint32, c_uint64, POINTER

import pathlib
import platform

import psutil

# Resolve relative to this script's location (benchmarks/ -> repo root -> nodes/...)
_SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
NATIVE_DIR = str(_SCRIPT_DIR.parent / "nodes" / "src" / "nodes" / "preprocessor_native")


def get_mem_mb():
    return psutil.Process(os.getpid()).memory_info().rss / 1024 / 1024


# Load native libs (platform-aware extension)
_LIB_EXT = "dylib" if platform.system() == "Darwin" else "so"
_chunker = ctypes.CDLL(os.path.join(NATIVE_DIR, f"libnative_chunker.{_LIB_EXT}"))
_chunker.chunk_text.argtypes = [
    c_char_p,
    c_int32,
    c_int32,
    c_int32,
    POINTER(c_int32),
    c_int32,
]
_chunker.chunk_text.restype = c_int32

_indexer = ctypes.CDLL(os.path.join(NATIVE_DIR, f"libnative_indexer.{_LIB_EXT}"))
_indexer.index_reset.argtypes = []
_indexer.index_reset.restype = None
_indexer.index_add_chunk.argtypes = [c_uint32, c_char_p, c_int32]
_indexer.index_add_chunk.restype = None
_indexer.index_finalize.argtypes = []
_indexer.index_finalize.restype = c_uint32
_indexer.index_term_count.argtypes = []
_indexer.index_term_count.restype = c_uint32
_indexer.index_search.argtypes = [c_char_p, c_int32, POINTER(c_uint32), c_int32]
_indexer.index_search.restype = c_int32
_indexer.index_memory_bytes.argtypes = []
_indexer.index_memory_bytes.restype = c_uint64


def native_chunk_text(text_bytes, chunk_size=512, overlap=50):
    text_len = len(text_bytes)
    max_chunks = (text_len // max(1, chunk_size - overlap)) + 2
    offsets = (c_int32 * (max_chunks * 2))()
    n = _chunker.chunk_text(
        text_bytes, text_len, chunk_size, overlap, offsets, max_chunks
    )
    chunks = []
    for i in range(n):
        start = offsets[i * 2]
        length = offsets[i * 2 + 1]
        chunks.append(text_bytes[start : start + length])
    return chunks


def native_search(query, max_results=1000):
    """Search the native C++ index. Returns match count (IDs allocated but discarded for benchmarking)."""
    q_bytes = query.encode("utf-8")
    out_ids = (c_uint32 * max_results)()
    n = _indexer.index_search(q_bytes, len(q_bytes), out_ids, max_results)
    return n


TEXT_EXTENSIONS = {
    ".c",
    ".h",
    ".py",
    ".rs",
    ".go",
    ".java",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".cpp",
    ".cc",
    ".hpp",
    ".hh",
    ".cxx",
    ".txt",
    ".md",
    ".rst",
    ".csv",
    ".json",
    ".xml",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".cfg",
    ".conf",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".pl",
    ".rb",
    ".lua",
    ".r",
    ".m",
    ".swift",
    ".kt",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".less",
    ".sql",
    ".graphql",
    ".makefile",
    ".cmake",
    ".mk",
    ".s",
    ".S",
    ".asm",
    ".dts",
    ".dtsi",
    ".dtso",
    ".lds",
    ".awk",
    ".sed",
    "",
}
KNOWN_TEXT_NAMES = {
    "Makefile",
    "Kconfig",
    "Kbuild",
    "README",
    "LICENSE",
    "COPYING",
    "MAINTAINERS",
    "CREDITS",
    "TODO",
    "CHANGES",
    "NEWS",
}

SEARCH_QUERIES = [
    "memory allocation",
    "mutex lock",
    "buffer overflow",
    "null pointer dereference",
    "race condition",
    "stack trace",
    "kernel panic",
    "page fault handler",
    "interrupt handler",
    "device driver probe",
]


def run(root_dir):
    mem_start = get_mem_mb()

    print("=" * 70)
    print("  ROCKETRIDE + FULL NATIVE C++ (chunker + indexer)")
    print(f"  Source: {root_dir}")
    print("=" * 70)

    # Stage 1: Discover
    print("\n[1/6] Discovering files + metadata...")
    gc.collect()
    t0 = time.perf_counter()
    entries = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        for fname in filenames:
            fpath = os.path.join(dirpath, fname)
            try:
                stat = os.stat(fpath)
                mime, _ = mimetypes.guess_type(fpath)
                ext = os.path.splitext(fname)[1].lower()
                is_text = (
                    fname in KNOWN_TEXT_NAMES
                    or ext in TEXT_EXTENSIONS
                    or (mime and mime.startswith("text/"))
                )
                if not is_text:
                    continue
                entries.append(
                    {
                        "path": fpath,
                        "size": stat.st_size,
                        "relative": os.path.relpath(fpath, root_dir),
                    }
                )
            except OSError:
                continue
    t_discover = time.perf_counter() - t0
    total_disk_mb = sum(e["size"] for e in entries) / 1024 / 1024
    print(
        f"      {len(entries):,} text files ({total_disk_mb:.0f} MB) in {t_discover:.2f}s"
    )

    # Stage 2: Parse + hash
    print(f"\n[2/6] Parsing {len(entries):,} documents (encoding + SHA-256)...")
    gc.collect()
    t0 = time.perf_counter()
    docs = []
    errors = 0
    for entry in entries:
        try:
            try:
                with open(entry["path"], "rb") as f:
                    raw = f.read()
                text_bytes = raw  # keep as bytes for C++ chunker
                text_str = raw.decode("utf-8", errors="replace")
            except Exception:
                errors += 1
                continue
            if not text_str.strip():
                continue
            content_hash = hashlib.sha256(raw).hexdigest()
            docs.append(
                {
                    "text_bytes": text_bytes,
                    "text_str": text_str,
                    "relative": entry["relative"],
                    "hash": content_hash,
                }
            )
        except Exception:
            errors += 1
    t_parse = time.perf_counter() - t0
    mem_parse = get_mem_mb()
    text_mb = sum(len(d["text_bytes"]) for d in docs) / 1024 / 1024
    print(
        f"      {len(docs):,} docs ({text_mb:.0f} MB), {errors} errors, {t_parse:.2f}s"
    )
    print(f"      {len(docs) / t_parse:,.0f} docs/sec  |  Memory: {mem_parse:.0f} MB")

    # Stage 3: NATIVE C++ CHUNKING
    print("\n[3/6] Chunking with NATIVE C++ (512 chars)...")
    gc.collect()
    t0 = time.perf_counter()
    all_chunk_bytes = []
    for doc in docs:
        chunks = native_chunk_text(doc["text_bytes"], chunk_size=512, overlap=50)
        all_chunk_bytes.extend(chunks)
    t_chunk = time.perf_counter() - t0
    mem_chunk = get_mem_mb()
    print(f"      {len(all_chunk_bytes):,} chunks in {t_chunk:.2f}s")
    print(
        f"      {len(all_chunk_bytes) / t_chunk:,.0f} chunks/sec  |  Memory: {mem_chunk:.0f} MB"
    )

    # Stage 4: NATIVE C++ INDEX
    print("\n[4/6] Building inverted index with NATIVE C++...")
    gc.collect()
    t0 = time.perf_counter()
    _indexer.index_reset()
    for chunk_id, chunk_bytes in enumerate(all_chunk_bytes):
        _indexer.index_add_chunk(chunk_id, chunk_bytes, len(chunk_bytes))
    n_terms = _indexer.index_finalize()
    t_index = time.perf_counter() - t0
    mem_index = get_mem_mb()
    idx_mem_mb = _indexer.index_memory_bytes() / 1024 / 1024
    print(f"      {n_terms:,} terms in {t_index:.2f}s")
    print(
        f"      Index memory: {idx_mem_mb:.0f} MB  |  Process memory: {mem_index:.0f} MB"
    )

    # Stage 5: NATIVE C++ SEARCH
    print("\n[5/6] Search (10 queries) via NATIVE C++...")
    t0 = time.perf_counter()
    for q in SEARCH_QUERIES:
        native_search(q)
    t_search_10 = time.perf_counter() - t0
    print(f"      {10 / t_search_10:.0f} queries/sec")

    print("\n[6/6] Search x100...")
    t0 = time.perf_counter()
    for _ in range(10):
        for q in SEARCH_QUERIES:
            native_search(q)
    t_search_100 = time.perf_counter() - t0
    print(
        f"      100 queries in {t_search_100:.4f}s  ({100 / t_search_100:.0f} queries/sec)"
    )

    mem_final = get_mem_mb()
    t_total = t_discover + t_parse + t_chunk + t_index

    print(f"\n{'=' * 70}")
    print("  RESULTS")
    print(f"{'=' * 70}")
    print(f"  Files:          {len(entries):>10,}")
    print(f"  Docs parsed:    {len(docs):>10,}")
    print(f"  Chunks:         {len(all_chunk_bytes):>10,}")
    print(f"  Index terms:    {n_terms:>10,}")
    print(f"  Data (text):    {text_mb:>10.0f} MB")
    print(f"  {'-' * 45}")
    print(f"  Discover+meta:  {t_discover:>10.2f}s")
    print(f"  Parse+hash:     {t_parse:>10.2f}s")
    print(f"  Chunk (C++):    {t_chunk:>10.2f}s")
    print(f"  Index (C++):    {t_index:>10.2f}s")
    print(f"  Search (100q):  {t_search_100:>10.4f}s")
    print(f"  {'-' * 45}")
    print(f"  TOTAL (pipeline):{t_total:>9.2f}s")
    print(f"  Throughput:     {text_mb / t_total:>10.1f} MB/sec")
    print(f"  Memory peak:    {mem_index:>10.0f} MB")
    print(f"  Index C++ mem:  {idx_mem_mb:>10.0f} MB")
    print(f"  Mem delta:      {mem_final - mem_start:>+10.0f} MB")
    print()


if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else "/tmp/linux-kernel"
    if not os.path.isdir(root):
        print(f"ERROR: {root} not found")
        sys.exit(1)
    run(root)
