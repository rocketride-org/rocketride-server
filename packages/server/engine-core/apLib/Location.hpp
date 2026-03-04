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
inline std::string Location::fileName() const noexcept {
    if (m_path.empty()) return {};
    if (m_fullPath)
        return std::filesystem::path(m_path.data()).string();
    else
        return std::filesystem::path(m_path.data()).filename().string();
}

}  // namespace ap
