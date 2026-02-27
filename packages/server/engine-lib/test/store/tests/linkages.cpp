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

#include "../store.h"

//-----------------------------------------------------------------------------
//
// This set of tests focuses on the ability of a filter to pass things through
// when. Now,
//
//-----------------------------------------------------------------------------
TEST_CASE("store::linkages") {
    //-----------------------------------------------------------------
    // Define a class that we can use to get to the internals of
    // the IServiceFilterInstance internals to check the linkages
    //-----------------------------------------------------------------
    class ICheckFilterInstance : public IServiceFilterInstance {
        using Parent = IServiceFilterInstance;

    public:
        using Parent::filterLevel;
        using Parent::m_pIOBuffer;
        using Parent::m_pTagBuffer;
        using Parent::pDown;
        using Parent::pipeId;
    };

    //-----------------------------------------------------------------
    // Generic json config file - we are not actually going to
    // send data through this, but just instantiate all the filters
    // so we can check their pointers. We don't actually have to
    // do all of them since the linkages are maintained by the
    // pipe and the base class, but instantiate some things anyway
    //-----------------------------------------------------------------
#ifdef ENABLE_CLASSIFY
    auto task = R"(
        {
            "config": {
                "service": {
                    "filters": [
                        "pipe",
                        "hash",
                        "classify",
                        "null",
                        "bottom"
                    ],
                    "key": "null://Null",
                    "name": "Null endpoint",
                    "type": "null",
                    "mode": "source",
                    "parameters": {}
                }
            },
            "taskId": "2ebe800f-fe38-466b-99df-342fae761d77",
            "nodeId": "2e0ecc69-d129-4aa1-a3fe-b85843fec2e6"
        }
    )"_json;
#else
    auto task = R"(
        {
            "config": {
                "service": {
                    "filters": [
                        "pipe",
                        "hash",
                        "null",
                        "bottom"
                    ],
                    "key": "null://Null",
                    "name": "Null endpoint",
                    "type": "null",
                    "mode": "source",
                    "parameters": {}
                }
            },
            "taskId": "2ebe800f-fe38-466b-99df-342fae761d77",
            "nodeId": "2e0ecc69-d129-4aa1-a3fe-b85843fec2e6"
        }
    )"_json;
#endif

    //-----------------------------------------------------------------
    // Check the linkages to make sure endpoints points where it should,
    // up, down, bottom, top and levels as well. Makes sure we are
    // pointing to the current objects instead of multiple copies of
    // them
    //-----------------------------------------------------------------
    SECTION("check pointers") {
        //-------------------------------------------------------------
        // Create the endpoint
        //-------------------------------------------------------------
        auto config = task["config"];
        REQUIRE(config.isObject());

        // Get the service section
        auto service = config["service"];
        REQUIRE(service.isObject());

        // Get an endpoint
        auto endpoint =
            IServiceEndpoint::getTargetEndpoint({.jobConfig = task,
                                                 .taskConfig = config,
                                                 .serviceConfig = service});
        REQUIRE_NO_ERROR(endpoint);

        // Open the endpoint
        REQUIRE_NO_ERROR(endpoint->beginEndpoint(OPEN_MODE::SCAN));

        //---------------------------------------------------------
        // Get a pipe and check it and the globals linkages
        //---------------------------------------------------------
        SECTION("Checking forward linkages") {
            // Grab a pipe
            auto pipe = endpoint->getPipe();
            REQUIRE_NO_ERROR(pipe);

            // Note that we have to do some casting here so we can
            // access the private/protected members

            // Grab the first filter and set the previous one to null
            ICheckFilterInstance *pPipe = (ICheckFilterInstance *)pipe.get();
            ICheckFilterInstance *pPrev = (ICheckFilterInstance *)nullptr;
            size_t level = 0;

            // Walk down through the stack - note that we do not check
            // pDown as, if it is hosed, we are totally lost
            while (pPipe) {
                REQUIRE(pPipe->filterLevel == level++);

                pPrev = pPipe;
                pPipe = (ICheckFilterInstance *)pPipe->pDown.get();
            }

            // Release the pipe
            endpoint->putPipe(*pipe);
        }

        //---------------------------------------------------------
        // Get a pipe and check it and the globals linkages
        //---------------------------------------------------------
        SECTION("Checking back linkages") {
            // Grab a pipe
            auto pipe = endpoint->getPipe();
            REQUIRE_NO_ERROR(pipe);

            // Grab the first filter and set the previous one to null
            ICheckFilterInstance *pPipe = (ICheckFilterInstance *)pipe.get();
            ICheckFilterInstance *pPrev = (ICheckFilterInstance *)nullptr;

            // Find the bottom
            while (pPipe) {
                pPrev = pPipe;
                pPipe = (ICheckFilterInstance *)pPipe->pDown.get();
            }

            // Walk them all again and check the up bottom ptrs
            pPipe = (ICheckFilterInstance *)pipe.get();
            while (pPipe) {
                pPipe = (ICheckFilterInstance *)pPipe->pDown.get();
            }

            // Release the pipe
            endpoint->putPipe(*pipe);
        }

        //---------------------------------------------------------
        // Get a pipe and check it and the globals linkages
        //---------------------------------------------------------
        SECTION("Checking endpoint linkages") {
            // Grab a pipe
            auto pipe = endpoint->getPipe();
            REQUIRE_NO_ERROR(pipe);

            // No, check the globals
            // Grab the first filter and set the previous one to null
            ICheckFilterInstance *pPipe = (ICheckFilterInstance *)pipe.get();
            while (pPipe) {
                REQUIRE(pPipe->endpoint == *endpoint);
                REQUIRE(pPipe->pipe->endpoint == *endpoint);

                pPipe = (ICheckFilterInstance *)pPipe->pDown.get();
            }

            // Release the pipe
            endpoint->putPipe(*pipe);
        }

        //---------------------------------------------------------
        // Get a pipe and check it and the globals linkages
        //---------------------------------------------------------
        SECTION("Checking linkages") {
            // Grab a pipe
            auto pipe = endpoint->getPipe();
            REQUIRE_NO_ERROR(pipe);

            // Note that we have to do some casting here so we can
            // access the private/protected members

            // Grab the first filter and clear the previous one
            ICheckFilterInstance *pPipe = (ICheckFilterInstance *)pipe.get();
            ICheckFilterInstance *pPrev = (ICheckFilterInstance *)nullptr;
            size_t level = 0;

            // Walk down through the stack - note that we do not check
            // pDown as, if it is hosed, we are totally lost
            while (pPipe) {
                REQUIRE(pPipe->filterLevel == level++);
                REQUIRE(pPipe->endpoint == *endpoint);

                pPrev = pPipe;
                pPipe = (ICheckFilterInstance *)pPipe->pDown.get();
            }

            // No, check the globals
            pPipe = (ICheckFilterInstance *)pipe.get();
            while (pPipe) {
                REQUIRE(pPipe->pipe->endpoint == *endpoint);

                pPrev = pPipe;
                pPipe = (ICheckFilterInstance *)pPipe->pDown.get();
            }

            // Release the pipe
            endpoint->putPipe(*pipe);
        }

        // Close the endpoint
        REQUIRE_NO_ERROR(endpoint->endEndpoint());

        // Destroy the endpoint
        endpoint.reset();
    };
}
