# Benchmarks

Performance comparison of RocketRide's C++ pipeline engine against popular alternatives.

## Chunking + Indexing (1,000 docs, 1.6M chars)

| Engine | Time (s) | Tokens/sec | Memory | Speedup |
| :--- | :--- | :--- | :--- | :--- |
| **RocketRide (C++)** | **0.08** | **~100,000** | **50 MB** | **4.9x** |
| LangChain (Python) | 0.39 | ~20,000 | 53 MB | baseline |
| Chonkie (SIMD) | 0.39 | ~20,000 | 13 MB | 1.0x |

> Tested on macOS ARM64. RocketRide uses native C++ chunker + inverted index via ctypes.
> LangChain uses RecursiveCharacterTextSplitter. Chonkie uses SIMD-accelerated TokenChunker.

## E2E Pipeline Latency

| Stage | P50 (ms) | P95 (ms) | P99 (ms) |
| :--- | :--- | :--- | :--- |
| Discover | 1.9 | 2.0 | 2.0 |
| Parse | 19.7 | 49.7 | 52.4 |
| Chunk (C++) | 1.0 | 1.2 | 1.2 |
| Index (C++) | 99.0 | 99.2 | 99.3 |
| Search | 0.02 | 0.05 | 0.05 |
| **E2E Ingest** | **122.8** | **151.8** | **154.4** |
| **E2E Search** | **0.02** | **0.05** | **0.05** |

## Cost per Query

| Configuration | $/query | $/1K queries |
| :--- | :--- | :--- |
| Cloud (OpenAI + Pinecone) | $0.000340 | $0.34 |
| Cloud (OpenAI + GPT-4o) | $0.005346 | $5.35 |
| **Self-hosted (RocketRide)** | **$0.00** | **$0.00** |

## Run Your Own

```bash
pip install -r benchmarks/requirements.txt
python benchmarks/generate_docs.py 1000
python benchmarks/run_comparison.py benchmarks/test_docs
python benchmarks/bench_e2e_latency.py benchmarks/test_docs 5
python benchmarks/bench_cost.py benchmarks/test_docs
```

For standardized datasets:

```bash
pip install datasets
python benchmarks/download_datasets.py
python benchmarks/run_comparison.py benchmarks/datasets/msmarco
```

## Benchmark Suite

| File | What it measures |
| :--- | :--- |
| `bench_langchain.py` | LangChain RecursiveCharacterTextSplitter |
| `bench_chonkie.py` | Chonkie SIMD-accelerated TokenChunker |
| `bench_llamaindex.py` | LlamaIndex SentenceSplitter |
| `bench_haystack.py` | Haystack DocumentSplitter |
| `bench_rocketride.py` | RocketRide native C++ chunker + indexer |
| `bench_e2e_latency.py` | E2E pipeline with P50/P95/P99 latencies |
| `bench_cost.py` | Cost-per-query estimation (cloud vs self-hosted) |
| `bench_parsing.py` | Multi-format document parsing (text/PDF) |
| `run_comparison.py` | Runs all chunking benchmarks + comparison table |
| `generate_docs.py` | Synthetic test document generator |
| `download_datasets.py` | MS MARCO dataset downloader |
