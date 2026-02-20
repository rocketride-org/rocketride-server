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
// Definitions for format flags and modifiers
//
#pragma once

namespace ap {

// The rocketride formatting syntax is as follows:
//
// 	{[position],[modifier,[length]]}
//
// Modifier | Output
// ---------| ------
// x		| output the value in hex with a 0x prefix
// X		| output the value in hex without a 0x prefix
// 0		| 0 fill to the field length
// 			| field, warning, not an error
// -		| right justified
// c		| Treat as a human count value
// s		| Render as a human size value
// @		| Treat numeric value as bit encoded date time (uint64_t only)
//
// Length format:
// ---------| -----
// 1-9*		| set length of output (left justified by defalt, unless -
// 			| is specified in modifier section)
//
// Position format:
// ---------| ------
// 0-x		| Re-order the argument list via the index specified (always first
// 			| arg, or empty (e.g. {,[modflags,[length]]} which indicates auto
// position
//
// Example  | Meaning
//     ---------| ------
// {,0x,16}	| Output a numeric value in hexadecimal format, zero filled,
// 			| with 0x prefix of 16 digits in hex format, left justified
// {,,8}	| Output with a minimum width of 8 characters, space filled, left
// justified
// {,-,8}	| Output with a minimum width of 8 characters,
// 			| space filled, right justified
// {,0-,8}	| Output with a minimum width of 8 characters,
// 			| zero filled, right justified
// {0}		| Output the first argument in this position
// {1}		| Output the second argument in this position
// {2,-,8}  | Output the third argument in this position,
// 			| right justified, 8 characters minimum width, space filled
// {3,-x,8}	| Output the third argument in this position,
// 			| right justified, hexadecimal (no prefix) 8 character
// 			| minimum width
#if ROCKETRIDE_PLAT_MAC
#undef NOGROUP
#endif
namespace Format {

// Format/parse in hex
_const auto HEX = BIT(0);

// Format in grouping (, and :)
_const auto GROUP = BIT(1);

// Fill with spaces (or 0s if ZEROFILL specified)
_const auto FILL = BIT(2);

// Zero fill
_const auto ZEROFILL = BIT(3) | FILL;

// Prefix (add 0x to beginning of hex output)
_const auto PREFIX = BIT(4);

// For strings, output on right
_const auto RIGHT = BIT(5);

// Allow use of json if no string render found
_const auto JSONOK = BIT(6);

// No group flag
_const auto NOGROUP = BIT(7);

// Infer type to be human readable count
_const auto COUNT_HUMAN = BIT(9);

// Allow use of rtti when rendering types to string which
// have no other means to be converted by
_const auto RTTIOK = BIT(10);

// Decorate flag defines whether the write api may
// include a prefix on the output line
_const auto DECORATE = BIT(11);

// When failure is not an option set this flag, used
// internally
_const auto NOFAIL = BIT(12);

// Prevents capped buffer writes during string conversions
// from being considered an error
_const auto CAPOK = BIT(14);

// Enables leading delimiters on toString rendering
_const auto LEAD = BIT(15);

// Enables trailing delimiters on toString rendering
_const auto TRAIL = BIT(16);

// No filling (overrides all other flags)
_const auto NOFILL = BIT(17);

// Encloses both leading and trailing delimiters
_const auto ENCLOSE = LEAD | TRAIL;

// Used with the toString apis, tells the api to append to
// the buffer
_const auto APPEND = BIT(18);

// From the modifier, sets the flag for rendering numerics as human sizes
_const auto SIZE_HUMAN = BIT(19);

// Allow delimiters to stack up in toString operations rather then getting
// ignored if when the string it is appending to already ends with one
_const auto DOUBLE_DELIMOK = BIT(20);

// Allows an erroror to render without error even if it holds an error
_const auto ERROROROK = BIT(21);

// Ensure all color codes are stripped
_const auto NO_COLORS = BIT(22);

// The render is part of our logging system, used to hide secure properties
_const auto LOGGING = BIT(23);

namespace Mod {
// Space fill character
_const auto SPACE_FILL = ' ';

// Human count
_const auto COUNT_HUMAN = 'c';

// Render as hex with prefix
_const auto HEX_PREFIX = 'x';

// Render as hex with no prefix
_const auto HEX_NO_PREFIX = 'X';

// Fill with zeros
_const auto ZERO_FILL = '0';

// Warning (not error)
_const auto RIGHT = '-';

// No fill
_const auto NOFILL = '~';

// No group
_const auto NOGROUP = '`';

// Treat the value as a size type (numeric types only)
_const auto SIZE_HUMAN = 's';

}  // namespace Mod

// Default flags for formatting include grouping mode
_const uint32_t DefFlags = 0;

// Default delimiter for multi format args of a space
_const char DefDelimiter = '\0';

// Default width of 0 causes auto width to be calculated
_const size_t DefWidth = 0;

// Because we use a non heap allocating array internally in the
// format api, we have a default max
_const size_t DefMaxFields = 20;
}  // namespace Format

}  // namespace ap
