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

#include "test.h"

//-----------------------------------------------------------------------------
// Unit tests for engine::store::computePipelineStack, the canonical stack
// (plan 7.2). The walk reads providers and wiring only (no service lookup),
// so the providers below are plain labels.
//
// What a stack must not depend on: component ids, the order the file lists
// components and edges, names, configuration, UI data. What it must depend
// on: providers, lanes, classTypes, the wiring itself and avoidMocks.
//-----------------------------------------------------------------------------
namespace {

// The providers of a stack in stack order: the shape as a reader sees it
std::vector<std::string> providersOf(
    const engine::store::PipelineStack &stack) {
    std::vector<std::string> out;
    for (const auto &entry : stack.components) out.push_back(entry.provider);
    return out;
}

// The stack index of a component id
int indexOf(const engine::store::PipelineStack &stack, const std::string &id) {
    for (const auto &entry : stack.components)
        if (entry.id == id) return entry.index;
    return -1;
}

// A RAG-like chain with a fork: webhook -> parse -> (embed -> store, llm);
// the llm also reads the source directly, so it has two input edges
const auto CHAIN = R"({
    "source": "hook",
    "components": [
        { "id": "hook", "provider": "webhook", "config": { "port": 1 } },
        { "id": "parse", "provider": "parse",
          "input": [ { "lane": "tags", "from": "hook" } ] },
        { "id": "embed", "provider": "embedding",
          "input": [ { "lane": "text", "from": "parse" } ] },
        { "id": "store", "provider": "qdrant",
          "input": [ { "lane": "documents", "from": "embed" } ] },
        { "id": "llm", "provider": "llm_openai",
          "input": [ { "lane": "questions", "from": "parse" },
                     { "lane": "questions", "from": "hook" } ] }
    ]
})"_json;

// The same shape: every id renamed, components and edges listed in another
// order (the llm's two input edges reversed), names, configuration and UI
// data changed
const auto CHAIN_SHUFFLED = R"({
    "source": "src_9",
    "components": [
        { "id": "z_answer", "provider": "llm_openai", "name": "Answer",
          "config": { "model": "gpt-5" }, "ui": { "position": { "x": 4 } },
          "input": [ { "from": "src_9", "lane": "questions" },
                     { "from": "a_parser", "lane": "questions" } ] },
        { "id": "q_vectors", "provider": "qdrant", "config": { "host": "h" },
          "input": [ { "lane": "documents", "from": "m_embedder" } ] },
        { "id": "a_parser", "provider": "parse",
          "input": [ { "lane": "tags", "from": "src_9" } ] },
        { "id": "m_embedder", "provider": "embedding",
          "input": [ { "lane": "text", "from": "a_parser" } ] },
        { "id": "src_9", "provider": "webhook", "config": { "port": 2 } }
    ]
})"_json;

// Two identical branches off the source, each ending in its own response:
// the walk cannot tell them apart by shape, so any assignment is one stack
const auto SYMMETRIC = R"({
    "source": "chat",
    "components": [
        { "id": "chat", "provider": "chat" },
        { "id": "left_llm", "provider": "llm_openai",
          "input": [ { "lane": "questions", "from": "chat" } ] },
        { "id": "right_llm", "provider": "llm_openai",
          "input": [ { "lane": "questions", "from": "chat" } ] },
        { "id": "left_out", "provider": "response_answers",
          "input": [ { "lane": "answers", "from": "left_llm" } ] },
        { "id": "right_out", "provider": "response_answers",
          "input": [ { "lane": "answers", "from": "right_llm" } ] }
    ]
})"_json;

// The same, ids swapped across the branches and listed in reverse
const auto SYMMETRIC_SWAPPED = R"({
    "source": "c",
    "components": [
        { "id": "b2", "provider": "response_answers",
          "input": [ { "lane": "answers", "from": "a2" } ] },
        { "id": "b1", "provider": "response_answers",
          "input": [ { "lane": "answers", "from": "a1" } ] },
        { "id": "a2", "provider": "llm_openai",
          "input": [ { "lane": "questions", "from": "c" } ] },
        { "id": "a1", "provider": "llm_openai",
          "input": [ { "lane": "questions", "from": "c" } ] },
        { "id": "c", "provider": "chat" }
    ]
})"_json;

// Two llms off the source that tie on lane and provider but differ
// downstream: only the canonical form tells them apart
const auto ASYMMETRIC = R"({
    "source": "chat",
    "components": [
        { "id": "chat", "provider": "chat" },
        { "id": "x", "provider": "llm_openai",
          "input": [ { "lane": "questions", "from": "chat" } ] },
        { "id": "y", "provider": "llm_openai",
          "input": [ { "lane": "questions", "from": "chat" } ] },
        { "id": "x_out", "provider": "response_text",
          "input": [ { "lane": "answers", "from": "x" } ] },
        { "id": "y_out", "provider": "response_answers",
          "input": [ { "lane": "answers", "from": "y" } ] }
    ]
})"_json;

