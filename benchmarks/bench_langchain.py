"""
FAIR Benchmark v2: LangChain with SAME work as RocketRide pipeline.

RocketRide engine does: scan → metadata → parse → chunk → index → monitor
So LangChain must do the same:
1. File discovery with metadata extraction (size, mtime, mime type)
2. Document parsing with encoding detection & binary filtering
3. Text chunking (RecursiveCharacterTextSplitter, 512)
4. Inverted index building (full-text search index)
5. Search queries against the index
6. Progress monitoring/reporting

Usage:
    python bench_langchain.py /path/to/linux-kernel
"""

import gc
import hashlib
import mimetypes
import os
import re
import sys
import time
from collections import defaultdict

import psutil


def get_mem_mb():
    return psutil.Process(os.getpid()).memory_info().rss / 1024 / 1024


# ---------------------------------------------------------------------------
# Stage 1: File discovery + metadata (like RocketRide filesys source node)
# ---------------------------------------------------------------------------
def discover_with_metadata(root_dir):
    """Scan files and extract metadata — same as RocketRide's filesys provider."""
    entries = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        dirnames[:] = [d for d in dirnames if d != '.git']
        dirnames.sort()
        for fname in filenames:
            fpath = os.path.join(dirpath, fname)
            try:
                stat = os.stat(fpath)
                mime, _ = mimetypes.guess_type(fpath)
                entries.append(
                    {
                        'path': fpath,
                        'name': fname,
                        'size': stat.st_size,
                        'mtime': stat.st_mtime,
                        'mime': mime or 'application/octet-stream',
                        'ext': os.path.splitext(fname)[1].lower(),
                        'relative': os.path.relpath(fpath, root_dir),
                    }
                )
            except OSError:
                continue
    return entries


# ---------------------------------------------------------------------------
# Stage 2: Document parsing with encoding detection (like RocketRide parse node)
# ---------------------------------------------------------------------------
TEXT_EXTENSIONS = {
    '.c',
    '.h',
    '.py',
    '.rs',
    '.go',
    '.java',
    '.js',
    '.ts',
    '.tsx',
    '.jsx',
    '.cpp',
    '.cc',
    '.hpp',
    '.hh',
    '.cxx',
    '.txt',
    '.md',
    '.rst',
    '.csv',
    '.json',
    '.xml',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.cfg',
    '.conf',
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.pl',
    '.rb',
    '.lua',
    '.r',
    '.m',
    '.swift',
    '.kt',
    '.html',
    '.htm',
    '.css',
    '.scss',
    '.less',
    '.sql',
    '.graphql',
    '.makefile',
    '.cmake',
    '.mk',
    '.s',
    '.S',
    '.asm',
    '.dts',
    '.dtsi',
    '.dtso',  # device tree (Linux kernel)
    '.lds',  # linker scripts
    '.awk',
    '.sed',
    '',  # no extension (Makefile, Kconfig, etc.)
}

KNOWN_TEXT_NAMES = {
    'Makefile',
    'Kconfig',
    'Kbuild',
    'README',
    'LICENSE',
    'COPYING',
    'MAINTAINERS',
    'CREDITS',
    'TODO',
    'CHANGES',
    'NEWS',
}


def is_text_file(entry):
    """Determine if file is text (like RocketRide's parse node classification)."""
    if entry['name'] in KNOWN_TEXT_NAMES:
        return True
    if entry['ext'] in TEXT_EXTENSIONS:
        return True
    if entry['mime'] and entry['mime'].startswith('text/'):
        return True
    return False


