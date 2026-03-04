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

namespace ap::log {

// Host the static property of length for the last in place log
inline size_t &lastInPlaceLineLength() noexcept {
    static size_t length = 0;
    return length;
}

template <typename Str>
inline void removeColors(Str &str) noexcept {
    // If colors have been disabled, there will be no color codes in the string
    if (log::options().disableAllColors) return;

    // If empty, bail
    if (!str) return;

    // Remove each color
    for (auto c : Color{}) {
        str.remove(colorCode(c));
    }
}

// This api will log to the console, it allows for explicit decoration
// modes which by default will include decoration as a template argument.
template <typename Prefix, size_t MaxFields, typename... Args>
inline void writeEx(const FormatOptions &fmtOptions, Location location,
                    Opt<Ref<const Prefix>> prefix,
                    const string::FormatStr<MaxFields> &fmt,
                    Args &&...args) noexcept {
    if (!initialized()) return;

    // Use a short allocator for our output, this will prevent heap allocations
    // up to a certain amount (globally StackTextArena is defined as 4k as
    // of this writing)
    StackTextArena arena;
    StackText header{arena}, message{arena};

    auto &opts = options();
    auto flush = !opts.noFlush;

    // Render the message
    string::formatEx(message, fmtOptions + Format::NOFAIL, fmt,
                     std::forward<Args>(args)...);

    // Walk the formatted message once and figure out a few things
    Opt<size_t> hasInPlace, hasNewLines, hasColors;
    for (auto i = 0; i < message.size(); i++) {
        auto &chr = message[i];
        if (!hasInPlace && chr == '\r')
            hasInPlace = i;
        else if (!hasColors && chr == '\x1B')
            hasColors = i;
        else if (!hasNewLines && chr == '\n')
            hasNewLines = i;

        // Break early if there's nothing more to figure out
        if (hasInPlace && hasNewLines && hasColors) break;
    }

    // Header, and prefix are only rendered when the decorate flag is
    // enabled. It can also be enforced with a developer override in
    // log options (forceDecoration).
    if (fmtOptions.checkFlag(Format::DECORATE) || opts.forceDecoration) {
        _tsbo(header,
              fmtOptions +
                  FormatOptions{location, Format::APPEND | Format::NOFAIL, '|'},
              opts);
        if (prefix) {
            if (header) header += " ";
            _tsbo(header, Format::RTTIOK | Format::APPEND,
                  prefix.value().get());
        }
    }

    // Abstract a call to write, returns the string size written
    auto write = [&](TextView str) noexcept {
        if (str) fwrite(str.data(), sizeof(TextChr), str.size(), opts.logFile);
        return str.size();
    };

    // Write the header, the header may be overridden with a callback in options
    auto writeHeader = [&](StackText &header) noexcept {
        if (opts.customPrefixCb) _call(opts.customPrefixCb, header);
        if (header) {
            auto asciiCode = colorCode(Color::Reset);
            if (!header.endsWith(asciiCode)) header += asciiCode;
            write(header);
        }
    };

    // Normal print, writes header then space and message (if header not
    // blank), will ensure a new line is added if the previous log was an
    // in-place one
    auto normalPrint = [&write, &writeHeader, &arena](
                           StackText &header, StackText &message,
                           bool messageHasNewLines,
                           bool messageHasColors) noexcept {
        // If we had previously performed an in-place write,
        // write a new line since we're not an in-place write, and we
        // want to start at the right position
        if (_exch(lastInPlaceLineLength(), 0)) write("\n");

        writeHeader(header);

        if (message) {
            // Space pad if header written
            if (header) write(" ");

            TextView messageView = message;

            auto first = true;
            Opt<Text> headerPrefix;
            auto lines = messageView.template split<std::vector<Text>>('\n');
            if (lines.empty()) {
                write("\n");
                return;
            }

            for (auto &&line : lines) {
                if (header && !_exch(first, false)) {
                    if (!headerPrefix)
                        headerPrefix.emplace(
                            string::repeat(" ", header.size() + 1));
                    write(*headerPrefix);
                }
                write(line);
                write("\n");
            }
        }

        if (messageHasColors) write(colorCode(Color::Reset));
    };

    // In place mode works by allowing a \r to precede a log line, this
    // triggers some extra logic here to address the issue when
    // a new line during replace mode is shorter then the previous
    // line it replaces. For this reason we track the line lengths so
    // that we can precisely pad shorter in place lines with just enough
    // spaces based on what the last in place log lines length was.
    auto inplacePrint = [&write, hasInPlace](StackText &header,
                                             StackText &message) noexcept {
        // Call this the offset
        auto offset = hasInPlace.value() + 1;

        // Write out the in-place character, will position the cursor
        // to the start of the line
        auto newInplaceLength = write("\r");

        // Write out everything before the specified \r
        if (offset) newInplaceLength += write({message.data(), offset - 1});

        // Write out the header
        if (header) newInplaceLength += write(header);

        // Write out the message, accounting for the header with a space if
        // one was set
        if (message) {
            if (header) newInplaceLength += write(" ");

            auto size = (message.size() - offset) + 1;

            // The message has a \r write it just after that character
            // as we had to write it before the header above
            newInplaceLength += write({&message[offset], size});
        }

        return newInplaceLength;
    };

    // Prevent console interleaving, and decide on an in-place, or
    // normal print
    auto guard = consoleLock();

    // Disable in-place and colors if not going to console
    if (!opts.isAtty) {
        if (hasInPlace) {
            message.remove('\r');
            hasInPlace.reset();
        }
        if (hasColors) {
            removeColors(message);
            hasColors.reset();
        }
    }

    // Explicit new lines, or in places, always cause a flush
    if (hasInPlace || hasNewLines) flush = true;

    if (hasInPlace && !hasNewLines) {
        auto newInplaceLength = inplacePrint(header, message);

        // Now, if our new line length is shorter then the last in place length
        // take the difference and pad with spaces but before we do that
        // free up our stack strings so the generated padding avoids heap
        // allocations here as well
        auto last = lastInPlaceLineLength();
        if (newInplaceLength < last)
            write(StackText{last - newInplaceLength, ' ', arena});
        lastInPlaceLineLength() = newInplaceLength;
    } else {
        // Normal print, use our previously scanned checks to prevent it from
        // having to redundantly check again
        if (hasInPlace) message.remove('\r');
        normalPrint(header, message, hasNewLines.has_value(),
                    hasColors.has_value());
    }

    // Flush is the default as stdout is pretty critical for our installed
    // app, however it is highly performant on windows to not flush, so we
    // make it an option
    if (!opts.noFlush) fflush(opts.logFile);

#if ROCKETRIDE_PLAT_WIN
    // If a debugger is attached on Windows, convert the line to UTF16 output it
    // to the debugger We're changing the content of the header and message, so
    // do this last
    if (::IsDebuggerPresent()) {
        // Output header
        if (header) {
            // hasColors only applies to the message; remove colors from the
            // header as well
            removeColors(header);

            ::OutputDebugStringW(header);
            ::OutputDebugStringW(L" ");
        }

        // If the message isn't valid UTF-8, converting to UTF-16 for
        // OutputDebugStringW will crash, so verify first
        if (string::unicode::isValidUtf8(message)) {
            // Output message
            // Remove colors before outputting to debugger
            if (hasColors) removeColors(message);
            ::OutputDebugStringW(message);
        } else
            ::OutputDebugStringW(L"<INVALID UTF-8>");

        ::OutputDebugStringW(L"\n");
    }
#endif
}

}  // namespace ap::log
