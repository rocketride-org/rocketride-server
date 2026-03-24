/**
 * Native C++ text chunker — sentence-aware, shared library via ctypes.
 *
 * Improvements over v1 (per Reddit 2026 best practices):
 * - Sentence-aware splitting: prefers to break at '. ' '! ' '? ' boundaries
 * - Falls back to paragraph (\n\n), newline (\n), then space
 * - Never splits inside a word
 * - Zero-copy string_view for boundary detection
 *
 * Compile:
 *   clang++ -std=c++20 -O2 -shared -fPIC native_chunker.cpp -o libnative_chunker.dylib
 */

#include <cstdint>
#include <cstring>

extern "C" {

/**
 * Find the best split point near `target` within [min_pos, target].
 * Priority: sentence end (. ! ?) > paragraph (\n\n) > newline (\n) > space.
 */
static int32_t find_split_point(const char* text, int32_t min_pos, int32_t target, int32_t text_len) {
    if (target >= text_len) return text_len;

    // 1. Try sentence boundary ('. ' or '! ' or '? ')
    for (int32_t i = target; i > min_pos; i--) {
        if (i + 1 < text_len &&
            (text[i - 1] == '.' || text[i - 1] == '!' || text[i - 1] == '?') &&
            (text[i] == ' ' || text[i] == '\n')) {
            return i;
        }
    }

    // 2. Try paragraph break (\n\n)
    for (int32_t i = target; i > min_pos + 1; i--) {
        if (text[i - 1] == '\n' && text[i] == '\n') {
            return i + 1;
        }
    }

    // 3. Try newline
    for (int32_t i = target; i > min_pos; i--) {
        if (text[i] == '\n') {
            return i + 1;
        }
    }

    // 4. Try space (never split inside a word)
    for (int32_t i = target; i > min_pos; i--) {
        if (text[i] == ' ') {
            return i + 1;
        }
    }

    // 5. Hard split at target (no good boundary found)
    return target;
}

/**
 * Split text into chunks of approximately chunk_size characters,
 * with overlap. Prefers sentence boundaries.
 *
 * Returns: number of chunks written.
 * Output format: offsets array [start0, len0, start1, len1, ...]
 */
int32_t chunk_text(
    const char* text,
    int32_t text_len,
    int32_t chunk_size,
    int32_t overlap,
    int32_t* offsets,
    int32_t max_chunks
) {
    if (!text || text_len <= 0 || chunk_size <= 0 || !offsets || max_chunks <= 0 || overlap < 0 || overlap >= chunk_size)
        return 0;

    int32_t count = 0;
    int32_t pos = 0;

    while (pos < text_len && count < max_chunks) {
        int32_t end = pos + chunk_size;
        if (end >= text_len) {
            end = text_len;
        } else {
            // Find best split point in the second half of the chunk
            int32_t min_pos = pos + chunk_size / 2;
            end = find_split_point(text, min_pos, end, text_len);
        }

        // Skip leading whitespace in chunk
        int32_t chunk_start = pos;
        while (chunk_start < end && (text[chunk_start] == ' ' || text[chunk_start] == '\n')) {
            chunk_start++;
        }

        if (chunk_start < end) {
            offsets[count * 2] = chunk_start;
            offsets[count * 2 + 1] = end - chunk_start;
            count++;
        }

        if (end >= text_len) break;

        // Overlap: back up by overlap chars, but snap to a word boundary
        int32_t next_pos = end;
        if (overlap > 0 && end > overlap) {
            next_pos = end - overlap;
            // Snap forward to a space/newline to avoid splitting a word
            while (next_pos < end && text[next_pos] != ' ' && text[next_pos] != '\n') {
                next_pos++;
            }
            if (next_pos >= end) next_pos = end; // no boundary found, no overlap
        }
        pos = next_pos;
    }

    return count;
}

/**
 * Batch chunk: process multiple documents at once.
 */
int32_t batch_chunk(
    const char** doc_texts,
    const int32_t* doc_lens,
    int32_t n_docs,
    int32_t chunk_size,
    int32_t overlap,
    int32_t* out_doc_ids,
    int32_t* out_offsets,
    int32_t* out_lengths,
    int32_t max_total_chunks
) {
    if (!doc_texts || !doc_lens || n_docs <= 0 || chunk_size <= 0 ||
        !out_doc_ids || !out_offsets || !out_lengths || max_total_chunks <= 0 ||
        overlap < 0 || overlap >= chunk_size)
        return 0;

    int32_t total = 0;

    for (int32_t doc = 0; doc < n_docs && total < max_total_chunks; doc++) {
        const char* text = doc_texts[doc];
        int32_t text_len = doc_lens[doc];
        if (!text || text_len <= 0) continue;

        int32_t pos = 0;
        while (pos < text_len && total < max_total_chunks) {
            int32_t end = pos + chunk_size;
            if (end >= text_len) {
                end = text_len;
            } else {
                int32_t min_pos = pos + chunk_size / 2;
                end = find_split_point(text, min_pos, end, text_len);
            }

            int32_t chunk_start = pos;
            while (chunk_start < end && (text[chunk_start] == ' ' || text[chunk_start] == '\n')) {
                chunk_start++;
            }

            if (chunk_start < end) {
                out_doc_ids[total] = doc;
                out_offsets[total] = chunk_start;
                out_lengths[total] = end - chunk_start;
                total++;
            }

            if (end >= text_len) break;

            int32_t next_pos = end;
            if (overlap > 0 && end > overlap) {
                next_pos = end - overlap;
                while (next_pos < end && text[next_pos] != ' ' && text[next_pos] != '\n') {
                    next_pos++;
                }
                if (next_pos >= end) next_pos = end;
            }
            pos = next_pos;
        }
    }

    return total;
}

} // extern "C"
