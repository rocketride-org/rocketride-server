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

//
//	Glob matcher class
//
#pragma once

namespace ap::globber {

// A glob is a precompiled pattern definition of
// type a-typical glob syntax, we used the BSD version
// as a guideline, also like regular expressions we pre-parse
// our glob expressions to speed them up at compraison time
class Glob {
public:
    // Default definitions for move/assignment/construction
    Glob() = default;
    Glob(const Glob &) = default;
    Glob &operator=(const Glob &) = default;
    Glob &operator=(Glob &&) = default;

    //	Set this magic var to tell LOGT what level to use
    _const auto LogLevel = log::Lvl::Glob;

    // The mode defines the style of the glob, it lets us skip
    // parsing and just resort to comparisons, it also lets us
    // hold the invalid state as we won't throw during parsing
    // on construction
    //
    // Mode::INIT
    // Default state post construction, indicates an un-initialized
    // glob rule
    //
    // Mode::INVALID
    // This mode indicates a failure in the glob parsing logic
    //
    // Mode::STARTS_WITH
    // A glob with either a leading asterix, means we can just
    // call startsWith on it
    //
    // Mode::ENDS_WITH
    // A glob with either a trailing asterix, means we can just
    // call endsWith on it
    //
    // Mode::CONTAINS
    // A leading and traily any glob within an exact was detected
    //
    // Type::ALWAYS_MATCHED
    // When we detect a rule thats count of one and of type
    // ANY_MANY we don't even bother parsing the strings
    // and we set this type
    //
    // Mode::GLOB
    // A glob with one or more rules in it we'll have to parse this
    // one when we do a isMatched
    APUTIL_DEFINE_ENUM_C(Mode, 0, 8, INIT = _begin, INVALID, STARTS_WITH,
                         ENDS_WITH, CONTAINS, ALWAYS_MATCHED, GLOB, GLOB_EXACT);

    // Public api
    Glob(Text expression, uint32_t flags,
         bool caseAware = plat::PathCaseMode) noexcept;

    Mode mode() const noexcept;
    Error ccode() const noexcept;

    TextView pattern() const noexcept;
    uint32_t flags() const noexcept;
    bool caseAware() const noexcept;

    bool failed() const noexcept;
    bool valid() const noexcept;

    explicit operator bool() const noexcept;
    bool operator==(const Glob &matcher) const noexcept;

    // Checks for a match against a subject string
    bool matches(TextView subject, uint32_t &flags) const noexcept {
        ASSERT_MSG(valid(), "Match on invalid glob:", *this);

        // Return the flags for this glob
        flags = m_flags;

        // Based on the mode
        switch (mode()) {
            case Mode::INVALID:
            case Mode::INIT:
                return false;

            case Mode::ALWAYS_MATCHED:
                return true;

            case Mode::CONTAINS:
                return subject.contains(m_rules[m_modeIndex].value,
                                        m_caseAware);

            case Mode::STARTS_WITH:
                return subject.startsWith(m_rules[m_modeIndex].value,
                                          m_caseAware);

            case Mode::ENDS_WITH:
                return subject.endsWith(m_rules[m_modeIndex].value,
                                        m_caseAware);

            default:
                if (m_caseAware)
                    return glob<string::Case, GlobFlags::LEADING_DIR>(m_pattern,
                                                                      subject);
                else
                    return glob<string::NoCase, GlobFlags::LEADING_DIR>(
                        m_pattern, subject);
        }
    }

    // Checks for a match against a subject string - used when flags are not
    // needed
    bool matches(TextView subject) const noexcept {
        uint32_t flags = 0;
        return matches(subject, flags);
    }

    // Adapter method for rendering to a string
    template <typename Buffer>
    void __toString(Buffer &buff) const noexcept {
        if (failed())
            buff << m_mode << " " << m_parseCcode;
        else
            buff << string::enclose(m_pattern);
    }

    decltype(auto) rule(size_t index) const noexcept { return m_rules[index]; }

    decltype(auto) ruleCount() const noexcept { return m_rules.size(); }

    // Define types that identify each glob rule we support
    struct Rule {
        // Define the type of rules, each type defines how we'll
        // intepret the glob and whether we decide to set the Glob
        // mode to RULE or one of the other ones etc.
        //
        // Type::INVALID
        // We failed to parse the rule, value contains the reason message
        //
        // Type::EXACT
        // An exact match with no special syntax, e.g. 'abc'
        //
        // Type::RANGE
        // A non negated range specifier, e.g. '[a-b]' or '[abcd]'
        //
        // Type::RANGE_NEGATE
        // A negated range specifier, e.g. '[!a-b]' or '[^abcd]'
        //
        // Type::ANY_MANY
        // An asterix specifier indicating match any number of characters
        // e.g. '*'
        //
        // Type::ANY_ONE
        // This is the question mark, it means only match on character
        // of any value
        APUTIL_DEFINE_ENUM_C(Type, 0, 8, INVALID = _begin, EXACT, RANGE,
                             RANGE_NEGATE, ANY_MANY, ANY_ONE);

