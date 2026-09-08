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

#include <apLib/ap.h>

namespace ap {

// This operator allows us to specify the next location
// in the series, if the current one is empty, the next one will be used
//
// e.g.:
// 	void myFunc(Location loc) {
// 	someOtherFuncNeedsLocation(_location || loc)
// }
//
// In the above example if loc is empty, _location gets used instead.
inline const Location &Location::operator||(
    const Location &other) const noexcept {
    if (other) return other;
    return *this;
}

// < operator allows this object to be keyed in a container.
// The sorting rules will group by the path of the location
// and then the line.
inline bool Location::operator<(const Location &other) const noexcept {
    if (m_path == other.m_path) return line() < other.line();
    return m_path < other.m_path;
}

// Cleans up the function name for string rendering
inline std::string Location::sanitizeFunctionName(
    std::string_view name) noexcept {
    if (auto lambdaStart = name.find_first_of('<');
        lambdaStart != string::npos) {
        if (auto lambdaEnd = name.find_first_of('>', lambdaStart);
            lambdaEnd != string::npos) {
            return std::string{name.substr(0, lambdaStart)} + "[lambda]";
        }
    }
    return std::string{name};
}

// toString will render this location as a string, optionally
// including the function name in the output
template <typename Buffer>
inline void Location::toString(Buffer &buff, bool includeFunction,
                               bool includeFile) const noexcept {
    if (includeFile) {
        if (includeFunction)
            _tsb(buff, fileName(), ":", Count(line()), "-",
                 sanitizeFunctionName(m_function));
        else
            _tsb(buff, fileName(), ":", Count(line()));
    } else if (includeFunction)
        _tsb(buff, sanitizeFunctionName(m_function));
}

// line accessor
inline int Location::line() const noexcept { return m_line; }

// function accessor
inline std::string Location::function() const noexcept {
    return std::string(m_function);
}

// Filename accessor (strips just the file name off the path)
//
// The path is copied into a std::string before it is parsed. m_path is a view, and a
// view carries no NUL at its end, so handing path(m_path.data()) a view that is a
// substring of a larger buffer reads on past the characters that belong to it.
// Constructing or rendering a std::filesystem::path can also throw - on Windows the
// narrow/wide conversion does, for bytes the active code page cannot represent - and
// this accessor is noexcept, so a throw here is terminate rather than a bad file name.
// Returning the path unsplit is a far better answer than aborting the process.
inline std::string Location::fileName() const noexcept {
    if (m_path.empty()) return {};
    try {
        const std::filesystem::path path{std::string(m_path)};
        return m_fullPath ? path.string() : path.filename().string();
    } catch (...) {
        return std::string(m_path);
    }
}

}  // namespace ap
