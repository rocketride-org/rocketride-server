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

namespace ap::string {

namespace {

template <size_t MaxFields, typename BufferType, typename... Args>
inline Error formatPositional(PackAdapter<BufferType> &result,
                              FormatOptions opts,
                              const FormatStr<MaxFields> &fmt,
                              Args &&...args) noexcept {
    Error ccode;

    // Ready a static array of results
    std::array<Opt<Text>, sizeof...(args)> argResults;
    auto positions = fmt.positions();

    size_t index = 0;
    auto formatArg = [&](const auto &arg) noexcept {
        auto argIndex = index++;

        if (ccode) return;

        // Instantiate a buffer for this arg
        Text argResult;

        // Lookup its specifier
        auto specifier = fmt.lookupSpecifier(argIndex);

        // And render it, use its position and opts if valid
        if (specifier.valid()) {
            argIndex = specifier.position();
            auto adapter = PackAdapter<Text>{argResult, EndPos};
            ccode = internal::packSelector(arg, specifier.options() + opts,
                                           adapter);
        } else {
            auto adapter = PackAdapter<Text>{argResult, EndPos};
            ccode = internal::packSelector(arg, opts, adapter);
        }

        // Save the result for later
        argResults[argIndex] = _mv(argResult);
    };

    // Now convert each entry they'll populate the results array for us with
    // either a success or failure result
    (formatArg(args), ...);

    // Now we have everything we need to rapidly stream the results all
    // to a central buffer
    //
    // Example:
    //		Format: "{0} {2} {1}"
    //		Args: a, b, c, d, e
    //		Results: [0] => "a", [1] = "c", [2] = "b", [3] = "d", [4] = "e"
    //

    // If they asked for a hard failure do that now
    if (opts.noFail()) ASSERTD_MSG(!ccode, "Failed to format string:", ccode);

    // Now we walk the fields in the formatter, find out which ones
    // were valid, then insert their result if so, or we insert the
    // data the field represents
    size_t remainingArgs = argResults.size();
    for (auto i = 0; i < MaxFields; i++) {
        // Load the field, stop iterating once we hit the first invalid one
        auto field = fmt.field(i);
        if (!field) break;

        // Valid field, now is it a valid specifier
        if (auto specifier = field.specifier(); specifier.valid()) {
            auto specPos = specifier.position();
            auto argPos = positions.specToArg[specPos];
            auto &argResult = argResults[argPos];

            if (argResult) {
                result << argResult.value();
                argResult.reset();
                if (remainingArgs) remainingArgs--;
            }
            continue;
        }

        // No specifier here insert the field portion
        result << fmt.fieldStr(field);
    }

    // Now render any arguments that were not specified by fields
    if (remainingArgs) {
        for (auto &argResult : argResults) {
            if (!argResult) continue;
            if (opts.delimiter() && !result.empty() && argResult.value() &&
                !endsWithControlOrColor(result.toString()))
                result << opts.delimiter();
            result << argResult.value();
        }
    }

    return ccode;
}

template <size_t MaxFields, typename BufferType, typename... Args>
inline Error formatInOrder(PackAdapter<BufferType> &result, FormatOptions opts,
                           const FormatStr<MaxFields> &fmt,
                           Args &&...args) noexcept {
    Error ccode;

    size_t nextFieldIndex = 0;
    auto formatArg = [&](const auto &arg) noexcept {
        while (!ccode) {
            // Print any field portions up to this point
            if (auto field = fmt.field(nextFieldIndex++); field.valid()) {
                if (auto specifier = field.specifier(); specifier.valid()) {
                    // Represents an argument render it directly now
                    ccode = internal::packSelector(
                        arg, specifier.options() + opts, result);
                } else {
                    // Field string, render it now then loop until we hit our
                    // argument position
                    result << fmt.fieldStr(field);
                    continue;
                }
            } else {
                // No more fields start delimiting
                StackTextArena arena;
                StackText argResultBacking{arena};
                PackAdapter argResult{argResultBacking, BegPos};

                // Add a delimiter if needed
                ccode = internal::packSelector(arg, opts, argResult);
                if (argResultBacking && opts.delimiter() && !result.empty() &&
                    !endsWithControlOrColor(result.toString()) &&
                    !string::isControl(arg))
                    result << opts.delimiter() << argResultBacking;
                else
                    result << argResultBacking;
            }

            return;
        }
    };

    // Now convert each entry they'll populate the results array for us with
    // either a success or failure result
    (formatArg(args), ...);

    // Print any stragglers
    while (auto field = fmt.field(nextFieldIndex++))
        result << fmt.fieldStr(field);

    return ccode;
}

template <size_t MaxFields, typename BufferType, typename... Args>
inline auto dispatch(BufferType &&result, FormatOptions opts,
                     const FormatStr<MaxFields> &fmt, Args &&...args) noexcept
    -> traits::IfPackAdapter<BufferType, Error> {
    if (fmt.allFieldsInOrder())
        return formatInOrder(result, opts, fmt, std::forward<Args>(args)...);
    return formatPositional(result, opts, fmt, std::forward<Args>(args)...);
}

template <size_t MaxFields, typename BufferType, typename... Args>
inline auto dispatch(BufferType &&result, FormatOptions opts,
                     const FormatStr<MaxFields> &fmt, Args &&...args) noexcept
    -> traits::IfNotPackAdapter<BufferType, Error> {
    auto adapter = PackAdapter{result, CurOrBegPos};
    return dispatch<MaxFields>(adapter, opts, fmt, std::forward<Args>(args)...);
}

}  // namespace

template <size_t MaxFields, typename BufferType, typename... Args>
inline Error formatEx(BufferType &result, FormatOptions opts,
                      const FormatStr<MaxFields> &fmt,
                      Args &&...args) noexcept {
    return dispatch<MaxFields>(result, opts, fmt, std::forward<Args>(args)...);
}

// Shorthand
#define _fmt ::ap::string::format

}  // namespace ap::string
