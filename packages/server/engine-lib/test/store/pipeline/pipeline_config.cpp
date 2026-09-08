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
                    "provider": "annotation",
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

    SECTION("version:upgrade:graph") {
        auto &component = pipeline["components"][4];

        SECTION("falkordb") {
            component["provider"] = "tool_falkordb";
            component["config"]["type"] = "tool_falkordb";

            REQUIRE_NO_ERROR(config.validate());
            REQUIRE(component["provider"] == "graph_falkordb");
            REQUIRE(component["config"]["type"] == "graph_falkordb");
        }

        SECTION("neo4j") {
            component["provider"] = "db_neo4j";

            REQUIRE_NO_ERROR(config.validate());
            REQUIRE(component["provider"] == "graph_neo4j");
            REQUIRE_FALSE(component["config"].isMember("type"));
        }

        REQUIRE(pipeline["version"] == IServices::VERSION);
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
}
