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

#include <engLib/store/filters/classify/classifyDllLoader.hpp>

namespace engine::task::validateRegex {

using namespace engine::store::filter::classifyLoader;

//-------------------------------------------------------------------------
/// @details
///		Define the  task interface class which is the basis of all jobs
///		in the engine
/// 		Validate currently checks either:
///				PCRE regex [APPLAT-1056]
//-------------------------------------------------------------------------
class Task : public ITask {
public:
    using Parent = ITask;
    using Parent::Parent;

    //-----------------------------------------------------------------
    /// @details
    ///		Our log level for LOGT macros
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::JobValidate;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<Task, ITask>("validate");

protected:
    //-----------------------------------------------------------------
    /// @details
    ///		Report the validation results via the >INF
    ///	@param[in] 	result
    ///		The results to send back
    //-----------------------------------------------------------------
    void reportValidationResult(const json::Value &result) noexcept {
        ASSERT_MSG(result.isMember("valid"), "Validation result is not valid",
                   result);
        MONITOR(info, "result", result);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Reports validation failure to monitor; includes
    ///		the error chain. Return an empty error for easy chaining
    ///	@param[in] 	errorCode
    ///		The error code string
    ///	@param[in] 	errorMessage
    ///		The error message
    ///	@param[in] 	errorOffset
    ///		Optional offset where the error occurred
    //-----------------------------------------------------------------
    Error reportValidationFailed(TextView errorCode, TextView errorMessage,
                                 Opt<int> errorOffset = std::nullopt) noexcept {
        LOGT("Regular expression is invalid:", errorMessage);

        json::Value result;
        result["valid"] = false;
        result["error"] = _tj(errorCode);
        result["explanation"] = _tj(errorMessage);

        if (errorOffset) result["position"] = *errorOffset;

        reportValidationResult(result);
        return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Reports validation failure to monitor; includes
    ///		the error chain. Return an empty error for easy chaining
    ///	@param[in] 	ccode;
    ///		The error code to return
    //-----------------------------------------------------------------
    void reportValidationSucceeded() noexcept {
        LOGT("Regular expression is valid");

        json::Value result;
        result["valid"] = true;

        reportValidationResult(result);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Execute the task
    //-----------------------------------------------------------------
    Error exec() noexcept override {
        auto &config = jobConfig();
        auto regex = config["config"].lookup<Text>("regex");
        LOGT("Validating regex:", regex);

        // Ensure classification DLL is loaded
        auto &loader = classifyDll();
        if (!loader.isLoaded()) {
            if (auto ccode = loader.init())
                return APERRT(ccode, "Failed to load classification DLL");
        }

        const ClassifyApi *api = loader.api();
        if (!api)
            return APERRT(Ec::Classify, "Classification API not available");

        // Create engine for validation
        ClassifyEngineHandle engine = nullptr;
        const char *configJson = R"({"policies": []})";

        // Pass execDir and cachePath separately (DLL can't access host's
        // application/config)
        ClassifyResult result = api->engine_create(
            configJson, CLASSIFY_FLAG_NONE, Text{application::execDir()}.data(),
            Text{config::paths().cache}.data(), &engine);
        if (result != CLASSIFY_OK) {
            const char *error = api->get_last_error();
            return APERRT(Ec::Classify,
                          "Failed to create classification engine",
                          error ? error : "unknown error");
        }

        // Validate the regex using the DLL
        result = api->validate_regex(engine, regex.c_str());

        // Destroy engine (we're done with it)
        api->engine_destroy(engine);

        if (result == CLASSIFY_OK) {
            // Regex is valid
            reportValidationSucceeded();
        } else if (result == CLASSIFY_ERR_INVALID_PARAM) {
            // Regex is invalid - get error message via get_last_error
            const char *error = api->get_last_error();
            Text errorMessage = error ? error : "Invalid regex";
            LOGT("Classify regex validation failed:", errorMessage);

            // Try to parse position from error message if available
            // Format may be: "error at position N: message"
            Opt<int> errorOffset = std::nullopt;

            reportValidationFailed("REGEX_INVALID"_tv, errorMessage,
                                   errorOffset);
        } else {
            // Unexpected error
            const char *lastError = api->get_last_error();
            return APERRT(Ec::Classify, "Regex validation failed unexpectedly",
                          lastError ? lastError : "unknown error");
        }

        return {};
    }
};
}  // namespace engine::task::validateRegex
