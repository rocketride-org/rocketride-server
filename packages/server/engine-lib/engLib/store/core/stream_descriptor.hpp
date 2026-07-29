// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

#pragma once

namespace engine::store {

//-------------------------------------------------------------------------
/// @details
///		Builds the audio/video stream descriptor injected on the media `BEGIN`
///		payload, so a receiver knows the stream (source backlink, size, media
///		detail) before the bytes arrive.
///
///		Producer side of a JSON wire contract; the consumer is the Python
///		parser `descriptor_from_payload()` in `ai/common/avi/descriptor.py`.
///		Canonical keys live in the guardrail fixture
///		`testdata/contracts/descriptor_keys.json`. Called from
///		`buildBeginPayload()`. Free function so Catch2 can drive it via
///		`getDummyEntry()`. Absent fields are omitted (never null).
///
///	@param[in]	entry        The object the stream came from (currentEntry).
///	@param[in]	streamType   "VideoStream" or "AudioStream".
///	@param[in]	mimeType     The stream's BEGIN mime; the `source_mime` fallback.
///	@param[in]	nodeId       Pipeline node id (jobConfig["nodeId"]).
///	@param[in]	streamIndex  Per-object index distinguishing multiple streams.
///	@param[in]	enrich       Optional payload; fills unset fields and may set/override
///	                         size and source_mime (a producer knows the real stream size).
///	@returns	The descriptor as a `json::Value`.
//-------------------------------------------------------------------------
inline json::Value buildStreamDescriptor(const Entry &entry,
                                         const char *streamType,
                                         const Text &mimeType,
                                         const Text &nodeId,
                                         uint32_t streamIndex,
                                         const json::Value &enrich) noexcept {
    json::Value desc;
    desc["type"] = streamType;

    json::Value &md = desc["metadata"];

    // Identity backlink from the Entry; enrichment can never overwrite these.
    if (entry.objectId) md["objectId"] = entry.objectId();
    if (entry.url) md["parent"] = entry.path();
    if (entry.permissionId) md["permissionId"] = entry.permissionId();
    if (entry.componentId) md["signature"] = entry.componentId();
    if (!nodeId.empty()) md["nodeId"] = nodeId;
    md["stream_index"] = streamIndex;

    // Enrichment fills keys the identity backlink didn't set (media detail; may also
    // set size / source_mime, resolved below).
    if (enrich.isObject()) {
        for (const auto &key : enrich.getMemberNames()) {
            if (!md.isMember(key)) md[key] = enrich[key];
        }
    }

    // size: the stream's own size — a producer may enrich it (e.g. an extracted frame's
    // byte length); otherwise fall back to the source object's Entry.size.
    if (!md.isMember("size") && entry.size) {
        md["size"] = entry.size();
    }

    // source_mime: prefer enrichment (the source file's mime, e.g. the container for
    // extracted media); fall back to the stream's own mime.
    if (!md.isMember("source_mime") && !mimeType.empty()) {
        md["source_mime"] = mimeType;
    }

    return desc;
}

}  // namespace engine::store
