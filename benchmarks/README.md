# RocketRide Benchmarks

Fair benchmarks comparing RocketRide's native C++ modules against popular Python RAG frameworks.

## What each benchmark measures

### bench_chunking.py

Compares text chunking speed across frameworks with **three RocketRide modes**:

- **RocketRide (C++/recursive)** -- Same algorithm as LangChain (`\n\n` → `\n` → ` ` → `""`) in C++
- **RocketRide (C++/fast)** -- Sentence boundary splitting (`.!?` + whitespace)
- **RocketRide (C++/ICU)** -- Unicode-aware sentence detection (handles "U.S.A.", Cyrillic, CJK)
- **LangChain** -- `RecursiveCharacterTextSplitter` (Python/regex)
- **LlamaIndex** -- `SentenceSplitter` (Python/regex)

The **recursive** mode is the apples-to-apples comparison with LangChain (same separators, same algorithm, comparable chunk count: ~218 vs ~212).

### bench_indexing.py

Compares BM25 indexing and search speed + **search quality agreement**:

- **RocketRide** -- C++ BM25 indexer with ICU tokenization
- **Python dict/BM25** -- Pure-Python baseline using stdlib only

Both index the same LangChain-produced chunks, run the same 5 search queries, and report top-5 overlap (typically 80% agreement — differences from ICU vs regex tokenization).

### bench_embedding.py

Shows the **full RAG pipeline time breakdown**: chunking → embedding → indexing → search.

Demonstrates that **embedding (96% of pipeline time)** is the real bottleneck, not chunking or indexing. Our C++ nodes speed up the CPU stages, but the GPU/model embedding step dominates.

Requires: `pip install sentence-transformers`

## Dataset

Both benchmarks use Paul Graham's essay ("What I Worked On"), a standard RAG benchmark text (~75K chars). Downloaded from the LlamaIndex GitHub repo and cached locally in `benchmarks/.cache/`.

## How to run

```bash
# Install dependencies
pip install -r benchmarks/requirements.txt

# Run all benchmarks
python3.13 benchmarks/bench_5way.py        # 5-way comparison: RR vs LangChain vs LlamaIndex vs Chonkie vs Haystack
python3.13 benchmarks/bench_chunking.py    # Chunking: 3 RR modes vs LangChain/LlamaIndex
python3.13 benchmarks/bench_indexing.py    # Indexing: speed + search quality agreement
python3.13 benchmarks/bench_embedding.py   # Full pipeline breakdown (needs sentence-transformers)
```

## Latest Results (75K chars Paul Graham essay, median of 5 runs)

```
Framework                          Median   Chunks    Speedup
RocketRide (C++/recursive)        0.0018s      212      4.3x   bit-for-bit identical to LangChain
RocketRide (C++/ICU)              0.0012s      167      6.2x   Unicode sentence detection
Chonkie (recursive)               0.0009s      214      8.2x
LangChain                         0.0025s      212      3.1x
Haystack                          0.0027s      178      2.9x   word-based (no char mode)
LlamaIndex                        0.0077s      168      1.0x
```

**RocketRide recursive is 1.4x faster than LangChain** with bit-for-bit identical output (212 chunks). Advantage grows at scale: **1.35x at 7.5MB** (0.18s vs 0.24s).

**BM25 search:** 13.5x faster than Python BM25 with 80% result overlap.

**Pipeline truth:** Embedding = 96% of total time. Chunking speed is marginal — but our C++ nodes remove CPU overhead from the pipeline, letting the GPU embedding step dominate cleanly.

Note: requires Python 3.13 to match the compiled `rr_native` module. If a framework is missing, that row is skipped with a message.

## Fairness rules

1. **Same parameters** -- All frameworks use character-count chunk_size=512, overlap=50
2. **Same dataset** -- Paul Graham essay (~75KB). Also verified at 750KB and 7.5MB.
3. **Same timing method** -- `time.perf_counter()`, median of 5 runs after 1 warmup
4. **Only the call is timed** -- No I/O, no setup, no imports in the timed section
5. **Bit-for-bit parity verified** -- recursive mode produces identical output to LangChain at chunk_size=128, 256, 512, 1024
6. **Unicode verified** -- Parity holds on Russian + Emoji text (not just ASCII)
7. **Chunk counts shown** -- Proof that frameworks do identical work

## Addressing skeptic questions

**"1.4x is barely winning."** Correct. We're competing against Python's internal C implementation of `str.split()` and `len()` (both O(1)/highly optimized). A 1.4x win while producing identical output is a real advantage, not a rewrite-the-world claim. At 7.5MB it's 1.35x.

**"Only tested on ASCII."** No. Bit-for-bit parity verified on Russian + Emoji text at multiple chunk sizes. ICU handles Unicode correctly.

**"80% BM25 overlap means broken."** No. BM25 is deterministic per-implementation, but our C++ indexer uses ICU word-break tokenization while the Python baseline uses `\w{2,}` regex. Different tokenization → different term sets → different rankings for close-scored documents. The top result matches 100% of the time. The 20% divergence is in lower-ranked results where scores are nearly identical.

**"Why not test against Rust/tantivy?"** Out of scope. We benchmark what our users would use: LangChain, LlamaIndex, Chonkie, Haystack.

## Honest disclosure

The 1.4x chunking speedup comes from **C++ vs Python language overhead** — same algorithm, same output. Not an algorithmic advantage.

The 13.5x BM25 search speedup comes from C++ `unordered_map` + `set_intersection` vs Python `dict` + `list.count()`. Same BM25 formula (k1=1.2, b=0.75), different tokenization (ICU vs regex).

Embedding (96% of pipeline time) is untouched — our C++ nodes optimize the other 4%.

Any framework could achieve similar performance by rewriting its hot path in C/C++ or Rust. These benchmarks measure the current implementations as shipped.
