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

//
//	Implementation of Format structure
//
#pragma once

namespace ap::string {

// The Format holds multiple specifiers and parses
// a single format string, inside it holds all the parsed specifiers
// representing every range of the format string, as well as
// a argument position lookup table.
template <size_t MaxFields = Format::DefMaxFields>
class FormatStr {
public:
    // Gotta declare a constructor for compile time stuff
    constexpr FormatStr() noexcept = default;
    constexpr FormatStr(TextView fmt) noexcept
        : m_fmt(fmt), m_info(parseFieldInfo()) {}

    // Declare a couple of types to distinguish between a failure to parse
    // and an unspecified group
    _const auto StatusBlank = std::numeric_limits<uint32_t>::max();
    _const auto StatusParseFailed = std::numeric_limits<uint32_t>::max() - 1;

    // The Specifier structure contains the information from the parsed
    // modifier portion in the format string and composes the user
    // flags as well as the width, while adjusting them as needed
    // based on the parse modifier info from the format string it is
    // constructed from.
    struct Specifier {
        // Declare the well known group indicies:
        // 	{GrpPosition, GrpMod, GrpWidth}
        _const size_t GrpPosition = 0;
        _const size_t GrpMod = 1;
        _const size_t GrpWidth = 2;
        _const size_t GrpMax = 3;

        // Our group array type
        using Groups = std::array<TextView, GrpMax>;

        // Define a constexpr constructor set
        constexpr Specifier() noexcept = default;
        constexpr Specifier(size_t defaultIndex, Groups groups) noexcept
            : m_groups(groups),
              m_position(parsePosition(defaultIndex)),
              m_flags(parseFlags()),
              m_width(parseWidth()) {
            // If we detect a width in the field its an implied fill
            // flag unlike the passed in defaults to the format api
            if (m_width != StatusParseFailed && m_width != StatusBlank &&
                m_width)
                m_flags |= Format::FILL;
        }

        constexpr bool valid() const noexcept {
            return m_position != StatusParseFailed &&
                   m_width != StatusParseFailed && m_flags != StatusParseFailed;
        }

        // Parses the width group numeric value
        constexpr size_t position() const noexcept { return m_position; }

        // Parses the flags group, merges in callers flags
        uint32_t flags() const noexcept { return m_flags; }

        // Parses the width group numeric value
        size_t width() const noexcept {
            return m_width == StatusBlank ? 0 : m_width;
        }

        // Parses the flags group, merges in callers flags
        FormatOptions options() const noexcept { return {flags(), width()}; }

    private:
        constexpr size_t parseNumber(TextView str) const noexcept {
            size_t result = StatusBlank;

            for (auto chr : str) {
                if (chr < '0' || chr > '9') return StatusParseFailed;
                if (result == StatusBlank) result = 0;
                result = (chr - '0') + result * 10;
            }

            return result;
        }

        constexpr size_t parseWidth() const noexcept {
            return parseNumber(m_groups[GrpWidth]);
        }

        constexpr size_t parsePosition(size_t defaultPosition) const noexcept {
            // Same with width
            if (m_groups[GrpPosition]) {
                auto pos = parseNumber(m_groups[GrpPosition]);

                if (pos == StatusBlank) return defaultPosition;

                if (pos >= MaxFields) return StatusParseFailed;

                return pos;
            }

            // Unspecified
            return defaultPosition;
        }

        // Parses the flags group, merges in callers flags
        constexpr uint32_t parseFlags() const noexcept {
            uint32_t flags = 0;

            // Loop through each character and parse the specification
            for (auto chr : m_groups[GrpMod]) {
                switch (chr) {
                    case Format::Mod::SIZE_HUMAN:
                        flags |= Format::SIZE_HUMAN;
                        continue;
                    case Format::Mod::COUNT_HUMAN:
                        flags |= Format::COUNT_HUMAN;
                        continue;
                    case Format::Mod::HEX_PREFIX:
                        flags |=
                            Format::ZEROFILL | Format::HEX | Format::PREFIX;
                        continue;
                    case Format::Mod::HEX_NO_PREFIX:
                        flags |= Format::ZEROFILL | Format::HEX;
                        continue;
                    case Format::Mod::ZERO_FILL:
                        flags |= Format::ZEROFILL;
                        continue;
                    case Format::Mod::RIGHT:
                        flags |= Format::RIGHT | Format::FILL;
                        continue;
                    case Format::Mod::NOFILL:
                        flags |= Format::NOFILL;
                        continue;
                    case Format::Mod::NOGROUP:
                        flags |= Format::NOGROUP;
                        continue;

                    default:
                        // Did not parse something, error
                        return StatusParseFailed;
                }
            }

            // Return the combined flags
            return flags;
        }

        Groups m_groups = {};
        size_t m_position = StatusParseFailed, m_width = StatusParseFailed;
        uint32_t m_flags = StatusParseFailed;
    };

    // Define the field, this is a portion of the format
    // string, it represents a range, it may or may not have a valid
    // specifier
    struct Field {
        // Constexpr structure populates our read only fields
        constexpr Field(const Field &) = default;
        constexpr Field() noexcept = default;

        constexpr Field(size_t fieldIndex, size_t start, size_t stop,
                        Specifier specifier = {}) noexcept
            : m_index(fieldIndex),
              m_start(start),
              m_stop(stop),
              m_specifier(specifier) {}

        constexpr size_t start() const noexcept { return m_start; }

        constexpr size_t stop() const noexcept { return m_stop; }

        constexpr size_t size() const noexcept { return m_stop - m_start; }

        constexpr auto specifier() const noexcept { return m_specifier; }

