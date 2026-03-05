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

namespace engine::index::search {

enum class OpCode : uint32_t {
    Invalid,

    // Implementation specific actions on tokens in the
    // op params
    In,      // find all words (and)
    Near,    // find near (within 10 words) of words all words (and)
    Any,     // find any of the words (or)
    Phrase,  // find words in the following order (all, in order)
    Glob,    // find words matching given glob expression
    Like,    // find words matching given SQL LIKE expression
    Regexp,  // find words matching given regex expression

    // Meta types, don't actually do anything but may logically
    // change the boolean outcome
    Load,
    And,
    Or,
    Not,
    Done,

    // Setup tags for iteration
    _end,
    _begin = In
};

inline constexpr bool isSearchOpCode(OpCode opCode) noexcept {
    switch (opCode) {
        case OpCode::In:
        case OpCode::Near:
        case OpCode::Any:
        case OpCode::Phrase:
        case OpCode::Glob:
        case OpCode::Like:
        case OpCode::Regexp:
            return true;

        default:
            return false;
    }
}

inline constexpr bool isLogicalOpCode(OpCode opCode) noexcept {
    switch (opCode) {
        case OpCode::And:
        case OpCode::Or:
        case OpCode::Not:
            return true;

        default:
            return false;
    }
}

inline constexpr bool isIgnoredOpCode(OpCode opCode) noexcept {
    switch (opCode) {
        case OpCode::Load:
        case OpCode::Done:
            return true;

        default:
            return false;
    }
}

inline constexpr size_t getOperandCount(OpCode opCode) noexcept {
    switch (opCode) {
        // Binary operators
        case OpCode::And:
        case OpCode::Or:
            return 2;

        // Unary operators
        case OpCode::Not:
            return 1;

        default:
            return 0;
    }
}

APUTIL_DEFINE_ENUM_ITER(OpCode)

_const Array<iTextView, EnumIndex(OpCode::_end)> OpCodeNames{
    iTextView{},        "engine.in"_tv,   "engine.near"_tv, "engine.any"_tv,
    "engine.phrase"_tv, "engine.glob"_tv, "engine.like"_tv, "engine.regexp"_tv,
    "engine.load"_tv,   "engine.and"_tv,  "engine.or"_tv,   "engine.not"_tv,
    "engine.done"_tv};

template <typename Buffer>
inline Error __toString(const OpCode &code, Buffer &buff) noexcept {
    auto index = EnumIndex(code);
    if (index >= EnumIndex(OpCode::_end) || index == EnumIndex(OpCode::Invalid))
        return APERR(Ec::InvalidParam, "Invalid op code", index);

    buff << OpCodeNames[index];

    return {};
}

template <typename Buffer>
inline Error __fromString(OpCode &code, const Buffer &buff) noexcept {
    iTextView name = buff.toView();
    if (auto pos = _findIf(OpCodeNames, name);
        pos != OpCodeNames.end() && pos != OpCodeNames.begin()) {
        code = EnumFrom<OpCode>(std::distance(OpCodeNames.begin(), pos));
        return {};
    }

    return APERR(Ec::InvalidParam, "Invalid op code name", name);
}

// Represents a compiled token of the search statement. This is the output
// from the compilation process
struct Op {
public:
    static auto __fromJson(Op &op, const json::Value &val) noexcept {
        return val.lookupAssign("opCode", op.opCode) ||
               val.lookupAssign("comment", op.comment) ||
               val.lookupAssign("params.words", op.words);
    }

    auto __toJson(json::Value &val) const noexcept {
        val["opCode"] = _tj(opCode);
        if (!words.empty()) val["params"]["words"] = _tj(words);
        if (comment) val["comment"] = comment;
    }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        return _tsb(buff, opCode, "(", words, ")");
    }

    OpCode opCode = {};
    std::vector<Text> words;
    Text comment;
};

// Alias a collection of ops
using Ops = std::vector<Op>;

}  // namespace engine::index::search
