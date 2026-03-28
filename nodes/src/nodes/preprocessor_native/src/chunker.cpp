#include "chunker.h"

#include <unicode/brkiter.h>
#include <unicode/locid.h>
#include <unicode/unistr.h>

#include <algorithm>
#include <stdexcept>

namespace rr {

Chunker::Chunker(ChunkerConfig config) : config_(std::move(config)) {}

Chunker::~Chunker() = default;

std::vector<int32_t> Chunker::sentence_boundaries_fast(std::string_view text) const {
    std::vector<int32_t> boundaries;
    boundaries.push_back(0);
    for (size_t i = 0; i < text.size(); ++i) {
        char c = text[i];
        if ((c == '.' || c == '!' || c == '?') && i + 1 < text.size()) {
            char next = text[i + 1];
            if (next == ' ' || next == '\n' || next == '\r' || next == '\t') {
                boundaries.push_back(static_cast<int32_t>(i + 2));
            }
        }
    }
    if (boundaries.back() != static_cast<int32_t>(text.size())) {
        boundaries.push_back(static_cast<int32_t>(text.size()));
    }
    return boundaries;
}

std::vector<int32_t> Chunker::sentence_boundaries_icu(std::string_view text) const {
    UErrorCode status = U_ZERO_ERROR;
    icu::UnicodeString utext =
        icu::UnicodeString::fromUTF8(icu::StringPiece(text.data(), static_cast<int32_t>(text.size())));

    std::unique_ptr<icu::BreakIterator> iter(
        icu::BreakIterator::createSentenceInstance(icu::Locale(config_.locale.c_str()), status));
    if (U_FAILURE(status)) {
        throw std::runtime_error("Failed to create ICU BreakIterator");
    }

    iter->setText(utext);

    // Collect sentence boundary positions in UTF-16 units (UnicodeString indices)
    std::vector<int32_t> boundaries;
    boundaries.push_back(0);
    int32_t pos = iter->next();
    while (pos != icu::BreakIterator::DONE) {
        boundaries.push_back(pos);
        pos = iter->next();
    }
    if (boundaries.back() != utext.length()) {
        boundaries.push_back(utext.length());
    }

    return boundaries;
}

// Build a lookup table mapping every UTF-16 code-unit offset [0..len] to its
// corresponding UTF-8 byte offset.  One pass, O(len).
static std::vector<int32_t> build_utf16_to_utf8_map(const icu::UnicodeString& utext) {
    int32_t len = utext.length(); // in UTF-16 code units
    std::vector<int32_t> map(static_cast<size_t>(len) + 1);
    int32_t utf8_pos = 0;
    for (int32_t i = 0; i < len; ) {
        map[static_cast<size_t>(i)] = utf8_pos;
        UChar32 cp;
        U16_NEXT(utext.getBuffer(), i, len, cp);
        // Count how many UTF-8 bytes this codepoint needs
        if (cp < 0x80)        utf8_pos += 1;
        else if (cp < 0x800)  utf8_pos += 2;
        else if (cp < 0x10000) utf8_pos += 3;
        else                   utf8_pos += 4;
    }
    map[static_cast<size_t>(len)] = utf8_pos;
    return map;
}

// Count Unicode codepoints between two UTF-16 offsets
static int32_t count_codepoints(const icu::UnicodeString& utext, int32_t from, int32_t to) {
    return utext.tempSubStringBetween(from, to).countChar32();
}

// Generic chunk assembly from a list of byte-offset boundaries and a sizing function.
// sizing_fn(boundary_idx) returns the "size" (chars or bytes) of sentence at that index.
// offset_fn(boundary_value) returns the byte offset for that boundary.
static std::vector<Chunk> assemble_chunks(
    const std::vector<int32_t>& boundaries,
    int32_t doc_id,
    int32_t target_size,
    int32_t overlap,
    auto sizing_fn,   // (size_t idx) -> int32_t sentence size
    auto offset_fn    // (int32_t boundary) -> int32_t byte offset
) {
    std::vector<Chunk> chunks;
    size_t sent_start = 0;

    while (sent_start < boundaries.size() - 1) {
        int32_t chars_accumulated = 0;
        size_t sent_end = sent_start;

        while (sent_end < boundaries.size() - 1) {
            int32_t sentence_size = sizing_fn(sent_end);
            if (chars_accumulated > 0 && chars_accumulated + sentence_size > target_size) {
                break;
            }
            chars_accumulated += sentence_size;
            ++sent_end;
        }

        if (sent_end == sent_start) {
            ++sent_end;
        }

        int32_t byte_offset = offset_fn(boundaries[sent_start]);
        int32_t byte_end = offset_fn(boundaries[sent_end]);
        chunks.push_back({doc_id, byte_offset, byte_end - byte_offset});

        if (sent_end >= boundaries.size() - 1) {
            break;
        }

        if (overlap > 0) {
            int32_t overlap_acc = 0;
            size_t next_start = sent_end;
            while (next_start > sent_start + 1) {
                int32_t prev_size = sizing_fn(next_start - 1);
                if (overlap_acc + prev_size > overlap) break;
                overlap_acc += prev_size;
                --next_start;
            }
            sent_start = next_start;
        } else {
            sent_start = sent_end;
        }
    }

    return chunks;
}

// Split text by a separator, keeping the separator at the end of each piece (like LangChain keep_separator=true)
static std::vector<std::string_view> split_by(std::string_view text, std::string_view sep) {
    std::vector<std::string_view> parts;
    if (sep.empty()) {
        // Character-level split
        for (size_t i = 0; i < text.size(); ++i) {
            parts.push_back(text.substr(i, 1));
        }
        return parts;
    }
    size_t start = 0;
    while (start < text.size()) {
        size_t pos = text.find(sep, start);
        if (pos == std::string_view::npos) {
            parts.push_back(text.substr(start));
            break;
        }
        // Include separator at end of this piece
        parts.push_back(text.substr(start, pos + sep.size() - start));
        start = pos + sep.size();
    }
    return parts;
}

// Merge small pieces into chunks of ~target_size with overlap
static std::vector<std::string_view> merge_splits(
    const std::vector<std::string_view>& pieces,
    int32_t target_size,
    int32_t overlap
) {
    std::vector<std::string_view> chunks;
    if (pieces.empty()) return chunks;

    // Track current chunk as contiguous range in the original text
    const char* chunk_start = pieces[0].data();
    size_t chunk_len = 0;
    size_t overlap_start_idx = 0; // index into pieces where overlap begins

    for (size_t i = 0; i < pieces.size(); ++i) {
        auto& p = pieces[i];
        size_t p_len = p.size();

        if (chunk_len > 0 && static_cast<int32_t>(chunk_len + p_len) > target_size) {
            // Emit current chunk (strip trailing whitespace like LangChain)
            std::string_view sv(chunk_start, chunk_len);
            while (!sv.empty() && (sv.back() == ' ' || sv.back() == '\n' || sv.back() == '\r')) {
                sv.remove_suffix(1);
            }
            if (!sv.empty()) {
                chunks.push_back(sv);
            }

            // Find overlap start: walk back from current position
            int32_t overlap_len = 0;
            size_t new_start_idx = i;
            while (new_start_idx > overlap_start_idx) {
                --new_start_idx;
                overlap_len += static_cast<int32_t>(pieces[new_start_idx].size());
                if (overlap_len >= overlap) {
                    break;
                }
            }
            overlap_start_idx = new_start_idx;
            chunk_start = pieces[overlap_start_idx].data();
            chunk_len = 0;
            for (size_t j = overlap_start_idx; j < i; ++j) {
                chunk_len += pieces[j].size();
            }
        }

        // If this is the first piece or we just reset, set start
        if (chunk_len == 0 && i >= overlap_start_idx) {
            chunk_start = p.data();
        }
        chunk_len += p_len;
    }

    // Emit final chunk
    if (chunk_len > 0) {
        std::string_view sv(chunk_start, chunk_len);
        while (!sv.empty() && (sv.back() == ' ' || sv.back() == '\n' || sv.back() == '\r')) {
            sv.remove_suffix(1);
        }
        if (!sv.empty()) {
            chunks.push_back(sv);
        }
    }

    return chunks;
}

std::vector<Chunk> Chunker::chunk_recursive(std::string_view text, int32_t doc_id) const {
    static const std::string_view separators[] = {"\n\n", "\n", " ", ""};
    constexpr int n_seps = 4;

    // Find the right separator level
    int sep_idx = n_seps - 1;
    for (int i = 0; i < n_seps; ++i) {
        if (separators[i].empty() || text.find(separators[i]) != std::string_view::npos) {
            sep_idx = i;
            break;
        }
    }

    auto pieces = split_by(text, separators[sep_idx]);

    // For pieces that are still too large, recurse with next separator
    std::vector<std::string_view> good_splits;
    std::vector<std::string_view> pending;

    auto flush_pending = [&]() {
        if (pending.empty()) return;
        auto merged = merge_splits(pending, config_.target_size, config_.overlap);
        good_splits.insert(good_splits.end(), merged.begin(), merged.end());
        pending.clear();
    };

    for (auto& piece : pieces) {
        if (static_cast<int32_t>(piece.size()) <= config_.target_size) {
            pending.push_back(piece);
        } else {
            flush_pending();
            // Recurse: try next separator level
            if (sep_idx + 1 < n_seps) {
                // Inline recursion with next separator
                auto sub_pieces = split_by(piece, separators[sep_idx + 1]);
                auto sub_merged = merge_splits(sub_pieces, config_.target_size, config_.overlap);
                good_splits.insert(good_splits.end(), sub_merged.begin(), sub_merged.end());
            } else {
                // Hard cut at target_size
                for (size_t off = 0; off < piece.size(); off += config_.target_size) {
                    size_t len = std::min(static_cast<size_t>(config_.target_size), piece.size() - off);
                    good_splits.push_back(piece.substr(off, len));
                }
            }
        }
    }
    flush_pending();

    // Convert string_views to Chunks with byte offsets
    std::vector<Chunk> result;
    result.reserve(good_splits.size());
    const char* base = text.data();
    for (auto& sv : good_splits) {
        int32_t offset = static_cast<int32_t>(sv.data() - base);
        result.push_back({doc_id, offset, static_cast<int32_t>(sv.size())});
    }
    return result;
}

std::vector<Chunk> Chunker::chunk(std::string_view text, int32_t doc_id) const {
    if (text.empty()) {
        return {};
    }

    if (config_.mode == SplitMode::recursive) {
        return chunk_recursive(text, doc_id);
    }

    if (config_.mode == SplitMode::fast) {
        // Fast path: boundaries are byte offsets, sizes are byte lengths
        auto boundaries = sentence_boundaries_fast(text);
        if (boundaries.size() <= 1) return {};

        return assemble_chunks(boundaries, doc_id, config_.target_size, config_.overlap,
            [&](size_t idx) -> int32_t {
                return boundaries[idx + 1] - boundaries[idx];
            },
            [](int32_t b) -> int32_t { return b; }
        );
    }

    // ICU path: boundaries are UTF-16 offsets, need conversion
    icu::UnicodeString utext =
        icu::UnicodeString::fromUTF8(icu::StringPiece(text.data(), static_cast<int32_t>(text.size())));

    auto boundaries = sentence_boundaries_icu(text);
    if (boundaries.size() <= 1) return {};

    auto u16_to_u8 = build_utf16_to_utf8_map(utext);

    return assemble_chunks(boundaries, doc_id, config_.target_size, config_.overlap,
        [&](size_t idx) -> int32_t {
            return count_codepoints(utext, boundaries[idx], boundaries[idx + 1]);
        },
        [&](int32_t b) -> int32_t {
            return u16_to_u8[static_cast<size_t>(b)];
        }
    );
}

std::vector<Chunk> Chunker::chunk_batch(const std::vector<std::string_view>& texts) const {
    std::vector<Chunk> all;
    for (size_t i = 0; i < texts.size(); ++i) {
        auto doc_chunks = chunk(texts[i], static_cast<int32_t>(i));
        all.insert(all.end(), doc_chunks.begin(), doc_chunks.end());
    }
    return all;
}

} // namespace rr
