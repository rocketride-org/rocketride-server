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

//-----------------------------------------------------------------------------
//
//	Unit tests for the audio/video stream descriptor builder
//	(engine::store::buildStreamDescriptor). Drives the pure builder off a
//	dummy Entry so no pipeline / media corpus is needed. The descriptor shape
//	is the wire contract shared with the Python parser
//	(ai.common.avi.descriptor); its canonical key list lives in the guardrail
//	fixture packages/ai/tests/ai/common/avi/descriptor_keys.json.
//
//-----------------------------------------------------------------------------

#include "../store.h"

using engine::store::buildStreamDescriptor;

TEST_CASE("store::media stream descriptor") {
    IFilterTest filter({engine::store::filter::hash::Type});
    REQUIRE_NO_ERROR(filter.connect());

    Entry entry = filter.getDummyEntry("interview.mp4"_tv);
    Text nodeId = "node-7"_tv;

    //-----------------------------------------------------------------
    // Baseline video descriptor built from the Entry only.
    //-----------------------------------------------------------------
    SECTION("video baseline carries the source backlink") {
        Text mime = "video/mp4"_tv;
        json::Value enrich;  // no producer enrichment
        auto desc =
            buildStreamDescriptor(entry, "VideoStream", mime, nodeId, 0, enrich);

        REQUIRE(desc["type"].asString() == "VideoStream");

        const auto &md = desc["metadata"];
        REQUIRE(md["objectId"].asString() == "obj1");
        // parent = the entry's url path; the exact url formatting depends on the
        // endpoint scheme (tested elsewhere), so just assert the field is emitted.
        REQUIRE(md.isMember("parent"));
        REQUIRE(md["nodeId"].asString() == "node-7");
        REQUIRE(md["source_mime"].asString() == "video/mp4");
        REQUIRE(md["size"].asUInt64() == 42);
        REQUIRE(md["stream_index"].asInt() == 0);
        REQUIRE(md.isMember("signature"));  // componentId is set by getDummyEntry
    }

    //-----------------------------------------------------------------
    // Absent Entry fields are omitted (never null) to match exclude_none.
    //-----------------------------------------------------------------
    SECTION("unset fields are omitted, not null") {
        Text mime = "video/mp4"_tv;
        json::Value enrich;
        auto desc =
            buildStreamDescriptor(entry, "VideoStream", mime, nodeId, 0, enrich);

        // getDummyEntry does not set permissionId, so it must be absent.
        REQUIRE_FALSE(desc["metadata"].isMember("permissionId"));
        // Best-effort media fields were never supplied.
        REQUIRE_FALSE(desc["metadata"].isMember("duration"));
        REQUIRE_FALSE(desc["metadata"].isMember("fps"));
    }

    //-----------------------------------------------------------------
    // stream_index reflects the caller's per-object counter.
    //-----------------------------------------------------------------
    SECTION("stream_index is carried through") {
        Text mime = "video/mp4"_tv;
        json::Value enrich;
        auto desc =
            buildStreamDescriptor(entry, "VideoStream", mime, nodeId, 3, enrich);
        REQUIRE(desc["metadata"]["stream_index"].asInt() == 3);
    }

    //-----------------------------------------------------------------
    // Enrichment fills missing fields but never overwrites the backlink.
    //-----------------------------------------------------------------
    SECTION("enrichment fills missing but does not overwrite backlink") {
        Text mime = "audio/wav"_tv;
        json::Value enrich;
        enrich["duration"] = 240.0;
        enrich["origin"] = "extracted";
        enrich["source_mime"] = "video/mp4";     // container mime (authoritative)
        enrich["objectId"] = "SHOULD_NOT_WIN";   // must NOT overwrite the backlink

        auto desc =
            buildStreamDescriptor(entry, "AudioStream", mime, nodeId, 0, enrich);

        const auto &md = desc["metadata"];
        REQUIRE(desc["type"].asString() == "AudioStream");
        // Enrichment-only fields land.
        REQUIRE(md["duration"].asDouble() == 240.0);
        REQUIRE(md["origin"].asString() == "extracted");
        // Enrichment's source_mime (the container mime) wins over the mime fallback.
        REQUIRE(md["source_mime"].asString() == "video/mp4");
        // Backlink objectId is authoritative; enrichment must NOT win.
        REQUIRE(md["objectId"].asString() == "obj1");
    }

    //-----------------------------------------------------------------
    // Image streams use the same generic builder: backlink + stream_index,
    // with image media detail (dims/origin) supplied via enrichment.
    //-----------------------------------------------------------------
    SECTION("image stream carries backlink plus enriched media detail") {
        Text mime = "image/png"_tv;
        json::Value enrich;
        enrich["origin"] = "extracted";      // a frame derived from a video
        enrich["width"] = 1920;
        enrich["height"] = 1080;
        enrich["resource_name"] = "media1.mp4 @ deck.pptx";

        auto desc =
            buildStreamDescriptor(entry, "ImageStream", mime, nodeId, 2, enrich);

        const auto &md = desc["metadata"];
        REQUIRE(desc["type"].asString() == "ImageStream");
        REQUIRE(md["objectId"].asString() == "obj1");
        REQUIRE(md["stream_index"].asInt() == 2);
        REQUIRE(md["source_mime"].asString() == "image/png");  // mime fallback
        REQUIRE(md["origin"].asString() == "extracted");
        REQUIRE(md["width"].asInt() == 1920);
        REQUIRE(md["height"].asInt() == 1080);
        REQUIRE(md["resource_name"].asString() == "media1.mp4 @ deck.pptx");
    }
}
