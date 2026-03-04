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

inline ErrorOr<globber::Glob> compileGlob(const Text& pattern) noexcept {
    // Check for empty patterns (invalid)
    if (pattern.empty())
        return APERR(Ec::InvalidFormat,
                     "Glob search contained empty glob pattern");

    // Make the glob case-insensitive
    globber::Glob glob(pattern, false);
    if (glob.failed() || !glob.valid())
        return APERR(Ec::InvalidFormat, "Glob pattern is invalid", pattern);

    return glob;
}

inline ErrorOr<std::regex> compileRegularExpression(
    const Text& expression) noexcept {
    // Check for empty expressions (invalid)
    if (expression.empty())
        return APERR(Ec::InvalidFormat,
                     "Regular expression search contained empty expression");

    try {
        // Use ECMAScript syntax and case-insensitive matching
        return std::regex(expression, std::regex_constants::ECMAScript |
                                          std::regex_constants::icase |
                                          std::regex_constants::nosubs);
    } catch (std::regex_error& e) {
        return APERR(Ec::InvalidFormat, "Regular expression is invalid",
                     expression, e);
    }
}

inline ErrorOr<Text> likePatternToGlob(TextView pattern) noexcept {
    // Check for empty patterns (invalid)
    if (pattern.empty())
        return APERR(Ec::InvalidFormat, "LIKE search contained empty pattern");

    Text glob;
    glob.reserve(pattern.size());

    TextView::iterator lBracketPos = pattern.end();
    auto inBrackets = [&]() noexcept { return lBracketPos != pattern.end(); };

    for (auto it = pattern.begin(); it != pattern.end(); ++it) {
        switch (*it) {
            case '%':
                // Convert multiple-character wildcard '%' to '*' (if not in
                // brackets)
                if (!inBrackets())
                    glob += '*';
                else
                    glob += *it;
                break;

            case '_':
                // Convert single-character wildcard '_' to '?' (if not in
                // brackets)
                if (!inBrackets())
                    glob += '?';
                else
                    glob += *it;
                break;

            case '*':
            case '?':
                // Escape glob wildcards
                glob += '\\';
                glob += *it;
                break;

            case '[':
                lBracketPos = it;
                glob += *it;
                break;

            case ']':
                if (inBrackets()) {
                    // []] = escaped ']'
                    if (lBracketPos == it - 1) {
                        glob += "\\]"_tv;
                    } else {
                        lBracketPos = pattern.end();
                        glob += *it;
                    }
                } else
                    return APERR(Ec::InvalidFormat,
                                 "LIKE pattern contained mismatched ']'",
                                 pattern);
                break;

            case '^':
                // [^abc] -> [!abc]
                if (lBracketPos == it - 1)
                    glob += '!';
                else
                    glob += *it;
                break;

            default:
                glob += *it;
                break;
        }
    }
    return glob;
}

inline ErrorOr<globber::Glob> compileLikePattern(TextView pattern) noexcept {
    auto glob = likePatternToGlob(pattern);
    if (!glob) return glob.ccode();

    LOG(Search, "Converted LIKE pattern '{}' to glob '{}'", pattern, *glob);
    return compileGlob(*glob);
}

}  // namespace engine::index::search
