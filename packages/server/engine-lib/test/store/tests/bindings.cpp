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

#include <set>

#include "../store.h"

//-----------------------------------------------------------------------------
// A monitor that records every `>DBG` line the engine emits. The emission gate
// also requires an app monitor, so this one claims to be one.
//-----------------------------------------------------------------------------
namespace {
class CaptureMonitor : public engine::monitor::TestConsole {
public:
    using TestConsole::TestConsole;

    std::vector<std::string> lines;

    void other(TextView key, TextView param) noexcept override {
        if (key == "DBG"_tv)
            lines.push_back(std::string(param.data(), param.length()));
    }

    bool isAppMonitor() noexcept override { return true; }
};

// Splits a `>DBG` line into its '*'-separated fields
std::vector<std::string> fields(const std::string &line) {
    std::vector<std::string> out;
    size_t start = 0;
    for (int i = 0; i < 6; i++) {
        auto pos = line.find('*', start);
        out.push_back(line.substr(start, pos - start));
        start = pos + 1;
    }
    out.push_back(line.substr(start));  // the trace json may hold '*'
    return out;
}
}  // namespace

//-----------------------------------------------------------------------------
// getPipe() hands out BINDINGS: a never-reused id, a root, a trace level that
// the pipe's own gates read. One engine serves a NONE and a FULL binding side
// by side and only the FULL one speaks.
//-----------------------------------------------------------------------------
TEST_CASE("store::bindings") {
    IFilterTest test({"pipe", "null", "bottom"});
    REQUIRE_NO_ERROR(test.connect());

    // Reach the endpoint the way a native source does
    auto first = test.getPipe();
    REQUIRE_NO_ERROR(first);
    auto endpoint = (*first)->endpoint;
    REQUIRE_NO_ERROR(test.putPipe(*first));

    SECTION("bindingId is monotonic and never reused across 10,000 cycles") {
        std::set<uint64_t> seen{(*first)->bindingId};
        uint64_t last = (*first)->bindingId;
        for (int i = 0; i < 10000; i++) {
            auto pipe = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE);
            REQUIRE_NO_ERROR(pipe);
            REQUIRE((*pipe)->bindingId > last);
            REQUIRE(seen.insert((*pipe)->bindingId).second);
            last = (*pipe)->bindingId;
            REQUIRE_NO_ERROR(endpoint->putPipe(*pipe));
        }
        // The whole run reused the one slot
        REQUIRE(endpoint->getPipeCount() == 1);
    }

    SECTION("a root binding is its own root and carries the requested level") {
        auto pipe = endpoint->getPipe(PIPELINE_TRACE_LEVEL::SUMMARY);
        REQUIRE_NO_ERROR(pipe);
        REQUIRE((*pipe)->rootBindingId == (*pipe)->bindingId);
        REQUIRE((*pipe)->traceLevel == PIPELINE_TRACE_LEVEL::SUMMARY);
        REQUIRE_NO_ERROR(endpoint->putPipe(*pipe));
    }

    SECTION("the argless form binds at the endpoint default") {
        auto pipe = endpoint->getPipe();
        REQUIRE_NO_ERROR(pipe);
        REQUIRE((*pipe)->traceLevel == endpoint->config.pipelineTraceLevel);
        REQUIRE_NO_ERROR(endpoint->putPipe(*pipe));
    }

    SECTION("a child binding joins the parent's tree and inherits its level") {
        auto parent = endpoint->getPipe(PIPELINE_TRACE_LEVEL::FULL);
        REQUIRE_NO_ERROR(parent);

        auto child = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE,
                                       (*parent)->bindingId);
        REQUIRE_NO_ERROR(child);
        REQUIRE((*child)->bindingId != (*parent)->bindingId);
        REQUIRE((*child)->rootBindingId == (*parent)->bindingId);
        REQUIRE((*child)->traceLevel == PIPELINE_TRACE_LEVEL::FULL);

        // A grandchild reports the same root
        auto grandchild =
            endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE, (*child)->bindingId);
        REQUIRE_NO_ERROR(grandchild);
        REQUIRE((*grandchild)->rootBindingId == (*parent)->bindingId);

        REQUIRE_NO_ERROR(endpoint->putPipe(*grandchild));
        REQUIRE_NO_ERROR(endpoint->putPipe(*child));
        REQUIRE_NO_ERROR(endpoint->putPipe(*parent));
    }

    SECTION("a released or unknown parent is refused") {
        auto parent = endpoint->getPipe(PIPELINE_TRACE_LEVEL::FULL);
        REQUIRE_NO_ERROR(parent);
        auto released = (*parent)->bindingId;
        REQUIRE_NO_ERROR(endpoint->putPipe(*parent));

        REQUIRE_ERROR(endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE, released),
                      Ec::NotFound, "Parent binding is not live");
        REQUIRE_ERROR(endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE, 0xFFFFFFFF),
                      Ec::NotFound, "Parent binding is not live");
    }

    SECTION("NONE and FULL bindings on one engine: only FULL emits") {
        // Swap in the capturing monitor for the section (a managed factory
        // Ptr, like the one monitor init installs)
        auto capture = new CaptureMonitor(
            engine::monitor::Monitor::FactoryArgs{"TestConsole"});
        ap::Ptr<engine::monitor::Monitor> mine(
            capture, [](engine::monitor::Monitor *p) { delete p; });
        auto saved = _mv(::engine::config::monitor());
        ::engine::config::monitor() = _mv(mine);
        util::Guard restore{[] {}, [&] {
                                ::engine::config::monitor() = _mv(saved);
                            }};

        auto quiet = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE);
        REQUIRE_NO_ERROR(quiet);
        auto loud = endpoint->getPipe(PIPELINE_TRACE_LEVEL::FULL);
        REQUIRE_NO_ERROR(loud);

        auto quietEntry = test.getDummyEntry("quiet.txt");
        auto loudEntry = test.getDummyEntry("loud.txt");

        REQUIRE_NO_ERROR((*quiet)->open(quietEntry));
        REQUIRE_NO_ERROR((*quiet)->close());
        REQUIRE(capture->lines.empty());

        REQUIRE_NO_ERROR((*loud)->open(loudEntry));
        REQUIRE_NO_ERROR((*loud)->close());
        REQUIRE(capture->lines.size() == 2);

        // BEGIN*pipeId*totalPipes*componentId*bindingId*rootBindingId*trace
        auto begin = fields(capture->lines[0]);
        REQUIRE(begin.size() == 7);
        REQUIRE(begin[0] == "BEGIN");
        REQUIRE(std::stoull(begin[1], nullptr, 16) == (*loud)->pipeId);
        REQUIRE(std::stoull(begin[2], nullptr, 16) == endpoint->getPipeCount());
        REQUIRE(begin[3] == "loud.txt");
        REQUIRE(std::stoull(begin[4], nullptr, 16) == (*loud)->bindingId);
        REQUIRE(std::stoull(begin[5], nullptr, 16) == (*loud)->rootBindingId);
        REQUIRE(begin[6] == "{}");

        auto end = fields(capture->lines[1]);
        REQUIRE(end[0] == "END");
        REQUIRE(std::stoull(end[4], nullptr, 16) == (*loud)->bindingId);

        REQUIRE_NO_ERROR(endpoint->putPipe(*loud));
        REQUIRE_NO_ERROR(endpoint->putPipe(*quiet));
    }

    SECTION("the recursion guard fails the entry at the depth limit") {
        auto pipe = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE);
        REQUIRE_NO_ERROR(pipe);

        // Stand at the limit: the next nesting is one too many
        (*pipe)->bindDepth = filter::pipe::CONST_MAX_BIND_DEPTH;

        auto entry = test.getDummyEntry("deep.txt");
        REQUIRE_ERROR((*pipe)->open(entry), Ec::Recursion,
                      "Pipeline binding depth exceeded");
        REQUIRE(entry.objectFailed());
        REQUIRE(entry.completionCode().code() == Ec::Recursion);

        // The guard restored the count, so the pipe serves the next request
        REQUIRE((*pipe)->bindDepth == filter::pipe::CONST_MAX_BIND_DEPTH);
        (*pipe)->bindDepth = 0;
        auto next = test.getDummyEntry("next.txt");
        REQUIRE_NO_ERROR((*pipe)->open(next));
        REQUIRE_NO_ERROR((*pipe)->close());
        REQUIRE_FALSE(next.objectFailed());

        REQUIRE_NO_ERROR(endpoint->putPipe(*pipe));
    }

    REQUIRE_NO_ERROR(test.disconnect());
}
