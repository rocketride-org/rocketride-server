#include "chunker.h"

#include <unicode/brkiter.h>
#include <unicode/locid.h>
#include <unicode/unistr.h>

#include <algorithm>
#include <stdexcept>

namespace rr {

// Count UTF-8 codepoints in a string_view. Matches Python's len(str).
// Leading bytes: 0xxxxxxx (ASCII), 110xxxxx, 1110xxxx, 11110xxx
// Continuation bytes (10xxxxxx) are skipped.
static int32_t utf8_len(std::string_view sv) {
    int32_t count = 0;
    for (unsigned char c : sv) {
        if ((c & 0xC0) != 0x80) ++count; // not a continuation byte
    }
    return count;
}

// Advance pos to the next UTF-8 codepoint boundary (skip continuation bytes).
static size_t utf8_next(std::string_view sv, size_t pos) {
    if (pos >= sv.size()) return sv.size();
    ++pos;
    while (pos < sv.size() && (static_cast<unsigned char>(sv[pos]) & 0xC0) == 0x80) {
        ++pos;
    }
    return pos;
}

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

// Split text by separator, keeping separator at the START of each subsequent
// piece (matches LangChain keep_separator=True, which maps to "start" logic).
// Empty pieces are filtered out.
//
// Example: split_by("aaa\n\nbbb\n\nccc", "\n\n") -> ["aaa", "\n\nbbb", "\n\nccc"]
static std::vector<std::string_view> split_by(std::string_view text, std::string_view sep) {
    std::vector<std::string_view> parts;
    if (sep.empty()) {
        // Character-level split by Unicode codepoints (not bytes)
        size_t pos = 0;
        while (pos < text.size()) {
            size_t next = utf8_next(text, pos);
            parts.push_back(text.substr(pos, next - pos));
            pos = next;
        }
        return parts;
    }

    // First, find all separator positions
    std::vector<size_t> sep_positions;
    size_t pos = 0;
    while ((pos = text.find(sep, pos)) != std::string_view::npos) {
        sep_positions.push_back(pos);
        pos += sep.size();
    }

    if (sep_positions.empty()) {
        if (!text.empty()) parts.push_back(text);
        return parts;
    }

    // First piece: from start to first separator (no separator prefix)
    if (sep_positions[0] > 0) {
        parts.push_back(text.substr(0, sep_positions[0]));
    }

    // Subsequent pieces: from separator start to next separator (or end)
    for (size_t i = 0; i < sep_positions.size(); ++i) {
        size_t piece_start = sep_positions[i];
        size_t piece_end = (i + 1 < sep_positions.size()) ? sep_positions[i + 1] : text.size();
        if (piece_end > piece_start) {
            parts.push_back(text.substr(piece_start, piece_end - piece_start));
        }
    }

    return parts;
}

static bool is_whitespace(char c) {
    return c == ' ' || c == '\n' || c == '\r' || c == '\t' || c == '\x0b' || c == '\x0c';
}

// Strip whitespace from both ends of a string_view (matches Python str.strip())
static std::string_view strip(std::string_view sv) {
    while (!sv.empty() && is_whitespace(sv.front())) sv.remove_prefix(1);
    while (!sv.empty() && is_whitespace(sv.back())) sv.remove_suffix(1);
    return sv;
}

// Merge small pieces into chunks of ~target_size with overlap.
// Exact replica of LangChain's _merge_splits with separator="".
// Since separator="" and all pieces are contiguous in the original text,
// "".join(current_doc) == contiguous range, and .strip() removes whitespace.
//
// We track current_doc as a deque of indices into `pieces`. Since pieces are
// contiguous views into the original text, the joined result is also a
// contiguous view.
static std::vector<std::string_view> merge_splits(
    const std::vector<std::string_view>& pieces,
    int32_t chunk_size,
    int32_t chunk_overlap
) {
    std::vector<std::string_view> docs;
    if (pieces.empty()) return docs;

    // separator = "", separator_len = 0
    // This means:
    //   - total is just sum of piece lengths in current_doc
    //   - condition: total + len_ > chunk_size (since sep_len=0, the
    //     (sep_len if current else 0) term is always 0)

    // Pre-compute character lengths for each piece (Python len(), not byte count)
    std::vector<int32_t> char_lens(pieces.size());
    for (size_t i = 0; i < pieces.size(); ++i) {
        char_lens[i] = utf8_len(pieces[i]);
    }

    std::vector<size_t> current_doc; // indices into pieces
    int32_t total = 0; // sum of char_lens for pieces in current_doc

    auto emit_doc = [&]() {
        if (current_doc.empty()) return;
        // "".join(current_doc) = contiguous range from first to last piece
        const char* start = pieces[current_doc.front()].data();
        const char* end = pieces[current_doc.back()].data() + pieces[current_doc.back()].size();
        std::string_view joined(start, static_cast<size_t>(end - start));
        std::string_view stripped = strip(joined);
        if (!stripped.empty()) {
            docs.push_back(stripped);
        }
    };

    for (size_t i = 0; i < pieces.size(); ++i) {
        int32_t len_ = char_lens[i];

        if (total + len_ > chunk_size) {
            // Emit current chunk
            emit_doc();

            // Pop from front for overlap: keep popping while
            //   total > chunk_overlap OR (total + len_ > chunk_size AND total > 0)
            while (total > chunk_overlap ||
                   (total + len_ > chunk_size && total > 0)) {
                if (current_doc.empty()) break;
                total -= char_lens[current_doc.front()];
                current_doc.erase(current_doc.begin());
            }
        }

        current_doc.push_back(i);
        total += len_;
    }

    emit_doc();
    return docs;
}

// Recursive split — exact replica of LangChain's _split_text.
// sep_start is the index into the separators array to start searching from.
static std::vector<std::string_view> split_text_recursive(
    std::string_view text,
    int32_t chunk_size,
    int32_t chunk_overlap,
    int sep_start
) {
    static const std::string_view separators[] = {"\n\n", "\n", " ", ""};
    constexpr int n_seps = 4;

    std::vector<std::string_view> final_chunks;

    // Find appropriate separator (first one found in text, starting from sep_start)
    std::string_view separator = separators[n_seps - 1]; // fallback: ""
    int new_sep_start = n_seps; // no further separators

    for (int i = sep_start; i < n_seps; ++i) {
        if (separators[i].empty()) {
            separator = separators[i];
            break;
        }
        if (text.find(separators[i]) != std::string_view::npos) {
            separator = separators[i];
            new_sep_start = i + 1;
            break;
        }
    }

    auto splits = split_by(text, separator);

    // Accumulate small pieces; when a large piece is found, flush + recurse
    std::vector<std::string_view> good_splits;

    for (auto& s : splits) {
        if (utf8_len(s) < chunk_size) {
            good_splits.push_back(s);
        } else {
            if (!good_splits.empty()) {
                auto merged = merge_splits(good_splits, chunk_size, chunk_overlap);
                final_chunks.insert(final_chunks.end(), merged.begin(), merged.end());
                good_splits.clear();
            }
            if (new_sep_start >= n_seps) {
                // Can't split further — emit as-is
                final_chunks.push_back(s);
            } else {
                // Recurse with deeper separator level
                auto sub = split_text_recursive(s, chunk_size, chunk_overlap, new_sep_start);
                final_chunks.insert(final_chunks.end(), sub.begin(), sub.end());
            }
        }
    }

    if (!good_splits.empty()) {
        auto merged = merge_splits(good_splits, chunk_size, chunk_overlap);
        final_chunks.insert(final_chunks.end(), merged.begin(), merged.end());
    }

    return final_chunks;
}

std::vector<Chunk> Chunker::chunk_recursive(std::string_view text, int32_t doc_id) const {
    auto views = split_text_recursive(text, config_.target_size, config_.overlap, 0);

    std::vector<Chunk> result;
    result.reserve(views.size());
    const char* base = text.data();
    for (auto& sv : views) {
        int32_t byte_offset = static_cast<int32_t>(sv.data() - base);
        // Convert byte offset to character offset (for Python compatibility)
        int32_t char_offset = utf8_len(std::string_view(base, static_cast<size_t>(byte_offset)));
        int32_t char_length = utf8_len(sv);
        result.push_back({doc_id, char_offset, char_length});
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
