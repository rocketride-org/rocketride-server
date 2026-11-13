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

namespace ap::globber {

// This is a collection of matchers, it unifies them and
// provides an api that applies to all
template <typename MatchT>
class Group {
public:
    // Standard move/copy constructor defaults
    Group() = default;
    Group(const Group &) = default;
    Group &operator=(const Group &) = default;
    Group &operator=(Group &&) = default;

    // Add a matcher to this group, will prevent duplicates
    // from being added
    Error add(MatchT &&matcher) noexcept {
        if (!matcher.valid())
            return {Ec::InvalidParam, _location, "Invalid matcher", matcher};

        if (!util::anyOf(m_matchers, matcher))
            m_matchers.emplace_back(_mv(matcher));

        return {};
    }

    // Checks if the subject matches any of our matchers
    bool matches(TextView subject, uint32_t &flags) const noexcept {
        // See if any of our matchers were matched
        return util::anyOf(m_matchers, [&](const auto &matcher) noexcept {
            return matcher.matches(subject, flags);
        });
    }

    // Checks if the subject matches any of our matchers
    bool matches(TextView subject) const noexcept {
        uint32_t flags = 0;
        return matches(subject, flags);
    }

    // Expose underlying vector API's
    auto size() const noexcept { return m_matchers.size(); }
    auto empty() const noexcept { return m_matchers.empty(); }
    void clear() noexcept { m_matchers.clear(); }
    void reserve(size_t size) noexcept { m_matchers.reserve(size); }
    auto begin() const noexcept { return m_matchers.begin(); }
    auto end() const noexcept { return m_matchers.end(); }
    auto rbegin() const noexcept { return m_matchers.rbegin(); }
    auto rend() const noexcept { return m_matchers.rend(); }

    // Get a matcher at an index
    const auto &operator[](size_t index) const {
        ASSERTD_MSG(index < size(),
                    "Out of bounds request for matcher at index", index);
        return m_matchers[index];
    }

    // Explicit boolean operator, returns true if at least
    // one matcher is set in our matcher array
    explicit operator bool() const noexcept { return !empty(); }

    // Render these matches as a string
    template <typename Buffer>
    auto __toString(Buffer &buff, const FormatOptions &opts) const noexcept {
        return _tsbo(buff, opts, m_matchers);
    }

    // Load this match group from a json object
    static Error __fromJson(Group &group, const json::Value &val) noexcept {
        group.m_matchers.clear();

        if (val.isNull()) return {};

        if (!val.isArray())
            return {Ec::InvalidJson, _location,
                    "Expected array for match group", val.type()};

        for (json::ArrayIndex i = 0; i < val.size(); i++) {
            auto &entry = val[i];
            if (!entry.isString())
                return {Ec::InvalidParam, _location,
                        "Expected string for match entry index", i};
            auto &matcher = group.m_matchers.emplace_back(entry.asString());
            if (matcher.failed()) return matcher.ccode();
        }

        return {};
    }

private:
    // Where our MatchT instances live
    std::vector<MatchT> m_matchers;
};

}  // namespace ap::globber
