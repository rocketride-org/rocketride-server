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

namespace ap::util {

// Demangles the type name
inline std::string demangle(std::string name) noexcept {
#if defined(WIN32)
    // On windows we get a lotta misc keys that don't really help so
    // filter them
    return string::trim(string::remove(name, "struct ", "__cdecl ", "class "));
#else
    // If we dont give it an output buffer, it mallocs and returns a ptr which
    // will leak better to do it on the stack anyhow
    std::array<char, 1024> tmp = {};

    size_t newLen = tmp.size() - 1;
    int status = 0;
    abi::__cxa_demangle(name.data(), &tmp.front(), &newLen, &status);
    if (status) return "Failed to demangle";
    return string::trim(&tmp.front());
#endif
}

// Returns the RTTI type name for the given template type.
template <typename T>
inline std::string typeName() noexcept {
    typedef typename std::remove_reference<T>::type TR;
    return demangle(typeid(TR).name());
}

// Returns the RTTI type name for the given object instance.
template <typename T>
inline std::string typeName(const T &) noexcept {
    return typeName<T>();
}

}  // namespace ap::util