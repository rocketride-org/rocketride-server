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
#include <apLib/ap.h>

namespace ap::globber {
int g_gmatchCount = 0;

// Constructs a new glob entry and parses the expression and defined
// the mode, the mode may be invalid so a check post construction
// is advised
Glob::Glob(Text expression, uint32_t flags, bool caseAware) noexcept
    : m_pattern(_mv(expression)), m_flags(flags), m_caseAware(caseAware) {
    if (m_parseCcode = init(); m_parseCcode) {
        LOGT("Error parsing glob pattern: {}", m_parseCcode);
        m_mode = Mode::INVALID;
    }
}

// Returns our pattern string
TextView Glob::pattern() const noexcept { return m_pattern; }

// Access the flags of glob
uint32_t Glob::flags() const noexcept { return m_flags; }

// Access the case aware flag of glob
bool Glob::caseAware() const noexcept { return m_caseAware; }

// Access the mode of glob
Glob::Mode Glob::mode() const noexcept { return m_mode; }

// Returns the error if one is set
Error Glob::ccode() const noexcept { return m_parseCcode; }

// Checks whether this glob had a failre during parsing
bool Glob::failed() const noexcept { return static_cast<bool>(m_parseCcode); }

// Checks whether the mode of this glob is Mode::INVALID or Mode::INIT
bool Glob::valid() const noexcept {
    return mode() != Mode::INVALID && mode() != Mode::INIT;
}

// Boolean operator equates to a valid check
Glob::operator bool() const noexcept { return valid(); }

// The equality operator checks the pattern value against
// the other glob
bool Glob::operator==(const Glob &matcher) const noexcept {
    return m_pattern == matcher.m_pattern && m_mode == matcher.m_mode &&
           m_caseAware == matcher.m_caseAware;
}

// Parses exact match characters
Glob::Rule Glob::loadExact(Cursor &cursor) const noexcept {
    Text exact = {cursor.current()};

    cursor.advance();

    while (cursor.valid() && !cursor.isRuleBoundary()) {
        exact += cursor.current();
        cursor.advance();
    }

    return Rule{Rule::Type::EXACT, _mv(exact)};
}

// Parses an any rule, which is ? or *, handles muliple stacked
// wilds and flattens them as needed
Glob::Rule Glob::loadAny(Cursor &cursor) const noexcept {
    bool many = false;
    bool one = false;

    while (cursor.valid()) {
        switch (cursor.current()) {
            case '*':
                one = false;
                many = true;
                cursor.advance();
                continue;

            case '?':
                cursor.advance();
                if (many) goto done;
                one = true;
                continue;
            default:
                goto done;
        }
    }

done:
    if (many) return Rule{Rule::Type::ANY_MANY, "*"};

    ASSERT(one);

    return Rule{Rule::Type::ANY_ONE, "?"};
}

// Counts ecaped characters in a string, and also allows for
// checking additional, non escaped characters to include them
// in the count
size_t Glob::countEscaped(TextView str,
                          Opt<TextChr> additional) const noexcept {
    bool escaped = false;
    size_t count = {};

    for (auto &chr : str) {
        if (chr == '\\')
            escaped = !escaped;
        else if (additional && chr == additional.value() && !escaped)
            count++;
        else if (escaped)
            count++;
    }

    return count;
}

// Parses a range rule, this is anything within []'s
Glob::Rule Glob::loadRange(Cursor &cursor) const noexcept {
    auto start = cursor;
    Text characters;
    TextChr rangeStart = '\0', rangeEnd = '\0';
    bool negation = false;
    bool range = false;

    while (cursor.valid()) {
        switch (cursor.current()) {
            case '\\':
                break;
            case '!':
            case '^':
                negation = true;
                break;
            case '-':
                if (characters.size() != 2)
                    return Rule{
                        Rule::Type::INVALID,
                        _ts("Too many characters in range:", characters)};
                characters += cursor.current();
                range = true;
                break;

            case ']':
                characters += cursor.current();
                goto done;

            default:
                characters += cursor.current();
                break;
        }

        cursor.advance();
    }

done:
    if (range) {
        if (characters.size() != 5)
            return Rule{Rule::Type::INVALID,
                        _ts("Too many characters in range:", characters)};
        cursor.advance();
        rangeStart = characters[1];
        rangeEnd = characters[3];
    }

    if (cursor.valid()) cursor.advance();

    if (negation)
        return Rule{Rule::Type::RANGE_NEGATE, _mv(characters), rangeStart,
                    rangeEnd};

    return Rule{Rule::Type::RANGE, _mv(characters), rangeStart, rangeEnd};
}

// Initializes the glob entry, this is called post construction,
// it parses the expression and sets the mode
Error Glob::init() noexcept {
    // If we have an empty expression then we are invalid
    if (!m_pattern) return {Ec::StringParse, _location, "Empty pattern"};

    // Walk the pattern, extract glob rules, until we run out of pattern
    // or encounter an error parsing a rule
    Rules globRules;
    auto cursor = Cursor{m_pattern};
    while (cursor.valid()) {
        Rule rule;

        switch (cursor.current()) {
            case '[':
                rule = loadRange(cursor);
                break;

            case '*':
            case '?':
                rule = loadAny(cursor);
                break;

            default:
                rule = loadExact(cursor);
                break;
        }

        if (!rule) return {Ec::StringParse, _location, "Glob: ", rule.value};

        globRules.emplace_back(_mv(rule));
    }

    // Stash the rules for processing the glob
    m_rules = _mv(globRules);

    // Now set our mode based on some obvious states
    if (m_rules.size() == 2 && m_rules[1].type == Rule::Type::ANY_MANY &&
        m_rules[0].type == Rule::Type::EXACT) {
        m_mode = Mode::STARTS_WITH;
        m_modeIndex = 0;
    } else if (m_rules.size() == 2 && m_rules[0].type == Rule::Type::ANY_MANY &&
               m_rules[1].type == Rule::Type::EXACT) {
        m_mode = Mode::ENDS_WITH;
        m_modeIndex = 1;
    } else if (m_rules.size() == 3 && m_rules[0].type == Rule::Type::ANY_MANY &&
               m_rules[1].type == Rule::Type::EXACT &&
               m_rules[2].type == Rule::Type::ANY_MANY) {
        m_mode = Mode::CONTAINS;
        m_modeIndex = 1;
        m_mode = Mode::GLOB;
    } else if (m_rules.size() == 1 && m_rules[0].type == Rule::Type::ANY_MANY) {
        m_mode = Mode::ALWAYS_MATCHED;
    } else if (m_rules.size() == 1 && m_rules[0].type == Rule::Type::EXACT) {
        m_mode = Mode::GLOB_EXACT;
    } else {
        m_mode = Mode::GLOB;
    }

    return {};
}

}  // namespace ap::globber
