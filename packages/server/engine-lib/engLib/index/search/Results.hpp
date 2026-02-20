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

#pragma once

namespace engine::index::search {

// An Opcode result stack used during execution for basic boolean logic
// calculations
class Results {
public:
    bool empty() const noexcept { return m_results.empty(); }

    // Resets the entire results context
    auto reset() noexcept { m_results.clear(); }

    // Push a boolean result onto the result stack
    auto pushResult(bool result) noexcept { m_results.push_back(result); }

    // Remove and return the last result from the result stack
    auto popResult() noexcept {
        ASSERT(!empty());
        bool result = m_results.back();
        m_results.pop_back();
        return result;
    }

    void evaluateNot() noexcept { pushResult(!popResult()); }

    void evaluateAnd() noexcept { pushResult(popResult() && popResult()); }

    void evaluateOr() noexcept { pushResult(popResult() || popResult()); }

    bool evaluateOpCode(OpCode opCode) noexcept {
        switch (opCode) {
            case OpCode::And:
                evaluateAnd();
                break;

            case OpCode::Or:
                evaluateOr();
                break;

            case OpCode::Not:
                evaluateNot();
                break;

            case OpCode::Done:
            case OpCode::Load:
                break;

            default:
                // Cannot evaluate op code
                return false;
        }

        // Evaluated op code successfully
        return true;
    }

    static bool canEvaluateOpCode(OpCode opCode) noexcept {
        return isLogicalOpCode(opCode) || isIgnoredOpCode(opCode);
    }

private:
    std::vector<bool> m_results;
};

}  // namespace engine::index::search
