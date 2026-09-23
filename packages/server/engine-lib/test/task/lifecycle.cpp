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

namespace {
class LifecycleTask final : public task::ITask {
public:
    LifecycleTask() : ITask({{}, json::Value()}) {}

    Error beginError;
    Error execError;
    Error endError;
    int begins = 0;
    int executions = 0;
    int ends = 0;

protected:
    Error beginTask() noexcept override {
        ++begins;
        return beginError;
    }
    Error exec() noexcept override {
        ++executions;
        return execError;
    }
    Error endTask() noexcept override {
        ++ends;
        return endError;
    }
};
}  // namespace

TEST_CASE("task::execute always ends a successfully begun task") {
    LifecycleTask task;

    SECTION("success") {}
    SECTION("execution failed") {
        task.execError = APERR(Ec::Failed, "Execution failed");
    }
    SECTION("execution cancelled") {
        task.execError = APERR(Ec::Cancelled, "Execution cancelled");
    }
    SECTION("teardown failed") {
        task.endError = APERR(Ec::InvalidParam, "Teardown failed");
    }
    SECTION("execution error takes precedence over teardown error") {
        task.execError = APERR(Ec::Cancelled, "Execution cancelled");
        task.endError = APERR(Ec::InvalidParam, "Teardown failed");
    }

    auto expected = task.execError || task.endError;
    auto result = task.execute();
    REQUIRE(result.code() == expected.code());
    REQUIRE(task.begins == 1);
    REQUIRE(task.executions == 1);
    REQUIRE(task.ends == 1);
}

TEST_CASE("task::execute does not end a task that failed to begin") {
    LifecycleTask task;
    task.beginError = APERR(Ec::Failed, "Initialization failed");
    auto result = task.execute();
    REQUIRE(result.code() == task.beginError.code());
    REQUIRE(task.begins == 1);
    REQUIRE(task.executions == 0);
    REQUIRE(task.ends == 0);
}
