#include "indexer.h"

#include <unicode/brkiter.h>
#include <unicode/unistr.h>

#include <algorithm>
#include <cmath>

namespace rr {

Indexer::Indexer(IndexerConfig config) : config_(config) {}

std::vector<std::string> Indexer::tokenize(std::string_view text) const {
    std::vector<std::string> tokens;

    icu::UnicodeString utext =
        icu::UnicodeString::fromUTF8(icu::StringPiece(text.data(), static_cast<int32_t>(text.size())));

    UErrorCode status = U_ZERO_ERROR;
    std::unique_ptr<icu::BreakIterator> iter(
        icu::BreakIterator::createWordInstance(icu::Locale::getDefault(), status));
    if (U_FAILURE(status)) {
        return tokens;
    }

    iter->setText(utext);

    int32_t start = iter->first();
    for (int32_t end = iter->next(); end != icu::BreakIterator::DONE;
         start = end, end = iter->next()) {
        // Skip non-word segments (whitespace, punctuation)
        if (iter->getRuleStatus() == UBRK_WORD_NONE) {
            continue;
        }

        icu::UnicodeString word = utext.tempSubStringBetween(start, end);
        word.foldCase();

        std::string utf8;
        word.toUTF8String(utf8);

        if (word.countChar32() >= static_cast<int32_t>(config_.min_token_len)) {
            tokens.push_back(std::move(utf8));
        }
    }

    return tokens;
}

float Indexer::bm25_score(uint32_t tf, uint32_t df, uint32_t doc_len, float avg_dl) const {
    float N = static_cast<float>(total_docs_);
    float idf = std::log((N - static_cast<float>(df) + 0.5f) / (static_cast<float>(df) + 0.5f) + 1.0f);
    float tf_norm = (static_cast<float>(tf) * (config_.k1 + 1.0f)) /
                    (static_cast<float>(tf) +
                     config_.k1 * (1.0f - config_.b + config_.b * static_cast<float>(doc_len) / avg_dl));
    return idf * tf_norm;
}

void Indexer::add(uint32_t chunk_id, std::string_view text) {
    auto tokens = tokenize(text);

    std::unordered_map<std::string, uint32_t> tf_map;
    for (auto& t : tokens) {
        ++tf_map[t];
    }

    std::unique_lock lock(mutex_);

    if (doc_lengths_.contains(chunk_id)) {
        return; // duplicate chunk_id — silently skip
    }

    doc_lengths_[chunk_id] = static_cast<uint32_t>(tokens.size());
    total_tokens_ += tokens.size();
    ++total_docs_;

    for (auto& [term, freq] : tf_map) {
        index_[term].push_back({chunk_id, freq});
    }
}

void Indexer::add_batch(const std::vector<std::pair<uint32_t, std::string_view>>& chunks) {
    // Tokenize all chunks outside the lock (CPU-heavy, no shared state)
    struct PreparedDoc {
        uint32_t chunk_id;
        std::vector<std::string> tokens;
        std::unordered_map<std::string, uint32_t> tf_map;
    };
    std::vector<PreparedDoc> prepared;
    prepared.reserve(chunks.size());
    for (auto& [id, text] : chunks) {
        auto tokens = tokenize(text);
        std::unordered_map<std::string, uint32_t> tf_map;
        for (auto& t : tokens) {
            ++tf_map[t];
        }
        prepared.push_back({id, std::move(tokens), std::move(tf_map)});
    }

    // Single lock for all insertions
    std::unique_lock lock(mutex_);
    for (auto& doc : prepared) {
        if (doc_lengths_.contains(doc.chunk_id)) {
            continue; // duplicate chunk_id — silently skip
        }
        doc_lengths_[doc.chunk_id] = static_cast<uint32_t>(doc.tokens.size());
        total_tokens_ += doc.tokens.size();
        ++total_docs_;
        for (auto& [term, freq] : doc.tf_map) {
            index_[term].push_back({doc.chunk_id, freq});
        }
    }
}

std::vector<SearchResult> Indexer::search(std::string_view query, int32_t top_k) const {
    if (top_k <= 0) {
        return {};
    }

    auto query_tokens = tokenize(query);
    if (query_tokens.empty()) {
        return {};
    }

    std::shared_lock lock(mutex_);

    if (total_docs_ == 0) {
        return {};
    }

    float avg_dl = static_cast<float>(total_tokens_) / static_cast<float>(total_docs_);

    std::unordered_map<uint32_t, float> scores;

    for (auto& token : query_tokens) {
        auto it = index_.find(token);
        if (it == index_.end()) {
            continue;
        }
        auto& postings = it->second;
        auto df = static_cast<uint32_t>(postings.size());

        for (auto& entry : postings) {
            auto dl_it = doc_lengths_.find(entry.chunk_id);
            uint32_t doc_len = (dl_it != doc_lengths_.end()) ? dl_it->second : 0;
            scores[entry.chunk_id] += bm25_score(entry.term_freq, df, doc_len, avg_dl);
        }
    }

    std::vector<SearchResult> results;
    results.reserve(scores.size());
    for (auto& [chunk_id, score] : scores) {
        results.push_back({chunk_id, score});
    }

    std::sort(results.begin(), results.end(),
              [](const SearchResult& a, const SearchResult& b) { return a.score > b.score; });

    if (top_k > 0 && static_cast<size_t>(top_k) < results.size()) {
        results.resize(static_cast<size_t>(top_k));
    }

    return results;
}

void Indexer::reset() {
    std::unique_lock lock(mutex_);
    index_.clear();
    doc_lengths_.clear();
    total_docs_ = 0;
    total_tokens_ = 0;
}

uint32_t Indexer::term_count() const {
    std::shared_lock lock(mutex_);
    return static_cast<uint32_t>(index_.size());
}

uint32_t Indexer::doc_count() const {
    std::shared_lock lock(mutex_);
    return total_docs_;
}

uint64_t Indexer::memory_bytes() const {
    std::shared_lock lock(mutex_);
    uint64_t bytes = sizeof(Indexer);

    // Posting lists
    for (auto& [term, postings] : index_) {
        bytes += term.capacity() + sizeof(std::string);
        bytes += postings.capacity() * sizeof(PostingEntry) + sizeof(std::vector<PostingEntry>);
    }
    // Hash table overhead (approximate: bucket count * pointer size)
    bytes += index_.bucket_count() * sizeof(void*);

    // Doc lengths map
    bytes += doc_lengths_.size() * (sizeof(uint32_t) + sizeof(uint32_t));
    bytes += doc_lengths_.bucket_count() * sizeof(void*);

    return bytes;
}

} // namespace rr
