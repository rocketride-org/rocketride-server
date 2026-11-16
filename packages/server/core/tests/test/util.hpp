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

namespace ap::test {

// Use these so you can do:
// REQUIRE_THROWS_WITH(..., Contains|EndsWith|...)
using Catch::Matchers::ContainsSubstring;
using Catch::Matchers::EndsWith;
using Catch::Matchers::StartsWith;

// Simple macro to break test case SECTIONs into subunits
#define SUBSECTION(description) LOG(Test, description);

// Wrappers for wrap Catch's macros with calls to _ts on the arguments
#define FAIL_MSG(...) FAIL(_ts(__VA_ARGS__))
#define SUCCEED_MSG(...) SUCCEED(_ts(__VA_ARGS__))

//-----------------------------------------------------------------------------
// A couple very useful macros to check to make sure that a result, if it
// is an Errror type, that it did not get an error, or the an ErrorOr type
// also did not get an error but actually received a value
//-----------------------------------------------------------------------------

inline const Error &__toError(const Error &err) { return err; }
template <class T>
inline const Error &__toError(const ErrorOr<T> &val) {
    return val.check();
}

#define REQUIRE_NO_ERROR(cond)                     \
    do {                                           \
        if (auto ccode = __toError(cond)) {        \
            INFO("REQUIRE_NO_ERROR( " #cond " )"); \
            FAIL_MSG(ccode);                       \
        }                                          \
    } while (false)

#define REQUIRE_ERROR(COND, CODE, ...)                                       \
    do {                                                                     \
        auto __actualError = __toError(COND);                                \
        auto __expectedError = APERR(CODE, __VA_ARGS__);                     \
        if (__actualError.code() != __expectedError.code() ||                \
            __expectedError.message() && !__actualError.message().contains(  \
                                             __expectedError.message())) {   \
            INFO("REQUIRE_ERROR( " #COND ", " #CODE ", " #__VA_ARGS__ " )"); \
            FAIL_MSG(__actualError);                                         \
        }                                                                    \
    } while (false)

#define REQUIRE_VALUE(cond, val)                          \
    do {                                                  \
        auto err = (cond);                                \
        if (auto ccode = err.check()) {                   \
            INFO("REQUIRE_VALUE( " #cond ", " #val " )"); \
            FAIL_MSG(ccode);                              \
        } else {                                          \
            INFO("REQUIRE_VALUE( " #cond ", " #val " )"); \
            REQUIRE(err.value() == val);                  \
        }                                                 \
    } while (false)

// Enable relevant logging for each unit test by default
inline static application::Opt Diag{"--diag", "0"};

// Configure Catch to break into the debugger when a unit test fails (on by
// default for debug builds)
inline static application::Opt Break{"--break", plat::IsDebug ? "1" : "0"};

inline bool isDiagnosticLoggingEnabled() noexcept { return _fs<bool>(*Diag); }

// Current Catch2 test name
inline Text currentTestName(bool normalizeForFilePath = false) noexcept {
    return Catch::getResultCapture().getCurrentTestName();
}

// Was the current Catch2 test requested explicitly at the command line?
inline bool isCurrentTestSpecifiedExplicitly() noexcept {
    const auto testName = currentTestName();
    for (size_t i = 1; i < application::cmdline().size(); ++i) {
        auto param = application::cmdline().at(i);
        // Is it a flag?
        if (param.startsWith('-')) {
            // Is it one of ours?  If so, no test name was specified; bail
            if (param.startsWith("--")) return false;
            // Otherwise, it's probably a Catch flag (e.g. -a); keep looking
        } else
            return param.equalsNoCase(testName);
    }
    return false;
}

inline auto datasetsPath() noexcept {
    auto path = application::execDir() / "datasets";
    ASSERTD_MSG(file::exists(path), "Datasets folder missing", path);
    return path;
}

inline auto newTestPath() {
    return application::execDir() / "test_files" /
           _ts(Format::HEX, crypto::randomNumber<uint16_t>());
}

inline file::Path &TestPath() noexcept {
    static file::Path path = newTestPath();
    return path;
}

// Gets the test files temp dir for the unit test
inline const auto &testPath() noexcept(false) {
    auto &path = TestPath();
    ASSERTD_MSG(!file::mkdir(path), "Failed to create path", path);
    return path;
}

inline auto testPath(const file::Path &requiredFile,
                     const file::Path &targetDir) noexcept {
    auto source = datasetsPath() / requiredFile;
    auto target = targetDir / requiredFile;
    try {
        if (file::exists(target)) *file::remove(target);

        *file::copy(source, target);
        LOG(Test, "Copied", source, "=>", target);
    } catch (const Error &ccode) {
        dev::fatality(_location, "Failed to copy", source, "=>", target, ccode);
    }
    return target;
}

inline auto testPath(const file::Path &requiredFile) noexcept {
    // By default, copy to test_files
    return testPath(requiredFile, testPath());
}

// Enable relevant logging for each unit if --diag=1 has been specified
using LogScope = Opt<util::Scope>;
template <typename... Levels>
LogScope enableTestLogging(Levels &&...levels) noexcept {
    if (!isDiagnosticLoggingEnabled()) return {};

    return log::enableLevelScope(levels...);
}

}  // namespace ap::test
