#pragma once
#include <cstdint>
#include <shared_mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace rr {

struct SearchResult {
    uint32_t chunk_id;
    float score; // BM25 score
};

struct IndexerConfig {
    float k1 = 1.2f;           // BM25 term frequency saturation
    float b = 0.75f;           // BM25 document length normalization
    uint32_t min_token_len = 2;
};

class Indexer {
public:
    explicit Indexer(IndexerConfig config = {});

    void add(uint32_t chunk_id, std::string_view text);
    void add_batch(const std::vector<std::pair<uint32_t, std::string_view>>& chunks);
    std::vector<SearchResult> search(std::string_view query, int32_t top_k = 10) const;
    void reset();

    uint32_t term_count() const;
    uint32_t doc_count() const;
    uint64_t memory_bytes() const;

private:
    struct PostingEntry {
        uint32_t chunk_id;
        uint32_t term_freq;
    };

    IndexerConfig config_;
    mutable std::shared_mutex mutex_;
    std::unordered_map<std::string, std::vector<PostingEntry>> index_;
    std::unordered_map<uint32_t, uint32_t> doc_lengths_;
    uint32_t total_docs_ = 0;
    uint64_t total_tokens_ = 0;

    std::vector<std::string> tokenize(std::string_view text) const;
    float bm25_score(uint32_t tf, uint32_t df, uint32_t doc_len, float avg_dl) const;
};

} // namespace rr