        // Boolean cast equates to a valid check
        explicit operator bool() const noexcept {
            return type != Type::INVALID;
        }

        // Connect to the pack system to render this as a string
        template <typename Buffer>
        auto __toString(Buffer &buff) const noexcept {
            return _tsb(buff, "Glob-", type, " ", string::enclose(value));
        }

        // Type - defines the state of this rule
        Type type = Type::INVALID;

        // Value - holds the parsed portion of the glob rule, will be
        // normalized e.g. *** = *
        Text value;

        // These chrs are used in the range case, if the range is not
        // a set of explicit characters, this will have the first
        // character and last to match a range between
        TextChr rangeStart = '\0', rangeEnd = '\0';
    };

private:
    // Alias a container for rules as Rules
    using Rules = std::vector<Rule>;

    // Define our pattern cursor, it keeps tabs on rule boundaries
    // and stashes state and hold the regex vector as we build  it up
    struct Cursor {
        // Upon construction the cursor steps once and sets last/current
        // characters
        Cursor(TextView str) noexcept : m_iter(str) {
            // Set initial state
            m_currentChr = *m_iter;
        }

        // Whenever the cursor advances, the current chr becomes the
        // last chr, and then the current chr is set if the iterator
        // is not exhausted of characters
        decltype(auto) advance(size_t distance = 1) {
            ASSERT_MSG(m_iter, _location,
                       "Attempt to advance a glob iterator beyond end");

            m_lastChr = *m_iter;
            std::advance(m_iter, distance);
            m_position += distance;
            if (m_iter)
                return m_currentChr = *m_iter;
            else
                return m_currentChr = '\0';
        }

        // The valid check for the cursor returns true if the
        // cursor has more room in it for advancing
        auto valid() const noexcept { return m_iter.size() > 0; }

        // Current returns the current character
        auto current() const noexcept { return m_currentChr; }

        // Last returns the last character
        auto last() const noexcept { return m_lastChr; }

        // Position returns the position
        auto position() const noexcept { return m_position; }

        // Checks if the las character is an escape character, which
        // means the current character should not be considered a rule
        // boundary
        bool isEscaped() const noexcept { return valid() && m_lastChr == '\\'; }

        // This api checks if we're at a rule boundary, this is used when
        // rules iterate the cursor as they consume their info, they
        // stop when this reports that a new rule boundary has been found
        auto isRuleBoundary() const noexcept {
            // We're at a rule boundary if the current character matches
            // any in the rule chars registry, and the last character
            // is not an escape
            if (isEscaped()) return false;

            switch (m_currentChr) {
                case '[':
                case '*':
                case '?':
                    return true;
                default:
                    return false;
            }
        }

        // We use DataView as the iterator
        memory::DataView<const TextChr> m_iter;

        // Last chr is stashed before we advance
        TextChr m_lastChr = '\0';

        // Current chr is where we're currently at
        TextChr m_currentChr = '\0';

        // Position is updated as we increment and it represents our
        // distance from the start of the string we're parsing
        size_t m_position = 0;
    };

    // Internal api
    bool ruleMatch(TextView subject) const noexcept;
    Rule loadExact(Cursor &cursor) const noexcept;
    Rule loadAny(Cursor &cursor) const noexcept;
    Rule loadRange(Cursor &cursor) const noexcept;

    Error init() noexcept;
    size_t countEscaped(TextView str,
                        Opt<TextChr> additional = {}) const noexcept;

    // The mode of the glob accelerates matching as it guides us on whether
    // we have to parse the entire string or not
    Mode m_mode = Mode::INIT;

    // For certain modes we point to the mode index for reference
    size_t m_modeIndex;

    // Pattern holds the original patterh we constructed from, any other
    // string in any other rull references this through a view
    Text m_pattern;

    // If we fail to init we'll set this error with a description of the
    // failure
    Error m_parseCcode;

    uint32_t m_flags;

    // We store the parsed result of the glob components here
    Rules m_rules;

    // Case aware flag for the glob match
    bool m_caseAware;
};

}  // namespace ap::globber