def parse_document(entry):
    """Parse a file — detect encoding, read text, compute hash (like RocketRide)."""
    fpath = entry['path']
    try:
        # Read raw bytes first for consistent hashing across benchmarks
        with open(fpath, 'rb') as f:
            raw = f.read()

        # Decode to text
        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError:
            text = raw.decode('latin-1')

        if not text.strip():
            return None

        # Hash raw bytes (matches bench_rocketride.py)
        content_hash = hashlib.sha256(raw).hexdigest()

        return {
            'text': text,
            'path': fpath,
            'relative': entry['relative'],
            'size': entry['size'],
            'mime': entry['mime'],
            'hash': content_hash,
            'chars': len(text),
            'lines': text.count('\n'),
        }
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Stage 3: Chunking (same as RocketRide preprocessor_langchain node)
# ---------------------------------------------------------------------------
def chunk_documents(docs, chunk_size=512, chunk_overlap=50):
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    splitter = RecursiveCharacterTextSplitter(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    all_chunks = []
    for doc in docs:
        splits = splitter.split_text(doc['text'])
        for i, s in enumerate(splits):
            all_chunks.append(
                {
                    'text': s,
                    'source': doc['relative'],
                    'chunk_id': i,
                    'doc_hash': doc['hash'],
                }
            )
    return all_chunks


# ---------------------------------------------------------------------------
# Stage 4: Inverted index (like RocketRide's C++ inverted index)
# ---------------------------------------------------------------------------
def build_inverted_index(chunks):
    """Build a full-text inverted index — maps words to chunk IDs."""
    word_pattern = re.compile(r'\w{2,}')
    index = defaultdict(set)
    for chunk_id, chunk in enumerate(chunks):
        words = set(word_pattern.findall(chunk['text'].lower()))
        for word in words:
            index[word].add(chunk_id)
    return dict(index)


def search_index(index, query, chunks, top_k=10):
    """Search the inverted index (like RocketRide's C++ search)."""
    words = re.findall(r'\w{2,}', query.lower())
    if not words:
        return []

    # Intersection of word posting lists
    result_ids = None
    for word in words:
        posting = index.get(word, set())
        if result_ids is None:
            result_ids = posting.copy()
        else:
            result_ids &= posting

    if not result_ids:
        # Fallback to union
        result_ids = set()
        for word in words:
            result_ids |= index.get(word, set())

    # Return top-k
    results = []
    for cid in list(result_ids)[:top_k]:
        results.append(
            {
                'chunk_id': cid,
                'source': chunks[cid]['source'],
                'text': chunks[cid]['text'][:100],
            }
        )
    return results


SEARCH_QUERIES = [
    'memory allocation',
    'mutex lock',
    'buffer overflow',
    'null pointer dereference',
    'race condition',
    'stack trace',
    'kernel panic',
    'page fault handler',
    'interrupt handler',
    'device driver probe',
]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def run(root_dir):
    mem_start = get_mem_mb()

    print('=' * 70)
    print('  FAIR BENCHMARK v2: LangChain + indexing + metadata + search')
    print('  (same work as RocketRide C++ pipeline)')
    print(f'  Source: {root_dir}')
    print('=' * 70)

    # Stage 1: Discover + metadata
    print('\n[1/6] Discovering files + extracting metadata...')
    gc.collect()
    t0 = time.perf_counter()
    entries = discover_with_metadata(root_dir)
    t_discover = time.perf_counter() - t0
    total_disk_mb = sum(e['size'] for e in entries) / 1024 / 1024
    text_entries = [e for e in entries if is_text_file(e)]
    print(f'      {len(entries):,} files ({total_disk_mb:.0f} MB)')
    print(f'      {len(text_entries):,} text files identified')
    print(f'      {t_discover:.2f}s  ({len(entries) / t_discover:,.0f} files/sec)')

    # Stage 2: Parse documents
    print(f'\n[2/6] Parsing {len(text_entries):,} text documents (encoding detection + hashing)...')
    gc.collect()
    t0 = time.perf_counter()
    docs = []
    errors = 0
    for i, entry in enumerate(text_entries):
        doc = parse_document(entry)
        if doc:
            docs.append(doc)
        else:
            errors += 1
        # Progress reporting (like RocketRide monitor)
        if (i + 1) % 20000 == 0:
            elapsed = time.perf_counter() - t0
            rate = (i + 1) / elapsed
            print(f'      ... {i + 1:,}/{len(text_entries):,} ({rate:.0f} docs/sec)')
    t_parse = time.perf_counter() - t0
    mem_parse = get_mem_mb()
    text_mb = sum(d['chars'] for d in docs) / 1024 / 1024
    print(f'      {len(docs):,} docs parsed ({text_mb:.0f} MB text), {errors} errors')
    print(f'      {t_parse:.2f}s  ({len(docs) / t_parse:,.0f} docs/sec)  |  Memory: {mem_parse:.0f} MB')

    # Stage 3: Chunk
    print('\n[3/6] Chunking (RecursiveCharacterTextSplitter, 512)...')
    gc.collect()
    t0 = time.perf_counter()
    chunks = chunk_documents(docs)
    t_chunk = time.perf_counter() - t0
    mem_chunk = get_mem_mb()
    print(f'      {len(chunks):,} chunks in {t_chunk:.2f}s  ({len(chunks) / t_chunk:,.0f} chunks/sec)')
    print(f'      Memory: {mem_chunk:.0f} MB')

    # Stage 4: Build inverted index
    print('\n[4/6] Building inverted index...')
    gc.collect()
    t0 = time.perf_counter()
    index = build_inverted_index(chunks)
    t_index = time.perf_counter() - t0
    mem_index = get_mem_mb()
    print(f'      {len(index):,} unique terms indexed in {t_index:.2f}s')
    print(f'      Memory: {mem_index:.0f} MB')

    # Stage 5: Search (10 queries)
    print(f'\n[5/6] Searching index ({len(SEARCH_QUERIES)} queries)...')
    gc.collect()
    t0 = time.perf_counter()
    for q in SEARCH_QUERIES:
        search_index(index, q, chunks)
    t_search_10 = time.perf_counter() - t0
    print(f'      10 queries in {t_search_10:.4f}s  ({10 / t_search_10:.0f} queries/sec)')

    # Stage 6: Search x100
    print('\n[6/6] Searching x100 (heavy load)...')
    big_queries = SEARCH_QUERIES * 10
    gc.collect()
    t0 = time.perf_counter()
    for q in big_queries:
        search_index(index, q, chunks)
    t_search_100 = time.perf_counter() - t0
    print(f'      100 queries in {t_search_100:.4f}s  ({100 / t_search_100:.0f} queries/sec)')

    mem_final = get_mem_mb()
    t_total = t_discover + t_parse + t_chunk + t_index
    t_total_with_search = t_total + t_search_100

    # Summary
    print(f'\n{"=" * 70}')
    print('  RESULTS')
    print(f'{"=" * 70}')
    print(f'  Files (total):     {len(entries):>10,}')
    print(f'  Files (text):      {len(text_entries):>10,}')
    print(f'  Docs parsed:       {len(docs):>10,}')
    print(f'  Chunks:            {len(chunks):>10,}')
    print(f'  Index terms:       {len(index):>10,}')
    print(f'  Data (disk):       {total_disk_mb:>10.0f} MB')
    print(f'  Data (text):       {text_mb:>10.0f} MB')
    print(f'  {"-" * 45}')
    print(f'  Discover+meta:     {t_discover:>10.2f}s')
    print(f'  Parse+hash:        {t_parse:>10.2f}s')
    print(f'  Chunk:             {t_chunk:>10.2f}s')
    print(f'  Index build:       {t_index:>10.2f}s')
    print(f'  Search (100q):     {t_search_100:>10.4f}s')
    print(f'  {"-" * 45}')
    print(f'  TOTAL (no search): {t_total:>10.2f}s')
    print(f'  TOTAL (w/search):  {t_total_with_search:>10.2f}s')
    print(f'  Throughput:        {text_mb / t_total:>10.1f} MB/sec')
    print(f'  Memory peak:       {mem_index:>10.0f} MB')
    print(f'  Mem delta:         {mem_final - mem_start:>+10.0f} MB')
    print()

    return {
        'tool': 'langchain',
        'total_time': t_total,
        'docs': len(docs),
        'chars': sum(d['chars'] for d in docs),
        'chunks': len(chunks),
        'index_terms': len(index),
        'mem_delta_mb': mem_final - mem_start,
    }


if __name__ == '__main__':
    root = sys.argv[1] if len(sys.argv) > 1 else '/tmp/linux-kernel'
    if not os.path.isdir(root):
        print(f'ERROR: {root} not found')
        sys.exit(1)
    run(root)