        constexpr size_t index() const noexcept { return m_index; }

        constexpr bool valid() const noexcept {
            return m_index != string::npos;
        }

        constexpr explicit operator bool() const noexcept { return valid(); }

    private:
        size_t m_index = string::npos;

        // This is the start position of the field
        size_t m_start = 0;

        // This is the start position of the field
        size_t m_stop = 0;

        // The specifier for this field (may be blank/invalid, ask it)
        Specifier m_specifier = {};
    };

    struct Positions {
        std::array<size_t, MaxFields> specToArg = {};
        std::array<size_t, MaxFields> argToSpec = {};
        std::array<size_t, MaxFields> specToField = {};
    };

    struct FieldInfo {
        // Shortcut to the fields array
        using Fields = std::array<Field, MaxFields>;

        Fields fields = {};
        Positions positions = {};

        bool allFieldsInOrder = true;
    };

    Specifier lookupSpecifier(size_t argPosition) const noexcept {
        // If its not in range just return a new one with their options
        if (argPosition >= MaxFields) return {};

        // May be there look it up
        auto specPos = m_info.positions.argToSpec[argPosition];
        auto fieldPos = m_info.positions.specToField[specPos];
        auto field = m_info.fields[fieldPos];
        return field.specifier();
    }

    constexpr Field field(size_t fieldIndex) const noexcept {
        if (fieldIndex >= MaxFields) return {};
        auto field = m_info.fields[fieldIndex];
        if (!field.valid() || field.index() != fieldIndex) return {};
        return field;
    }

    auto fieldStr(const Field &field) const noexcept {
        auto beg = m_fmt.begin() + field.start();
        return TextView{&(*beg), field.size()};
    }

    constexpr auto allFieldsInOrder() const noexcept {
        return m_info.allFieldsInOrder;
    }

    auto positions() const noexcept { return m_info.positions; }

private:
    constexpr size_t find_last_of(TextView string, size_t startPosition,
                                  char chr,
                                  size_t lastPosition) const noexcept {
        // Walk backwards from the end of the range and find the first
        // occurrence of the character
        auto start = string.data() + startPosition;
        auto end = string.data() + std::min(string.size(), lastPosition);
        for (auto ptr = end - 1; ptr >= start; --ptr) {
            if (*ptr == chr) return ptr - string.data();
        }

        return npos;
    }

    // Constructs a format specifier group, does not extract any
    // data from their strings, this is to ensure we can remain
    // completely compile time compatible
    constexpr FieldInfo parseFieldInfo() const noexcept {
        FieldInfo info = {};

        if (!m_fmt) return info;

        // Walk the format and add specifiers as we find delimiters
        size_t nextFieldIndex = 0, nextSpecifierIndex = 0;
        size_t cursor = 0;
        size_t end = m_fmt.size();
        while (cursor < end && nextFieldIndex < MaxFields) {
            // Look for the first ending delimiter
            auto endOfSpecifier = m_fmt.find_first_of('}', cursor);
            if (endOfSpecifier == npos) {
                // Invalid, just add it as a range
                info.fields[nextFieldIndex] = {nextFieldIndex, cursor,
                                               m_fmt.size()};
                nextFieldIndex++;
                break;
            }

            // Now starting at the endOfSpecifier position, go backwards
            // until we find the first leading delimiter
            auto startOfSpecifier =
                find_last_of(m_fmt, cursor, '{', endOfSpecifier);
            ;
            if (startOfSpecifier == npos) {
                // Invalid, just add it as a range and keep going, may be
                // some valid ones in here yet
                info.fields[nextFieldIndex] = {nextFieldIndex, cursor,
                                               endOfSpecifier + 1};
                nextFieldIndex++;
                cursor = endOfSpecifier + 1;
                continue;
            }

            if (cursor != startOfSpecifier) {
                // Add the previously invalid one here
                info.fields[nextFieldIndex] = {nextFieldIndex, cursor,
                                               startOfSpecifier};
                nextFieldIndex++;
            }

            // Potentially valid check for specifier possibility
            if (m_fmt[startOfSpecifier] != '{' ||
                m_fmt[endOfSpecifier] != '}') {
                // No specifier here just add a field back
                info.fields[nextFieldIndex] = {nextFieldIndex, startOfSpecifier,
                                               endOfSpecifier + 1};
                nextFieldIndex++;
            } else {
                auto groupStart = startOfSpecifier + 1;
                auto groupsStr =
                    m_fmt.substr(groupStart, endOfSpecifier - groupStart);

                // May be a field here, split the groups and construct one
                auto specifier = Specifier{
                    nextSpecifierIndex,
                    view::tokenizeArray<Specifier::GrpMax>(groupsStr, ',')};

                if (specifier.valid()) {
                    info.fields[nextFieldIndex] = {
                        nextFieldIndex, startOfSpecifier, endOfSpecifier + 1,
                        specifier};
                    info.positions.specToArg[specifier.position()] =
                        nextSpecifierIndex;
                    info.positions.argToSpec[nextSpecifierIndex] =
                        specifier.position();
                    info.positions.specToField[specifier.position()] =
                        nextFieldIndex;

                    if (nextSpecifierIndex != specifier.position())
                        info.allFieldsInOrder = false;

                    nextSpecifierIndex++;
                } else {
                    info.fields[nextFieldIndex] = {
                        nextFieldIndex, startOfSpecifier, endOfSpecifier + 1};
                }
                nextFieldIndex++;
            }

            // Advance to the next starting point
            cursor = endOfSpecifier + 1;
        }

        return info;
    }

    const TextView m_fmt = {};
    const FieldInfo m_info = {};
};

}  // namespace ap::string
