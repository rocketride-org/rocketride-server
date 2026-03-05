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

namespace engine::match {
using namespace ap;
//-------------------------------------------------------------------------
/// @details
///		This struture is a location tracker keeping track of the position
///		within a string view
//-------------------------------------------------------------------------
struct MatchLocation {
    size_t offset = {};
    size_t length = {};

    bool operator<(const MatchLocation &other) const noexcept {
        if (offset != other.offset)
            return offset < other.offset;
        else
            return length < other.length;
    }

    bool operator==(const MatchLocation &other) const noexcept {
        return offset == other.offset && length == other.length;
    }

    bool operator!=(const MatchLocation &other) const noexcept {
        return !(*this == other);
    }

    void __toJson(json::Value &value) const noexcept {
        value["offset"] = offset;
        value["length"] = length;
    }

    static auto __fromJson(MatchLocation &location,
                           const json::Value &value) noexcept {
        return value.lookupAssign("offset", location.offset) ||
               value.lookupAssign("length", location.length);
    }

    template <typename Buffer>
    void __toString(Buffer &buff) const noexcept {
        buff << "Offset: " << offset << ", length: " << length;
    }
};

//-------------------------------------------------------------------------
/// @details
///		This struture holds the context of a match. The words before, the
///		match and the after words
//-------------------------------------------------------------------------
struct MatchContext {
    Text leading;
    Text match;
    Text trailing;

    void __toJson(json::Value &val) const noexcept {
        // Build the context as a JSON array of { leadingContext, matchContext,
        // trailingContext }
        val.append(leading);
        val.append(match);
        val.append(trailing);
    }
};

//-------------------------------------------------------------------------
/// @details
///		This holds the rule that we matched
//-------------------------------------------------------------------------
struct MatchedRule {
    TextView id;
    double confidence = {};
    std::vector<MatchLocation> locations;
};

//-------------------------------------------------------------------------
/// @details
///		This struture is a location tracker keeping track of the position
///		within a string view
//-------------------------------------------------------------------------
struct MatchedEvalCtxElement {
    TextView name;

    // location will be empty unless this is a string element
    MatchLocation location;
};

//-------------------------------------------------------------------------
/// @details
///		The policy that matched a classification
//-------------------------------------------------------------------------
struct MatchedPolicy {
    TextView id;
    TextView guid;
    TextView action;
    double confidence = {};
    std::vector<MatchedRule> matchedRules;
    std::vector<MatchedEvalCtxElement> matchedEvalCtxElements;
};

//-------------------------------------------------------------------------
/// @details
///		Contains all match information (used for classification)
//-------------------------------------------------------------------------
struct Match {
    // Pointers to matched classify policy and rule
    MatchedPolicy *pPolicy;
    MatchedRule *pRule;

    // Raw classify match location
    MatchLocation classifyLocation;

    // utf16 length/offset is the weird processing for javascript. Internally,
    // javascript converts our utf8 document into a utf16 series of code points.
    // It doesn't really handle this very well with chrs > 0x10000, which are
    // not in the BMP
    MatchLocation doc_utf16;

    // byte length/offset is the measured in bytes, not code points
    MatchLocation doc_bytes;

    // char offset is the actual number of chars, note code points or bytes
    // This is used for those systems that handle utf8 correctly
    MatchLocation doc_chars;

    // Matched leading, text and trailing contexts
    MatchContext context;

    // The text name for the policy
    Text policy;

    // The text name for the rule
    Text rule;
};

//-------------------------------------------------------------------------
// Define some high level types
//-------------------------------------------------------------------------
using MatchedPolicies = std::vector<MatchedPolicy>;
using MatchedRules = std::vector<match::MatchedRule>;
using Matches = std::vector<Match>;

}  // namespace engine::match