// ASYMMETRIC with the ids of its two llms swapped
const auto ASYMMETRIC_SWAPPED = R"({
    "source": "chat",
    "components": [
        { "id": "chat", "provider": "chat" },
        { "id": "y", "provider": "llm_openai",
          "input": [ { "lane": "questions", "from": "chat" } ] },
        { "id": "x", "provider": "llm_openai",
          "input": [ { "lane": "questions", "from": "chat" } ] },
        { "id": "y_out", "provider": "response_text",
          "input": [ { "lane": "answers", "from": "y" } ] },
        { "id": "x_out", "provider": "response_answers",
          "input": [ { "lane": "answers", "from": "x" } ] }
    ]
})"_json;

// An agent invoked over data, its llm and two tools invoked over control,
// plus a component nobody reaches
const auto AGENT = R"({
    "source": "chat",
    "components": [
        { "id": "chat", "provider": "chat" },
        { "id": "agent", "provider": "agent_crewai",
          "input": [ { "lane": "questions", "from": "chat" } ] },
        { "id": "tool_b", "provider": "tool_http",
          "control": [ { "classType": "tool", "from": "agent" } ] },
        { "id": "brain", "provider": "llm_openai",
          "control": [ { "classType": "llm", "from": "agent" } ] },
        { "id": "tool_a", "provider": "tool_python",
          "control": [ { "classType": "tool", "from": "agent" } ] },
        { "id": "orphan", "provider": "llm_openai" }
    ]
})"_json;
}  // namespace

