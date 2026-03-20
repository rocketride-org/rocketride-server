# RocketRide vs LangChain Performance Benchmarks

Comparative benchmarks showing the performance advantage of RocketRide's native C++ nodes over pure Python (LangChain) for document processing pipelines.

## Quick Start

```bash
# 1. Build native C++ libraries
cd nodes/src/nodes/preprocessor_native
make

# 2. Install Python dependencies
pip install langchain-text-splitters psutil

# 3. Generate test documents (or use your own)
python benchmarks/generate_docs.py

# 4. Run LangChain baseline
python benchmarks/bench_langchain.py /path/to/documents

# 5. Run RocketRide with native C++ nodes
python benchmarks/bench_rocketride.py /path/to/documents
```

## What's Tested

Both benchmarks perform identical operations on the same files:

1. **File discovery + metadata** — scan directory, stat files, detect text vs binary
2. **Parse + SHA-256 hash** — read files with encoding detection, compute content hash
3. **Text chunking** — split into ~512-char chunks with 50-char overlap
4. **Inverted index** — tokenize all chunks, build full-text search index
5. **Search** — run 100 queries against the index

## Results (Linux Kernel, 91K files, 1.5 GB)

| Stage         | LangChain (Python) | RocketRide (C++) | Speedup       |
| ------------- | ------------------ | ---------------- | ------------- |
| Chunking      | 11.79s             | 0.92s            | **12.8x**     |
| Index build   | 43.53s             | 12.15s           | **3.6x**      |
| Search (100q) | 0.139s             | 0.018s           | **7.8x**      |
| **Total**     | **64.55s**         | **22.05s**       | **2.9x**      |
| Memory peak   | 10,968 MB          | 6,700 MB         | **1.6x less** |

## Architecture

RocketRide replaces the two heaviest Python operations with C++ shared libraries:

- `libnative_chunker` — zero-copy text splitter using offset arrays instead of string allocation
- `libnative_indexer` — inverted index with pre-allocated `std::unordered_map` and sorted posting lists

Both are callable from Python via `ctypes`, requiring no additional dependencies.
