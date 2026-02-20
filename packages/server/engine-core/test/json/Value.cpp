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

TEST_CASE("json::Value") {
    SECTION("null") {
        json::Value val;
        auto val2 = _tj(val);
        auto val3 = _fj<json::Value>(val2);
        REQUIRE(val3 == val);
    }

    SECTION("basic") {
        json::Value json;

        REQUIRE(!json.parse(R"cmd({
				"command": "store",
					"config" : {
						"enableVSS": false,
						"applId": "47f303f7-appl-43e3-b624-a40efc8d3c0b",
						"applName": "My Appliance",
						"nodeId": "562eaa09-agnt-4fde-807e-baee300db1b9",
						"nodeName": "My Node",
						"trace": "64"
					},
					"type" : "store",
					"description" : "Creating SN0",
					"startTime" : "1520434875",
					"executedOn" : "local-guid",
					"taskId" : 1,
					"setType" : "snapshot",
					"classification" : true,
					"enableClassification": true,
					"contentIndex" : true,
					"classifications": [
						{
							"classId": "rule1",
							"contains": [
								"$find(blaaa)"
							]
						}
					],
					"channelName" : "__local",
					"dataOutput" : "dataFile://patch/SN0",
					"dictOutput" : "datafile://dict/SN0",
					"include" : [
						"%TestFilesPath%"
					],
				"paths": {
					"control": "%RootPath%/control",
					"data": "%RootPath%/data",
					"log": "%RootPath%/logs",
					"cache": "%RootPath%/cache"
				},
				"searchPaths": [
					"datafile://search",
					"datadir://search"
				],
				"keyRing": [
					{
						"keyId": "1st",
						"token": "zLoMSvQ1E92ZdYCRaIVhGYa8i3gxJ2NZyLW2LylnzlzWSurHn4eTzvxoWVmavDeGadilBA30i8Z6qupwro233lMoeMXYJTU7buM/u2GPuwB1ATv28DMGIWFK8jZQXlQ0cKZL3RwTCfU7XC3rqjy8v0Y2d9P5jyMMI9geIBnWIQ0="
					},
					{
						"keyId": "1st",
						"token": "zLoMSvQ1E92ZdYCRaIVhGYa8i3gxJ2NZyLW2LylnzlzWSurHn4eTzvxoWVmavDeGadilBA30i8Z6qupwro233lMoeMXYJTU7buM/u2GPuwB1ATv28DMGIWFK8jZQXlQ0cKZL3RwTCfU7XC3rqjy8v0Y2d9P5jyMMI9geIBnWIQ0="
					}
				]
			})cmd"));

        LOG(Test, "{}", json);

        auto val = json.getKey("searchPaths");
        REQUIRE(val);
        REQUIRE(val->isArray());
        LOG(Test, "Paths:", *val);

        auto controlPath = json.text("paths.control");
        REQUIRE(controlPath == "%RootPath%/control");
    }

    SECTION("lookup") {
        json::Value json;
        json.parse(R"({
				"dateTimeHuman": "04/01/19 05:55:02",
				"dateTimeIntegral" : "1520434875",
				"dateTimeHex" : "0x5A9FFEBB",

				"boolTrue1": "yes",
				"boolTrue2": "true",
				"boolTrue3": true,
				"boolTrue4": 1,
				"boolTrue5": "1",
				"boolFalse1": "no",
				"boolFalse2": "false",
				"boolFalse3": false,
				"boolFalse4": 0,
				"boolFalse5": "0",

				"text": "Hi",
				"textEmpty": "",
				"textNull": null,

				"number1": "55",
				"number2": "0x055",
				"number3": "1,000,000",
				"number4": "0xFFFF:FFFF:FFFF",

				"number5": "-55",
				"number6": "-0x055",
				"number7": "-1,000,000",
				"number8": "-0xFFFF:FFFF:FFFF",

				"number9": "-55.01",
				"number10": "55.55",
				"number11": "1000000",

				"size1": "1MB",
				"size2": "10.5MB",
				"size3": "1024"
			})");

        SECTION("Text") {
            REQUIRE(json.lookup<Text>("text") == "Hi");
            REQUIRE(json.lookup<Text>("textEmpty") == "");
            REQUIRE(json.lookup<Text>("textNull") == "");
        }

        SECTION("Optional") {
            Opt<int> val;
            REQUIRE(!json.lookupAssign("number5", val));
            REQUIRE(*val == -55);

            val.reset();
            REQUIRE(!json.lookupAssign("missing", val));
            REQUIRE(!val);
        }

        SECTION("Boolean") {
            REQUIRE(json.lookup<bool>("boolTrue1") == true);
            REQUIRE(json.lookup<bool>("boolTrue2") == true);
            REQUIRE(json.lookup<bool>("boolTrue3") == true);
            REQUIRE(json.lookup<bool>("boolTrue4") == true);
            REQUIRE(json.lookup<bool>("boolTrue5") == true);

            REQUIRE(json.lookup<bool>("boolFalse1") == false);
            REQUIRE(json.lookup<bool>("boolFalse2") == false);
            REQUIRE(json.lookup<bool>("boolFalse3") == false);
            REQUIRE(json.lookup<bool>("boolFalse4") == false);
            REQUIRE(json.lookup<bool>("boolFalse5") == false);
        }

        SECTION("Numeric") {
            SECTION("uint64_t") {
                REQUIRE(json.lookup<uint64_t>("number1") == 55);
                REQUIRE(json.lookup<uint64_t>("number2") == 0x55);
                REQUIRE(json.lookup<uint64_t>("number3") == 1'000'000);
                REQUIRE(json.lookup<uint64_t>("number4") == 0xFFFFFFFFFFFF);
            }

            SECTION("Int") {
                REQUIRE(json.lookup<int64_t>("number5") == -55);
                REQUIRE(json.lookup<int64_t>("number6") == -0x55);
                REQUIRE(json.lookup<int64_t>("number7") == -1'000'000);
                REQUIRE(json.lookup<int64_t>("number8") == -0xFFFFFFFFFFFF);
            }

            SECTION("Double") {
                REQUIRE(json.lookup<double>("number9") == -55.01);
                REQUIRE(json.lookup<double>("number10") == 55.55);
                REQUIRE(json.lookup<double>("number11") == 1'000'000);
            }
        }

        SECTION("Size") {
            REQUIRE(json.lookup<Size>("size1") == 1_mb);
            REQUIRE(json.lookup<Size>("size2") == 10.5_mb);
            REQUIRE(json.lookup<Size>("size3") == 1_kb);
        }

        SECTION("Сase Insensitivity") {
            REQUIRE(json.lookup<Text>("text") == "Hi");
            REQUIRE(json.lookup<Text>("Text") == "Hi");
            REQUIRE(json.lookup<Text>("TEXT") == "Hi");
        }
    }

    SECTION("toData") {
        auto val = *json::parse(R"({
				"test": "yes"
			})");
        auto data = *_td(val);
        auto val2 = *_fd<json::Value>(data);
        REQUIRE(val == val2);
    }

    SECTION("Empty keys") {
        json::Value json;
        TextView empty;

        json[empty] = 4;
        REQUIRE(json.type() == json::ValueType::objectValue);
        REQUIRE(json.size() == 1);
        REQUIRE(json[empty] == 4);

        json[empty] = 5;
        REQUIRE(json.type() == json::ValueType::objectValue);
        REQUIRE(json.size() == 1);
        REQUIRE(json[empty] == 5);
    }
}