TEST_CASE("store::pipelineStack") {
    using engine::store::computePipelineStack;

    // The canonical order does not follow ids, file order or edge order, and
    // the hash ignores ids, names, configuration and UI data
    SECTION("same shape, shuffled ids and order: same stack and hash") {
        auto first = computePipelineStack(CHAIN, "hook");
        auto second = computePipelineStack(CHAIN_SHUFFLED, "src_9");
        REQUIRE_NO_ERROR(first);
        REQUIRE_NO_ERROR(second);

        REQUIRE(providersOf(*first) == providersOf(*second));
        REQUIRE(first->hash == second->hash);
        REQUIRE(first->hash.size() == 64);

        // Index 0 is the source; the parse step follows it
        REQUIRE(first->components[0].id == "hook");
        REQUIRE(second->components[0].id == "src_9");
        REQUIRE(indexOf(*first, "parse") == indexOf(*second, "a_parser"));
        REQUIRE(indexOf(*first, "llm") == indexOf(*second, "z_answer"));
        REQUIRE(indexOf(*first, "store") == indexOf(*second, "q_vectors"));

        // The wiring is by stack index: the same rows on both
        for (size_t i = 0; i < first->components.size(); ++i) {
            REQUIRE(first->components[i].inputs ==
                    second->components[i].inputs);
            REQUIRE(first->components[i].controls ==
                    second->components[i].controls);
        }
    }

    // A data consumer is walked by lane name first: 'questions' sorts before
    // 'text', so the llm comes before the embedder off the parser
    SECTION("consumers walk by lane name") {
        auto stack = computePipelineStack(CHAIN, "hook");
        REQUIRE_NO_ERROR(stack);
        REQUIRE(indexOf(*stack, "llm") < indexOf(*stack, "embed"));
        REQUIRE(indexOf(*stack, "embed") < indexOf(*stack, "store"));
    }

    // Symmetric branches: the shape cannot tell them apart, the hash is one
    SECTION("symmetric branches hash the same") {
        auto first = computePipelineStack(SYMMETRIC, "chat");
        auto second = computePipelineStack(SYMMETRIC_SWAPPED, "c");
        REQUIRE_NO_ERROR(first);
        REQUIRE_NO_ERROR(second);
        REQUIRE(providersOf(*first) == providersOf(*second));
        REQUIRE(first->hash == second->hash);

        // Each response follows its own llm in both
        for (const auto *stack : {&*first, &*second}) {
            for (const auto &entry : stack->components) {
                if (entry.provider != "response_answers") continue;
                REQUIRE(entry.inputs.size() == 1);
                REQUIRE(stack->components[entry.inputs[0].first].provider ==
                        "llm_openai");
            }
        }
    }

    // Two components tied on lane and provider are ordered by their canonical
    // form, so swapping their ids moves the indexes with the shape
    SECTION("canonical form breaks a lane and provider tie") {
        auto first = computePipelineStack(ASYMMETRIC, "chat");
        auto second = computePipelineStack(ASYMMETRIC_SWAPPED, "chat");
        REQUIRE_NO_ERROR(first);
        REQUIRE_NO_ERROR(second);
        REQUIRE(first->hash == second->hash);
        REQUIRE(indexOf(*first, "x") == indexOf(*second, "y"));
        REQUIRE(indexOf(*first, "x_out") == indexOf(*second, "y_out"));
    }

    // The invoked components join after the data walk, by classType then
    // provider; a component nobody reaches is not in the stack
    SECTION("controls join by classType then provider") {
        auto stack = computePipelineStack(AGENT, "chat");
        REQUIRE_NO_ERROR(stack);
        REQUIRE(providersOf(*stack) ==
                std::vector<std::string>{"chat", "agent_crewai", "llm_openai",
                                         "tool_http", "tool_python"});
        REQUIRE(indexOf(*stack, "orphan") == -1);

        // The llm's control edge names the agent by its index
        const auto &brain = stack->components[indexOf(*stack, "brain")];
        REQUIRE(brain.controls ==
                std::vector<std::pair<int, std::string>>{{1, "llm"}});
    }

    // The wiring is the shape: another lane is another hash
    SECTION("a lane change changes the hash") {
        auto changed = CHAIN;
        changed["components"][1]["input"][0]["lane"] = "documents";
        auto first = computePipelineStack(CHAIN, "hook");
        auto second = computePipelineStack(changed, "hook");
        REQUIRE_NO_ERROR(first);
        REQUIRE_NO_ERROR(second);
        REQUIRE(first->hash != second->hash);
    }

    // A provider change is another shape
    SECTION("a provider change changes the hash") {
        auto changed = CHAIN;
        changed["components"][4]["provider"] = "llm_anthropic";
        auto first = computePipelineStack(CHAIN, "hook");
        auto second = computePipelineStack(changed, "hook");
        REQUIRE_NO_ERROR(first);
        REQUIRE_NO_ERROR(second);
        REQUIRE(first->hash != second->hash);
    }

    // avoidMocks changes the engine's environment, so it is in the hash
    SECTION("avoidMocks is in the hash") {
        auto mocked = CHAIN;
        mocked["avoidMocks"] = true;
        auto first = computePipelineStack(CHAIN, "hook");
        auto second = computePipelineStack(mocked, "hook");
        REQUIRE_NO_ERROR(first);
        REQUIRE_NO_ERROR(second);
        REQUIRE(first->hash != second->hash);
    }

    // Two components with one id cannot be walked
    SECTION("duplicate ids are refused") {
        auto duplicated = CHAIN;
        duplicated["components"][2]["id"] = "parse";
        auto refused = computePipelineStack(duplicated, "hook");
        REQUIRE(!refused);
    }

    // A stack member must name its provider
    SECTION("a member without a provider is refused") {
        auto unnamed = CHAIN;
        unnamed["components"][1]["provider"] = "";
        auto refused = computePipelineStack(unnamed, "hook");
        REQUIRE(!refused);
    }

    // A nodeless control call goes to the first target that accepts, in the
    // order the controls are wired, which follows the stack: two tools of
    // one classType are ordered by provider, never by id, so every holder
    // of a shape reaches the same tool first
    SECTION("tools of one classType are ordered by provider, not id") {
        auto renamed = AGENT;
        renamed["components"][2]["id"] = "z";  // tool_http
        renamed["components"][4]["id"] = "a";  // tool_python
        auto stack = computePipelineStack(renamed, "chat");
        REQUIRE_NO_ERROR(stack);
        REQUIRE(indexOf(*stack, "z") < indexOf(*stack, "a"));
        REQUIRE(stack->components[indexOf(*stack, "z")].provider ==
                "tool_http");

        auto original = computePipelineStack(AGENT, "chat");
        REQUIRE_NO_ERROR(original);
        REQUIRE(stack->hash == original->hash);
    }

    // The source is the endpoint, never a stack filter: an edge INTO it is
    // not built, so it is neither on its row nor in the hash; an edge out of
    // it is
    SECTION("edges into the source are not wiring") {
        auto looped = AGENT;
        json::Value back(json::objectValue);
        back["classType"] = "tool";
        back["from"] = "agent";
        looped["components"][0]["control"].append(back);
        json::Value fed(json::objectValue);
        fed["lane"] = "answers";
        fed["from"] = "agent";
        looped["components"][0]["input"].append(fed);

        auto first = computePipelineStack(AGENT, "chat");
        auto second = computePipelineStack(looped, "chat");
        REQUIRE_NO_ERROR(first);
        REQUIRE_NO_ERROR(second);
        REQUIRE(second->components[0].inputs.empty());
        REQUIRE(second->components[0].controls.empty());
        REQUIRE(providersOf(*first) == providersOf(*second));
        REQUIRE(first->hash == second->hash);

        // The agent's own input from the source is kept
        REQUIRE(second->components[1].inputs ==
                std::vector<std::pair<int, std::string>>{{0, "questions"}});
    }
}
