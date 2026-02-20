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

namespace ap {

// Format options is a general purpose structure used across the string
// conversion and string format apis. It holds fundamental formatting
// rules which may be applied globally in a format call, or individually
// with string format specifiers mapping to individual settings.
// Certain apis are templated to provide helper apis for converting
// numbers and strings, with alignment and delimitation.
struct FormatOptions {
    // Alias pack traits which we use here in certain cases
    template <typename ArgType>
    using Traits = string::internal::PackTraits<ArgType>;

    // Default assignment and construction
    FormatOptions &operator=(const FormatOptions &) = default;
    FormatOptions(const FormatOptions &) = default;

    // Construct from a location and flags
    FormatOptions(Location location = {}, uint32_t flags = Format::DefFlags,
                  char delimiter = Format::DefDelimiter,
                  size_t width = Format::DefWidth) noexcept
        : m_location(location),
          m_flags(flags),
          m_delimiter(delimiter),
          m_width(width) {}

    // Construct from flags
    FormatOptions(uint32_t flags, size_t width = Format::DefWidth,
                  char delimiter = Format::DefDelimiter) noexcept
        : m_flags(flags), m_delimiter(delimiter), m_width(width) {}

    // For our flags, operator + merges, for properties, all our
    // replaced from the or'd in version if they are set
    [[nodiscard]] FormatOptions operator+(
        FormatOptions options) const noexcept {
        return {
            options.m_location ? options.m_location : m_location,
            m_flags | options.m_flags,
            options.m_delimiter != Format::DefDelimiter ? options.m_delimiter
                                                        : m_delimiter,
            options.m_width != Format::DefWidth ? options.m_width : m_width};
    }

    [[nodiscard]] FormatOptions operator-(
        FormatOptions options) const noexcept {
        return {options.m_location, options.m_flags & ~options.m_flags,
                options.m_delimiter, m_width};
    }

    auto setDelimiter(char delim) const noexcept {
        auto copy = *this;
        copy.m_delimiter = delim;
        return copy;
    }

    // Raw flag accessor
    uint32_t flags() const noexcept { return m_flags; }

    // A delimiter is used when more then one type is rendered
    // this is used in the container types
    char delimiter(char defDelim = 0) const noexcept {
        return m_delimiter ? m_delimiter : defDelim;
    }

    // Is this a log render
    bool logging() const noexcept { return checkFlag(Format::LOGGING); }

    // Checks the no fail flag
    bool noFail() const noexcept { return checkFlag(Format::NOFAIL); }

    // Are double delims ok
    bool doubleDelimOk() const noexcept {
        return checkFlag(Format::DOUBLE_DELIMOK);
    }

    // Rendering errorors in error states is ok
    bool errorOrOk() const noexcept { return checkFlag(Format::ERROROROK); }

    // Checks the json ok flag
    bool jsonOk() const noexcept { return checkFlag(Format::JSONOK); }

    // Checks the rtti ok flag
    bool rttiOk() const noexcept { return checkFlag(Format::RTTIOK); }

    // Checks the no color options
    bool noColors() const noexcept { return checkFlag(Format::NO_COLORS); }

    // Helper api to check a flag for being set, does the
    // proper & flag == flag to work for combo flags as well
    bool checkFlag(uint32_t flag) const noexcept {
        return (m_flags & flag) == flag;
    }

    // Returns true/false based on whether strict mode is enabled
    // for conversions, strict mode is just used in the fromString
    // api where if there is no means to suitably convert it to a
    // string, it will defer to an RTTI name if this is set, otherwise
    // it will abort the build with a static assert.
    bool strictConvert() const noexcept { return checkFlag(Format::RTTIOK); }

    // Returns true/false based on whether relaxed mode is enabled
    // for conversions, relaxed mode is just used in the fromString
    // api where if there is no means to suitably convert it to a
    // string, it will defer to an RTTI name if this is set, otherwise
    // it will abort the build with a static assert.
    bool relaxedConvert() const noexcept { return !strictConvert(); }

    // Checks the Format::APPEND flag
    bool append() const noexcept { return checkFlag(Format::APPEND); }

    // Returns true/false based on the justification flags, right
    // mode vs left mode
    bool rightJustify() const noexcept { return checkFlag(Format::RIGHT); }

    // Returns true/false based on the justification flags, right
    // mode vs left mode
    bool leftJustify() const noexcept { return !rightJustify(); }

    // Treat the numeric as a human size byte count
    bool sizeHuman() const noexcept { return checkFlag(Format::SIZE_HUMAN); }

    // Treat the numeric as a human count
    bool countHuman() const noexcept { return checkFlag(Format::COUNT_HUMAN); }

    // Returns true/false based on whether fill was requested. NOFILL
    // will always cause this to return false.
    bool fill() const noexcept {
        return checkFlag(Format::FILL) && !checkFlag(Format::NOFILL);
    }

    // Returns true/false based on whether hex mode was requested, only
    // enabled for integral types.
    bool hex() const noexcept { return checkFlag(Format::HEX); }

    // Numeric length classifies how this number type should be
    // filled, depending on its width, this is only enabled
    // if the type is integral. This does not check what the
    // fill request is, this is used during parsing of numbers.
    template <typename ArgType>
    size_t width() const noexcept {
        if constexpr (Traits<ArgType>::IsClassNumber) {
            // Floats never get width for now
            if (!Traits<ArgType>::IsIntegral)
                return 0;
            else {
                if (hex()) return m_width ? m_width : Traits<ArgType>::HexWidth;
                return m_width ? m_width : Traits<ArgType>::DecimalWidth;
            }
        } else {
            return m_width;
        }
    }

