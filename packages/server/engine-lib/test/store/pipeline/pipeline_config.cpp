// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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

using namespace engine::store::pipeline;

TEST_CASE("PipelineConfig") {
    PipelineConfig config(R"({
        "pipeline": {
            "source": "source_1",
            "version": 1,
            "components": [
                {
                    "id": "source_1",
                    "provider": "filesys",
                    "config": {}
                },
                {
                    "id": "parse_1",
                    "provider": "parse",
                    "config": {
                        "profile": "default"
                    },
                    "input": [
                        {
                            "lane": "tags",
                            "from": "source_1"
                        }
                    ]
                },
                {
                    "id": "summarization_1",
                    "provider": "summarization",
                    "config": {},
                    "input": [
                        {
                            "from": "parse_1",
                            "lane": "text"
                        }
                    ]
                },
                {
                    "id": "llm_perplexity_1",
                    "provider": "llm_perplexity",
                    "config": {},
                    "control": [
                        {
                            "classType": "llm",
                            "from": "summarization_1"
                        }
                    ]
                },
                {
                    "id": "annotation_1",
                    "provider": "default",
                    "config": {}
                }
            ]
        }
    })"_json);

    SECTION("valid") { REQUIRE_NO_ERROR(config.validate()); }

    SECTION("root:invalid") {
        config.setRoot(json::Value{42});
        REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                      "Pipeline config must be an object");
    }

    SECTION("pipeline") {
        SECTION("missing") { config.root().removeMember("pipeline"); }

        SECTION("invalid") { config.root()["pipeline"] = 42; }

        REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                      "'pipeline' is missing or invalid");
    }

    if (!config.root().isObject() || !config.root().isMember("pipeline"))
        return;

    auto &pipeline = config.root()["pipeline"];

    SECTION("version:missing") {
        pipeline.removeMember("version");

        REQUIRE_NO_ERROR(config.validate());
        REQUIRE(pipeline.isMember("version"));
        REQUIRE(pipeline["version"] == IServices::VERSION);
    }

    SECTION("version:invalid") {
        pipeline["version"] = "one";

        REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                      "'pipeline.version' must be a number");
    }

    SECTION("version:unsupported") {
        SECTION("below") { pipeline["version"] = 0; }

        SECTION("avove") { pipeline["version"] = IServices::VERSION + 1; }

        REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                      "'pipeline.version' is unsupported");
    }

    SECTION("source:missing:optional") {
        pipeline.removeMember("source");

        SECTION("single") {
            // pass
        }

        SECTION("multiple") {
            pipeline["components"].append(R"({
                "id": "source_2",
                "provider": "filesys",
                "config": {}
            })"_json);

            pipeline["components"][1]["input"].append(R"({
                "lane": "tags",
                "from": "source_2"
            })"_json);
        }

        REQUIRE_NO_ERROR(config.validate(false));
        REQUIRE_FALSE(pipeline.isMember("source"));
        REQUIRE_FALSE(pipeline.isMember("chain"));
    }

    SECTION("source") {
        SECTION("missing:required") { pipeline.removeMember("source"); }

        SECTION("invalid") { pipeline["source"] = 42; }

        SECTION("empty") { pipeline["source"] = ""; }

        REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                      "'pipeline.source' must be a non-empty string");
    }

    SECTION("source:unknown") {
        pipeline["source"] = "unknown_source";

        REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                      "'pipeline.source' references unknown component id: "
                      "unknown_source");
    }

    SECTION("components") {
        SECTION("missing") { pipeline.removeMember("components"); }

        SECTION("invalid") { pipeline["components"] = 42; }

        REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                      "'pipeline.components' must be an array");
    }

    SECTION("component") {
        auto &comp = pipeline["components"][1];

        SECTION("invalid") {
            comp = 42;

            REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                          "Component must be an object");
        }

        SECTION("id") {
            SECTION("missing") { comp.removeMember("id"); }

            SECTION("invalid") { comp["id"] = 42; }

            SECTION("empty") { comp["id"] = ""; }

            REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                          "Component 'id' must be a non-empty string");
        }

        SECTION("provider") {
            SECTION("missing") { comp.removeMember("provider"); }

            SECTION("invalid") { comp["provider"] = 42; }

            SECTION("empty") { comp["provider"] = ""; }

            REQUIRE_ERROR(
                config.validate(), Ec::InvalidParam,
                "Component parse_1 'provider' must be a non-empty string");
        }

        SECTION("config") {
            SECTION("missing") { comp.removeMember("config"); }

            SECTION("invalid") { comp["config"] = 42; }

            REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                          "Component parse_1 missing 'config' object");
        }

        SECTION("profile") {
            SECTION("missing") { comp["config"].removeMember("profile"); }

            REQUIRE_NO_ERROR(config.validate());
        }

        SECTION("profile") {
            SECTION("invalid") { comp["config"]["profile"] = 42; }

            SECTION("empty") { comp["config"]["profile"] = ""; }

            REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                          "Component parse_1 config 'profile' must be a "
                          "non-empty string");
        }

        SECTION("id:duplicate") {
            pipeline["components"].append(R"({
                "id": "source_1",
                "provider": "filesys",
                "config": {}
            })"_json);

            REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                          "Duplicate component source_1");
        }

        SECTION("input") {
            SECTION("missing") {
                comp.removeMember("input");

                REQUIRE_NO_ERROR(config.validate());
            }

            SECTION("invalid") {
                comp["input"] = 42;

                REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                              "Component parse_1 input must be an array");
            }
        }

        SECTION("input") {
            auto &input = comp["input"][0];

            SECTION("invalid") {
                input = 42;

                REQUIRE_ERROR(
                    config.validate(), Ec::InvalidParam,
                    "Component parse_1 input entries must be objects");
            }

            SECTION("lane") {
                SECTION("missing") { input.removeMember("lane"); }

                SECTION("invalid") { input["lane"] = 42; }

                SECTION("empty") { input["lane"] = ""; }

                REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                              "Component parse_1 input 'lane' must be a "
                              "non-empty string");
            }

            SECTION("lane:unknown") {
                input["lane"] = "unknown_lane";

                REQUIRE_ERROR(
                    config.validate(), Ec::InvalidParam,
                    "Component parse_1 input has unknown lane unknown_lane");
            }

            SECTION("from") {
                SECTION("missing") { input.removeMember("from"); }

                SECTION("invalid") { input["from"] = 42; }

                SECTION("empty") { input["from"] = ""; }

                REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                              "Component parse_1 input 'from' must be a "
                              "non-empty string");
            }

            SECTION("from:unknown") {
                input["from"] = "unknown_source";

                REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                              "Component parse_1 input references unknown "
                              "component id: unknown_source");
            }
        }

        SECTION("control") {
            auto &comp = pipeline["components"][3];

            SECTION("missing") {
                comp.removeMember("control");

                REQUIRE_NO_ERROR(config.validate());
            }

            SECTION("invalid") {
                comp["control"] = 42;

                REQUIRE_ERROR(
                    config.validate(), Ec::InvalidParam,
                    "Component llm_perplexity_1 control must be an array");
            }
        }

        SECTION("control") {
            auto &comp = pipeline["components"][3];
            auto &control = comp["control"][0];

            SECTION("invalid") {
                control = 42;

                REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                              "Component llm_perplexity_1 control entries must "
                              "be objects");
            }

            SECTION("classType") {
                SECTION("missing") { control.removeMember("classType"); }

                SECTION("invalid") { control["classType"] = 42; }

                SECTION("empty") { control["classType"] = ""; }

                REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                              "Component llm_perplexity_1 control 'classType' "
                              "must be a non-empty string");
            }

            SECTION("from") {
                SECTION("missing") { control.removeMember("from"); }

                SECTION("invalid") { control["from"] = 42; }

                SECTION("empty") { control["from"] = ""; }

                REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                              "Component llm_perplexity_1 control 'from' must "
                              "be a non-empty string");
            }

            SECTION("from:unknown") {
                control["from"] = "unknown_source";

                REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                              "Component llm_perplexity_1 control references "
                              "unknown component id: unknown_source");
            }
        }
    }

    SECTION("cycle") {
        pipeline["components"].append(R"({
            "id": "summarization_2",
            "provider": "summarization",
            "config": {},
            "input": [
                {
                    "from": "summarization_1",
                    "lane": "text"
                }
            ]
        })"_json);

        // summarization_1
        pipeline["components"][2]["input"].append(R"({
            "from": "summarization_2",
            "lane": "text"
        })"_json);

        REQUIRE_ERROR(config.validate(), Ec::InvalidParam,
                      "Cycle detected in pipeline: "
                      "summarization_1-[text]->summarization_2-[text]->"
                      "summarization_1");
    }

    SECTION("component:unreachable") {
        pipeline["components"].append(R"({
            "id": "summarization_2",
            "provider": "summarization",
            "config": {}
        })"_json);

        REQUIRE_NO_ERROR(config.validate());
        REQUIRE(pipeline.isMember("chain"));
        auto &chain = pipeline["chain"];
        REQUIRE(chain.type() == json::ValueType::arrayValue);
        REQUIRE(chain.size() == 4);
        REQUIRE(_anyOf(chain, "source_1"));
        REQUIRE(_anyOf(chain, "parse_1"));
        REQUIRE(_anyOf(chain, "summarization_1"));
        REQUIRE(_anyOf(chain, "llm_perplexity_1"));
        REQUIRE_FALSE(_anyOf(chain, "summarization_2"));
    }

    // Unreachable Questions lane from Embedding - Sentence Transformer to HTTP
    // Results
    //
    //  +---------+     +---------------+     +---------------+
    //  +---------------+     +----------+ | Filesys |     | Parse         | |
    //  Preproc       |     | Embed         |     | HTTP Res |
    //  +---------+     +---------------+     +---------------+
    //  +---------------+     +----------+ | Data   (*)-->(*) Data - Text
    //  (*)-->(*) Text - Docs (*)-->(*) Docs   Docs ( )   ( ) ...     |
    //  +---------+     +---------------+     +---------------+
    //  +---------------+     +----------+
    //                                                             ( ) Qns Qns
    //                                                             (*)-->(*) Qns
    //                                                             |
    //                                                              +---------------+
    //                                                              +----------+
    //
    SECTION("lane:unreachable") {
        pipeline = R"({
            "source": "source_1",
            "components": [
                {
                    "id": "source_1",
                    "provider": "filesys",
                    "config": {}
                },
                {
                    "id": "parse_1",
                    "provider": "parse",
                    "config": {},
                    "input": [
                        {
                            "from": "source_1",
                            "lane": "tags"
                        }
                    ]
                },
                {
                    "id": "preproc_1",
                    "provider": "preprocessor_langchain",
                    "config": {},
                    "input": [
                        {
                            "from": "parse_1",
                            "lane": "text"
                        }
                    ]
                },
                {
                    "id": "embed_1",
                    "provider": "embedding_transformer",
                    "config": {},
                    "input": [
                        {
                            "from": "preproc_1",
                            "lane": "documents"
                        }
                    ]
                },
                {
                    "id": "response_1",
                    "provider": "response",
                    "config": {},
                    "input": [
                        {
                            "from": "embed_1",
                            "lane": "questions"
                        }
                    ]
                }
            ]
        })"_json;

        REQUIRE_NO_ERROR(config.validate());
        REQUIRE(pipeline.isMember("chain"));
        auto &chain = pipeline["chain"];
        REQUIRE(chain.type() == json::ValueType::arrayValue);
        REQUIRE(chain.size() == 4);
        REQUIRE(_anyOf(chain, "source_1"));
        REQUIRE(_anyOf(chain, "parse_1"));
        REQUIRE(_anyOf(chain, "preproc_1"));
        REQUIRE(_anyOf(chain, "embed_1"));
        REQUIRE_FALSE(_anyOf(chain, "response_1"));
    }

    SECTION("chain") {
        pipeline["components"].append(R"({
            "id": "source_2",
            "provider": "filesys",
            "config": {}
        })"_json);

        pipeline["components"][1]["input"].append(R"({
            "lane": "tags",
            "from": "source_2"
        })"_json);

        Text sourceId;
        SECTION("1") { sourceId = "source_1"; }
        SECTION("2") { sourceId = "source_2"; }
        pipeline["source"] = sourceId;

        REQUIRE_NO_ERROR(config.validate());
        REQUIRE(pipeline.isMember("chain"));
        auto &chain = pipeline["chain"];
        REQUIRE(chain.type() == json::ValueType::arrayValue);
        REQUIRE(chain.size() == 4);
        REQUIRE(_anyOf(chain, sourceId));
        REQUIRE(_anyOf(chain, "parse_1"));
        REQUIRE(_anyOf(chain, "summarization_1"));
        REQUIRE(_anyOf(chain, "llm_perplexity_1"));
    }
}
