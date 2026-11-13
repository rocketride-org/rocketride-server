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
    for (int i = 0; i < 4; i++) {
        auto pos = line.find('*', start);
        out.push_back(line.substr(start, pos - start));
        start = pos + 1;
    }
    out.push_back(line.substr(start));  // the trace json may hold '*'
    return out;
}
}  // namespace

//-----------------------------------------------------------------------------
// getPipe() hands out BINDINGS: a traceId (minted, or the live tree it joins)
// and a trace level that the pipe's own gates read. One engine serves a NONE
// and a FULL binding side by side and only the FULL one speaks.
//-----------------------------------------------------------------------------
TEST_CASE("store::bindings") {
    IFilterTest test({"pipe", "null", "bottom"});
    REQUIRE_NO_ERROR(test.connect());

    // Reach the endpoint the way a native source does
    auto first = test.getPipe();
    REQUIRE_NO_ERROR(first);
    auto endpoint = (*first)->endpoint;
    REQUIRE_NO_ERROR(test.putPipe(*first));

    SECTION("traceId is monotonic and never reused across 10,000 cycles") {
        std::set<uint64_t> seen{(*first)->traceId};
        uint64_t last = (*first)->traceId;
        for (int i = 0; i < 10000; i++) {
            auto pipe = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE);
            REQUIRE_NO_ERROR(pipe);
            REQUIRE((*pipe)->traceId > last);
            REQUIRE(seen.insert((*pipe)->traceId).second);
            last = (*pipe)->traceId;
            REQUIRE_NO_ERROR(endpoint->putPipe(*pipe));
        }
        // The whole run reused the one slot
        REQUIRE(endpoint->getPipeCount() == 1);
    }

    SECTION("the launch's trace epoch seeds the high 16 bits of every id") {
        IServiceEndpoint::seedTraceEpoch(0x7A5Eu);
        auto pipe = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE);
        REQUIRE_NO_ERROR(pipe);
        REQUIRE(((*pipe)->traceId >> 48) == 0x7A5Eu);
        auto id = (*pipe)->traceId;
        REQUIRE_NO_ERROR(endpoint->putPipe(*pipe));

        // The epoch in effect is not re-seeded: the counter keeps counting
        IServiceEndpoint::seedTraceEpoch(0x7A5Eu);
        auto next = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE);
        REQUIRE_NO_ERROR(next);
        REQUIRE((*next)->traceId > id);
        REQUIRE(((*next)->traceId >> 48) == 0x7A5Eu);
        REQUIRE_NO_ERROR(endpoint->putPipe(*next));
    }

    SECTION("a new tree gets a minted id and carries the requested level") {
        auto pipe = endpoint->getPipe(PIPELINE_TRACE_LEVEL::SUMMARY);
        REQUIRE_NO_ERROR(pipe);
        REQUIRE((*pipe)->traceId != 0);
        REQUIRE((*pipe)->traceLevel == PIPELINE_TRACE_LEVEL::SUMMARY);
        REQUIRE((*pipe)->bindDepth == 0);
        REQUIRE_NO_ERROR(endpoint->putPipe(*pipe));
    }

    SECTION("the argless form binds at the endpoint default") {
        auto pipe = endpoint->getPipe();
        REQUIRE_NO_ERROR(pipe);
        REQUIRE((*pipe)->traceLevel == endpoint->config.pipelineTraceLevel);
        REQUIRE_NO_ERROR(endpoint->putPipe(*pipe));
    }

    SECTION("joining an existing traceId shares the id and inherits the level") {
        auto first = endpoint->getPipe(PIPELINE_TRACE_LEVEL::FULL);
        REQUIRE_NO_ERROR(first);

        auto joined = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE,
                                        (*first)->traceId);
        REQUIRE_NO_ERROR(joined);
        REQUIRE((*joined)->traceId == (*first)->traceId);
        REQUIRE((*joined)->traceLevel == PIPELINE_TRACE_LEVEL::FULL);
        REQUIRE((*joined)->bindDepth == 1);

        // A third join reports the same id again, one level deeper still
        auto third =
            endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE, (*joined)->traceId);
        REQUIRE_NO_ERROR(third);
        REQUIRE((*third)->traceId == (*first)->traceId);
        REQUIRE((*third)->bindDepth == 2);

        REQUIRE_NO_ERROR(endpoint->putPipe(*third));
        REQUIRE_NO_ERROR(endpoint->putPipe(*joined));
        REQUIRE_NO_ERROR(endpoint->putPipe(*first));
    }

    SECTION("two pipes with the same traceId differ only in their slot") {
        auto first = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE);
        REQUIRE_NO_ERROR(first);
        auto second = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE,
                                        (*first)->traceId);
        REQUIRE_NO_ERROR(second);

        REQUIRE((*second)->traceId == (*first)->traceId);
        REQUIRE((*second)->pipeId != (*first)->pipeId);

        REQUIRE_NO_ERROR(endpoint->putPipe(*second));
        REQUIRE_NO_ERROR(endpoint->putPipe(*first));
    }

    SECTION("a joined tree outlives the pipe that minted its id") {
        auto first = endpoint->getPipe(PIPELINE_TRACE_LEVEL::SUMMARY);
        REQUIRE_NO_ERROR(first);
        auto id = (*first)->traceId;
        auto second = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE, id);
        REQUIRE_NO_ERROR(second);

        // The minting pipe goes back; the id is still live through the
        // second, so a third can still join
        REQUIRE_NO_ERROR(endpoint->putPipe(*first));
        auto third = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE, id);
        REQUIRE_NO_ERROR(third);
        REQUIRE((*third)->traceId == id);
        REQUIRE((*third)->traceLevel == PIPELINE_TRACE_LEVEL::SUMMARY);

        REQUIRE_NO_ERROR(endpoint->putPipe(*third));
        REQUIRE_NO_ERROR(endpoint->putPipe(*second));
    }

    SECTION("a released or unknown traceId is refused") {
        auto first = endpoint->getPipe(PIPELINE_TRACE_LEVEL::FULL);
        REQUIRE_NO_ERROR(first);
        auto released = (*first)->traceId;
        REQUIRE_NO_ERROR(endpoint->putPipe(*first));

        REQUIRE_ERROR(endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE, released),
                      Ec::NotFound, "Trace is not live");
        REQUIRE_ERROR(endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE, 0xFFFFFFFF),
                      Ec::NotFound, "Trace is not live");
    }

    SECTION("a released id never attaches to the slot's next holder") {
        auto first = endpoint->getPipe(PIPELINE_TRACE_LEVEL::FULL);
        REQUIRE_NO_ERROR(first);
        auto released = (*first)->traceId;
        REQUIRE_NO_ERROR(endpoint->putPipe(*first));

        // The same slot is busy again under a NEW tree: the moment it is
        // visible as busy it already carries the new id, never the old one
        auto next = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE);
        REQUIRE_NO_ERROR(next);
        REQUIRE((*next)->pipeId == (*first)->pipeId);
        REQUIRE((*next)->busy);
        REQUIRE((*next)->traceId != released);

        REQUIRE_ERROR(endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE, released),
                      Ec::NotFound, "Trace is not live");

        // While the new holder's own id is a valid tree to join
        auto child = endpoint->getPipe(PIPELINE_TRACE_LEVEL::FULL,
                                       (*next)->traceId);
        REQUIRE_NO_ERROR(child);
        REQUIRE((*child)->traceId == (*next)->traceId);
        REQUIRE((*child)->traceLevel == PIPELINE_TRACE_LEVEL::NONE);

        REQUIRE_NO_ERROR(endpoint->putPipe(*child));
        REQUIRE_NO_ERROR(endpoint->putPipe(*next));
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

        // BEGIN*pipeId*componentId*traceId*trace (no engine-wide pipe
        // count: a holder of a shared engine must not learn it)
        auto begin = fields(capture->lines[0]);
        REQUIRE(begin.size() == 5);
        REQUIRE(begin[0] == "BEGIN");
        REQUIRE(std::stoull(begin[1], nullptr, 16) == (*loud)->pipeId);
        REQUIRE(begin[2] == "loud.txt");
        REQUIRE(std::stoull(begin[3], nullptr, 16) == (*loud)->traceId);
        REQUIRE(begin[4] == "{}");

        auto end = fields(capture->lines[1]);
        REQUIRE(end.size() == 5);
        REQUIRE(end[0] == "END");
        REQUIRE(std::stoull(end[3], nullptr, 16) == (*loud)->traceId);

        // A '*' in the entry name cannot shift the fields after it
        capture->lines.clear();
        auto starred = test.getDummyEntry("a*b*c.txt");
        REQUIRE_NO_ERROR((*loud)->open(starred));
        REQUIRE_NO_ERROR((*loud)->close());
        REQUIRE(capture->lines.size() == 2);
        auto starredBegin = fields(capture->lines[0]);
        REQUIRE(starredBegin[2] == "abc.txt");
        REQUIRE(std::stoull(starredBegin[3], nullptr, 16) == (*loud)->traceId);
        REQUIRE(starredBegin[4] == "{}");

        REQUIRE_NO_ERROR(endpoint->putPipe(*loud));
        REQUIRE_NO_ERROR(endpoint->putPipe(*quiet));
    }

    SECTION("joined pipes inherit the tree depth and stop at the limit") {
        // Each join starts one level deeper than the deepest busy pipe of
        // the tree, so a node that opens a sub-pipe of itself is bounded by
        // the same limit as in-pipe recursion. Join one tree repeatedly.
        std::vector<ServicePipe> chain;
        auto root = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE);
        REQUIRE_NO_ERROR(root);
        REQUIRE((*root)->bindDepth == 0);
        chain.push_back(*root);

        for (int depth = 1; depth <= filter::pipe::CONST_MAX_BIND_DEPTH;
             depth++) {
            auto child = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE,
                                           (*root)->traceId);
            REQUIRE_NO_ERROR(child);
            REQUIRE((*child)->bindDepth == depth);
            REQUIRE((*child)->traceId == (*root)->traceId);
            chain.push_back(*child);
        }

        // The next join would stand past the limit: refused before any
        // pipe is built for it, and the engine keeps serving
        auto pipesBefore = endpoint->getPipeCount();
        REQUIRE_ERROR(
            endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE, (*root)->traceId),
            Ec::Recursion, "Pipeline binding depth exceeded");
        REQUIRE(endpoint->getPipeCount() == pipesBefore);

        // With the deepest pipe back, a join lands at the limit again
        auto deepest = chain.back();
        chain.pop_back();
        REQUIRE_NO_ERROR(endpoint->putPipe(deepest));
        auto again =
            endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE, (*root)->traceId);
        REQUIRE_NO_ERROR(again);
        REQUIRE((*again)->bindDepth == filter::pipe::CONST_MAX_BIND_DEPTH);
        chain.push_back(*again);

        // The deepest child cannot even serve one callback on its own pipe
        auto entry = test.getDummyEntry("deepest.txt");
        REQUIRE_ERROR(chain.back()->open(entry), Ec::Recursion,
                      "Pipeline binding depth exceeded");
        REQUIRE(entry.objectFailed());

        // Release the whole chain; a fresh root starts at zero again
        for (auto it = chain.rbegin(); it != chain.rend(); ++it)
            REQUIRE_NO_ERROR(endpoint->putPipe(*it));
        auto fresh = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE);
        REQUIRE_NO_ERROR(fresh);
        REQUIRE((*fresh)->bindDepth == 0);
        REQUIRE_NO_ERROR(endpoint->putPipe(*fresh));
    }

    SECTION("trace level names parse in any case") {
        PIPELINE_TRACE_LEVEL level = PIPELINE_TRACE_LEVEL::NONE;
        REQUIRE(IServiceEndpoint::parseTraceLevel("Full"_tv, level));
        REQUIRE(level == PIPELINE_TRACE_LEVEL::FULL);
        REQUIRE(IServiceEndpoint::parseTraceLevel("SUMMARY"_tv, level));
        REQUIRE(level == PIPELINE_TRACE_LEVEL::SUMMARY);
        REQUIRE(IServiceEndpoint::parseTraceLevel("metadata"_tv, level));
        REQUIRE(level == PIPELINE_TRACE_LEVEL::METADATA);
        REQUIRE(IServiceEndpoint::parseTraceLevel("None"_tv, level));
        REQUIRE(level == PIPELINE_TRACE_LEVEL::NONE);

        // An unknown name is reported and leaves the level alone
        level = PIPELINE_TRACE_LEVEL::FULL;
        REQUIRE_FALSE(IServiceEndpoint::parseTraceLevel("verbose"_tv, level));
        REQUIRE(level == PIPELINE_TRACE_LEVEL::FULL);
        REQUIRE_FALSE(IServiceEndpoint::parseTraceLevel(""_tv, level));
        REQUIRE(level == PIPELINE_TRACE_LEVEL::FULL);
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