    // Returns the width if just the filler portion if filling is
    // enabled, if filling is disabled this always returns 0
    template <typename ArgType>
    size_t fillWidth(size_t argLength = 0) const noexcept {
        if (argLength == 0) return fill() ? width<ArgType>() : argLength;

        if (fill()) {
            if (width<ArgType>() > argLength)
                return width<ArgType>() - argLength;
            else
                return 0;
        } else {
            return 0;
        }
    }

    // Returns a boolean result based on whether fill and zero fill
    // has been requested
    template <typename ArgType>
    bool zeroFill() const noexcept {
        if (!fill()) return false;

        if (Traits<ArgType>::IsClassNumber) {
            if (checkFlag(Format::ZEROFILL)) {
                if (rightJustify()) return false;
                return true;
            }
        }
        return checkFlag(Format::ZEROFILL);
    }

    // Returns a boolean result based on whether fill and space fill
    // has been requested
    template <typename ArgType>
    bool spaceFill() const noexcept {
        if (!fill()) return false;
        return !zeroFill<ArgType>();
    }

    // Returns the actual character to be used in the fill
    template <typename ArgType>
    char fillChr() const noexcept {
        if (hex() && !rightJustify() && fill()) return Format::Mod::ZERO_FILL;
        if (!fill()) return '\0';
        if (zeroFill<ArgType>()) return Format::Mod::ZERO_FILL;
        return Format::Mod::SPACE_FILL;
    }

    // Returns true/false based on whether grouping is enabled
    bool group() const noexcept {
        return checkFlag(Format::GROUP) ||
               checkFlag(Format::COUNT_HUMAN) && !checkFlag(Format::NOGROUP);
    }

    // If true will not treat capped buffer writes as failures
    bool capOk() const noexcept { return checkFlag(Format::CAPOK); }

    // Returns the grouping width based on the hex flag
    uint32_t groupWidth() const noexcept {
        return checkFlag(Format::HEX) ? 4 : 3;
    }

    // Returns true/false based on the prefix flag
    bool prefix() const noexcept { return checkFlag(Format::PREFIX); }

    // Returns the requested prefix (just works for hex)
    std::string_view prefixStr() const noexcept {
        return (prefix() && hex()) ? "0x"sv : ""sv;
    }

    // Checks the trailing delim flag
    bool trail() const noexcept {
        return checkFlag(Format::TRAIL) && delimiter();
    }

    // Checks the leading delim flag
    bool lead() const noexcept {
        return checkFlag(Format::LEAD) && delimiter();
    }

    // Location accessor
    auto location() const noexcept { return m_location; }

    // Returns the character to be used for the group
    char groupChr() const noexcept {
        return group() ? hex() ? ':' : ',' : '\0';
    }

    // Decimal grouping facade for i/o streams
    struct DecimalGroups : std::numpunct<char> {
        using Base = std::numpunct<char>;
        using Base::Base;
        virtual ~DecimalGroups() = default;

    protected:
        char_type do_decimal_point() const override { return '.'; }
        char_type do_thousands_sep() const override { return ','; }
        string_type do_grouping() const override { return "\3"; }
    };

    // Hex grouping facade for i/o streams
    struct HexGroups : std::numpunct<char> {
        using Base = std::numpunct<char>;
        using Base::Base;
        virtual ~HexGroups() = default;

    protected:
        char_type do_thousands_sep() const override { return ':'; }
        string_type do_grouping() const override { return "\4"; }
    };

    // Allocate a stream for input parsing
    template <typename ArgType>
    decltype(auto) allocateUnpackStream() const noexcept {
        // For unpack streams we always handle grouping implicitly
        std::stringstream stream;
        if (hex())
            stream.imbue(std::locale(stream.getloc(), new HexGroups));
        else
            stream.imbue(std::locale(stream.getloc(), new DecimalGroups));

        commonStreamSetup<ArgType>(stream);
        return stream;
    }

    // Allocate a stream for output parsing
    template <typename ArgType>
    decltype(auto) allocatePackStream() const noexcept {
        // For pack streams we only enable grouping if set in the flags
        std::stringstream stream;
        if (group()) {
            if (hex())
                stream.imbue(std::locale(stream.getloc(), new HexGroups));
            else
                stream.imbue(std::locale(stream.getloc(), new DecimalGroups));
        }

        if (rightJustify())
            stream << std::right;
        else
            stream << std::left;

        if (auto length = fillWidth<ArgType>(); length) {
            stream << std::setfill(fillChr<ArgType>());
            stream << std::setw(length);
        }

        if (hex()) {
            if (auto prefix = prefixStr(); prefix != "") stream << prefix;
        }

        commonStreamSetup<ArgType>(stream);
        return stream;
    }

private:
    // Sets up a stream for rendering a particular type
    template <typename ArgType, typename StreamType>
    StreamType &commonStreamSetup(StreamType &stream) const noexcept {
        if (std::is_floating_point_v<ArgType>) {
            stream << std::fixed << std::setprecision(2);
            if (hex()) stream << std::hexfloat;
        } else if (hex())
            stream << std::hex;

        return stream;
    }

    uint32_t m_flags = Format::DefFlags;
    size_t m_width = Format::DefWidth;
    char m_delimiter = Format::DefDelimiter;
    Location m_location;
};

}  // namespace ap
