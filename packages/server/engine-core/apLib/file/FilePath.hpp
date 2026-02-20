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

namespace ap::file {

// Get file extension
template <typename ChrT, typename TraitsT>
string::StrView<ChrT, TraitsT> getExtension(
    string::StrView<ChrT, TraitsT> fileName) noexcept {
    if (auto pos = fileName.find_last_of('.'); pos != string::npos)
        return fileName.substr(pos + 1);
    return {};
}

// Strip file extension
template <typename ChrT, typename TraitsT>
string::StrView<ChrT, TraitsT> stripExtension(
    string::StrView<ChrT, TraitsT> fileName) noexcept {
    if (auto pos = fileName.find_last_of('.'); pos != string::npos)
        return fileName.substr(0, pos);
    return fileName;
}

// FilePath is a new version of kernel/Path, designed for efficiency,
// and ease of use. It is an immutable class, all apis return values
// and they do not modify the path itself.
template <typename ChrT, typename AllocT>
class FilePath final {
public:
    // Alias our core api type, and string type with our path trait
    using CharType = ChrT;
    using Api = PathApi<ChrT, AllocT>;
    using AllocatorType = typename Api::AllocatorType;
    using StrType = typename Api::StrType;
    using ViewType = typename Api::ViewType;
    using CompListType = std::vector<ViewType>;

    _const auto GenericSepChr = _cast<ChrT>(GenSep);

    // Compose global path type as our primary types
    using Type = PathType;

    // Default construction
    FilePath(const AllocatorType& alloc = {}) : m_path(alloc) {}

    ~FilePath() = default;

    FilePath(FilePath&& path) noexcept { move(_mv(path)); }

    FilePath(const FilePath& path) noexcept { copy(path); }

    FilePath& operator=(FilePath&& path) noexcept {
        move(_mv(path));
        return *this;
    }

    FilePath& operator=(const FilePath& path) noexcept {
        copy(path);
        return *this;
    }

    FilePath(StrType&& path) noexcept : m_path(_mv(path)) { construct(); }

    // Construct from something other then a FilePath, the goal here
    // is to do zero work besides copying a string on construction
    // only when any additional info is needed from the path will
    // it be classified and parsed
    template <typename T>
    FilePath(T&& path, const AllocatorType& alloc) noexcept : m_path(alloc) {
        construct(std::forward<T>(path));
    }

    template <typename T>
    FilePath(T&& path) noexcept {
        construct(std::forward<T>(path));
    }

    //-------------------------------------------------------------------------
    /// @details
    /// This utility function checks whether a given filename contains
    /// any characters that are invalid or problematic for the target
    /// platform (e.g., Windows). These include characters like:
    /// `<`, `>`, `|`, `:`, `?`, `"`, `/`, `\`, and `*`.
    ///
    /// The function scans the input string for any of these characters
    /// and returns true if any are found, indicating that the filename
    /// is not suitable for export to certain systems (e.g., SMB, OneDrive).
    ///
    /// @param[in] fileName
    ///     The filename or path to validate.
    /// @returns
    ///     True if the filename contains invalid characters, false otherwise.
    //-------------------------------------------------------------------------
    inline bool containsInvalidCharacters() {
        const std::string invalidChars = "<>:\"/\\|?*";

        auto it = components().begin();
        if (it == components().end())  // Handle empty components case
            return false;

        ++it;  // Skip the first component

        for (; it != components().end(); ++it) {
            TextView value = static_cast<TextView>(*it);

            // Ignore "C:" or "D:" style drive letters on Windows
            if (value.size() == 2 && std::isalpha(value[0]) && value[1] == ':')
                continue;

            if (value.find_first_of(invalidChars) != Text::npos) return true;
        }

        return false;  // No invalid characters found
    }

private:
    auto construct() noexcept {
        // Normalize the path as a generic one so we can have a
        // stable format to parse
        m_path.replace(WinSep, GenericSepChr);

        // Give the api a chance to modify the path as well
        Api::construct(m_path);
        m_view = m_path;
    }

    template <typename T>
    auto construct(T&& path) noexcept {
        // This is how we solve the constructor ambiguity between
        // Path and Text
        if constexpr (traits::IsSameTypeV<T, FilePath>)
            operator=(std::forward<T>(path));
        else if constexpr (traits::IsFilesystemPathV<T>)
            m_path = StrType{path.generic_u8string()};
        else if constexpr (traits::IsFilePathV<T>)
            m_path = path.str();
        else if constexpr (std::is_convertible_v<T, const ChrT*>)
            m_path = _cast<const ChrT*>(path);
        else if constexpr (std::is_convertible_v<T, TextView>)
            m_path = _cast<TextView>(path);
        else {
            // Make this a little more obvious when we don't have a handler for
            // an unknown arg type
            static_assert(std::is_constructible_v<StrType, T>,
                          "Don't know how to construct path from type");
            m_path = StrType{std::forward<T>(path)};
        }

        construct();
    }

    // Internal constructor when creating new paths
    FilePath(Type type, ViewType prefix, size_t length = 0,
             const CompListType& comps = {},
             Opt<CRef<CompListType>> moreComps = {}) noexcept
        : m_type(type) {
        // Build another base path so we can reference our own views to it
        m_path = build(type, prefix, length, comps, moreComps);

        // We have a new path so our prefix must use its heap or stack (small
        // optimization) assign it based on what we know of its size
        if (m_path) m_prefix = {&m_path.at(0), prefix.size()};

        // If we have a prefix, adjust the path view
        m_view = m_path;
        m_view.trimLeading(prefix);
    }

    // Concatenates a path from a type prefix and components
    static StrType build(PathType type, ViewType prefix, size_t length,
                         const CompListType& comps,
                         Opt<CRef<CompListType>> moreComps = {}) noexcept {
        // Use the comps to build a new path, but don't use the
        // comps directly as they are views to another path
        StrType path;

        // If no hint of length calculate it
        if (!length) {
            length += prefix.size();
            for (auto& c : comps) length += c.size();
        }

        path.reserve(length);
        path = prefix;
        auto first = true;

        for (auto& comp : comps) {
            if (!_exch(first, false)) path.append(GenericSepChr);
            path.append(comp);
        }

        if (moreComps) {
            for (auto& comp : moreComps->get()) {
                if (!_exch(first, false)) path.append(GenericSepChr);
                path.append(comp);
            }
        }

        return path;
    }

public:
    // So that we can act like a str in generic areas implement
    // the stl named get_allocator method to access our allocator
    decltype(auto) get_allocator() const noexcept {
        return m_path.get_allocator();
    }

    // The original string value of this path
    decltype(auto) str() const noexcept { return m_path; }

    template <typename T>
    auto replace(const T& sepOrigin, const T& sepDest) const {
        m_path.replace(sepOrigin, sepDest);
    }

    // Convenience apis
    auto isRelative() const noexcept { return file::isRelative(type()); }

    auto isUnc() const noexcept { return file::isUnc(type()); }

    auto isAbsolute() const noexcept { return file::isAbsolute(type()); }

    auto isSnap() const noexcept { return file::isSnap(type()); }

    // Equality check
    template <typename ChrTT = ChrT, typename AllocTT = AllocT>
    bool operator==(const FilePath<ChrTT, AllocTT>& rhs) const noexcept {
        return components() == rhs.components();
    }

    // Inequality check
    template <typename ChrTT = ChrT, typename AllocTT = AllocT>
    bool operator!=(const FilePath<ChrTT, AllocTT>& rhs) const noexcept {
        return !operator==(rhs);
    }

    // < comparator, compares path using proper path sorting which is delimiter
    // aware
    template <typename ChrTT = ChrT, typename AllocTT = AllocT>
    bool operator<(const FilePath<ChrTT, AllocTT>& rhs) const noexcept {
        if (*this == rhs) return false;
        return gen() < rhs.gen();
    }

    // Adhere to iteration api for range for compatibility, iteration
    // consists of components from the full portion of this path
    auto begin() const noexcept { return components().begin(); }
    auto end() const noexcept { return components().end(); }
    auto rbegin() const noexcept { return components().rbegin(); }
    auto rend() const noexcept { return components().rend(); }
    decltype(auto) front() const noexcept { return *begin(); }
    decltype(auto) back() const noexcept { return *rbegin(); }

    // Create a new path and set a file extension
    auto setFileExt(TextView newExt) const noexcept {
        auto currentExt = fileExt().trimLeading(".");
        auto currentFileName = fileName();
        currentFileName.trimTrailing(currentExt);
        currentFileName.trimTrailing(".");
        return parent() / (currentFileName + "." + newExt.trimLeading("."));
    }

    // Create a new path and set a file name
    auto setFileName(TextView name) const noexcept {
        return parent() / string::trim(name, {'/', '\\'});
    }

    // Create a new path and add to the file name
    auto appendFileName(TextView name) const noexcept {
        return parent() / (fileName() + string::trim(name, {'/', '\\'}));
    }

    // Get the file name of this path
    ViewType fileName(bool stripExtension = false) const noexcept {
        if (empty()) return {};

        auto name = back();
        return stripExtension ? file::stripExtension(name) : name;
    }

    ViewType fileExt() const noexcept { return file::getExtension(fileName()); }

    // Load the type of this path
    Type type() const noexcept {
        classify();
        return *m_type;
    }

    // Get the parent path
    FilePath parent() const noexcept {
        auto [len, comps] = Api::parent(length(), components());

        // If there is no parent, return an empty path
        if (!len && comps.empty()) return {};

        classify();

        FilePath parent{type(), *m_prefix, len, comps};

        // If the parent isn't valid, return an empty path
        if (!parent.valid()) return {};

        return parent;
    }

    // Valid check
    auto valid() const noexcept {
        // Invalid is invalid
        if (type() == Type::INVALID) return false;

        // UNC paths must have at least two components (host and share)
        if (isUnc()) return count() >= 2;

        return true;
    }

    // Whether this path is empty or not
    auto empty() const noexcept { return Api::empty(m_path, components()); }

    // Boolean operator, returns true if this path is non-empty and valid
    explicit operator bool() const noexcept { return !empty() && valid(); }

    // Component count
    auto count() const noexcept { return components().size(); }

    // Length of the path string
    auto length() const noexcept { return m_path.size(); }

    // Returns the long form of the platform type with no enforced trailing sep
    const StrType& platLong() const noexcept {
        classify();

        if (!m_platLong) {
            auto guard = lock();
            if (!m_platLong)
                m_platLong =
                    Api::plat(*m_type, *m_prefix, m_view, !isRelative(), false,
                              m_path.get_allocator());
        }

        return *m_platLong;
    }

    // Returns the long form of the platform type with enforced trailing sep
    const StrType& platLongTrailingSep() const noexcept {
        classify();

        if (!m_platLongTrailingSep) {
            auto guard = lock();
            if (!m_platLongTrailingSep)
                m_platLongTrailingSep =
                    Api::plat(*m_type, *m_prefix, m_view, !isRelative(), true,
                              m_path.get_allocator());
        }

        return *m_platLongTrailingSep;
    }

    // Returns the platform specific path with no enforced trailing sep
    const StrType& plat(bool longForm = true) const noexcept {
        if (longForm) return platLong();

        classify();

        if (!m_plat) {
            auto guard = lock();
            if (!m_plat)
                m_plat = Api::plat(*m_type, *m_prefix, m_view, false, false,
                                   m_path.get_allocator());
        }

        return *m_plat;
    }

    // Returns the platform specific path with enforced trailing sep
    const StrType& platTrailingSep(bool longForm = true) const noexcept {
        if (longForm) return platLongTrailingSep();

        classify();

        if (!m_platTrailingSep) {
            auto guard = lock();
            if (!m_platTrailingSep)
                m_platTrailingSep = Api::plat(*m_type, *m_prefix, m_view, false,
                                              true, m_path.get_allocator());
        }

        return *m_platTrailingSep;
    }

    // Returns the generic path always as unix sep
    const StrType& gen() const noexcept {
        classify();

        if (!m_gen) {
            auto guard = lock();
            if (!m_gen)
                m_gen = Api::gen(*m_type, *m_prefix, m_view,
                                 m_path.get_allocator());
        }

        return *m_gen;
    }

    // Returns a prefix if the path has one (e.g. unix ~/, win \\?\)
    ViewType prefix() const noexcept {
        classify();
        return *m_prefix;
    }

    // At api accessor, accesses a component at an index
    auto at(size_t index) const noexcept {
        ASSERTD_MSG(index < components().size(),
                    "Out of bounds access of path index");
        return components()[index];
    }

    // Array accessor, accesses a component at an index
    auto operator[](size_t index) const noexcept { return at(index); }

    operator ViewType() const noexcept { return gen(); }

    operator TextView() const noexcept { return gen(); }

    auto isParentOf(const FilePath& child,
                    bool inclusive = true) const noexcept {
        // Longer paths cannot be parents of shorter paths
        if (count() > child.count()) return false;
        // A path of equivalent length can only be a child if inclusive is set
        else if (count() == child.count() && !inclusive)
            return false;

        // Now we have to check if the parent, e.g. c:\ is a parent of the child
        // e.g. c:\dir\file or d:\dir\file To do that we just check if the child
        // components are all the same as our components
        auto childComps = CompListType{child.components().begin(),
                                       child.components().begin() + count()};
        return components() == childComps;
    }

    auto isChildOf(const FilePath& parent,
                   bool inclusive = true) const noexcept {
        return parent.isParentOf(*this, inclusive);
    }

    // Extracts a relative sub path
    FilePath subpth(size_t compIndexStart,
                    Opt<size_t> size = {}) const noexcept {
        // If start of sub path is out of bounds, return empty path
        if (compIndexStart >= count()) return {};

        // Cap the comps
        const auto& sourceComps = components();
        CompListType comps;
        if (size)
            comps = {sourceComps.begin() + compIndexStart,
                     sourceComps.begin() + compIndexStart + *size};
        else
            comps = {sourceComps.begin() + compIndexStart, sourceComps.end()};

        // A subpath of a path is always relative and has no prefix if it starts
        // from index > 0  (e.g. a subpath of a UNC path is otherwise invalid)
        if (compIndexStart) return FilePath(PathType::RELATIVE, {}, 0, comps);

        return FilePath(type(), prefix(), 0, comps);
    }

    // Append a component to this path and return a new path
    FilePath append(const FilePath& path) const noexcept {
        // If the left-hand path is invalid, return the right-hand path
        if (!valid()) return path;

        classify();

        return {*m_type, *m_prefix, length() + path.length(), components(),
                path.components()};
    }

    // Raw string literal casting so we can be used directly with
    // operating system apis
    explicit operator const Utf16Chr*() const noexcept {
        return _cast<const Utf16Chr*>(gen());
    }

    explicit operator const Utf8Chr*() const noexcept {
        return _cast<const Utf8Chr*>(gen());
    }

    FilePath operator/(const FilePath& path) const noexcept {
        return append(path);
    }

    FilePath& operator/=(const FilePath& rhs) noexcept {
        *this = append(rhs);
        return *this;
    }

    std::filesystem::path stdPath() const noexcept {
        if constexpr (!traits::IsSameTypeV<std::filesystem::path::value_type,
                                           CharType>) {
            FilePath<std::filesystem::path::value_type> pathW(*this);
            return pathW.stdPath();
        } else {
            return std::filesystem::path{plat().begin(), plat().end()};
        }
    }

    // Cast to a std::filesystem::path
    operator std::filesystem::path() const noexcept { return stdPath(); }

    // Render the path as a string
    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        buff << gen();
    }

    // Load this path from a string
    template <typename Buffer>
    static auto __fromString(FilePath& path, const Buffer& buff) noexcept {
        path = buff.toString();
    }

    auto resolve() const noexcept {
        StrType path = m_path;

        // Convert all seps to generic
        path.replace(file::WinSep, file::GenSep);

        // Split it up and leave empty components
        std::vector<StrType> comps = path.split(file::GenSep, true);

        // Create the new components that make up the path
        std::vector<StrType> newComp;

        for (auto& comp : comps) {
            if (comp == ".") continue;
            if (comp == ".." && newComp.size() > 0) {
                newComp.pop_back();
                continue;
            }

            newComp.push_back(comp);
        }

        // Loop through the elements
        StrType str;
        bool first = true;
        for (auto& comp : newComp) {
            // If this is not the first, add a seperator
            if (!first) str += '/';

            // Add this element
            str += comp;

            // Reset the first flag
            first = false;
        }

        return FilePath{str};
    }

private:
    void reset() noexcept {
        m_path.clear();
        m_view = {};
        m_plat.reset();
        m_platTrailingSep.reset();
        m_platLong.reset();
        m_platLongTrailingSep.reset();
        m_gen.reset();
        m_components.reset();
        m_type.reset();
    }

    // Determines type and prefix of path; will change path contents if prefixed
    // Lock before calling
    void classify() const noexcept {
        if (m_type && m_prefix) return;

        auto guard = lock();

        if (m_type && m_prefix) return;

        auto [type, prefix] = Api::classify(m_path);
        m_prefix = prefix;
        m_type = type;

        // If we have a prefix, adjust the path view
        m_view.remove_prefix(prefix.size());
    }

    // Splits this path into a vector of components, performs no copy
    // or allocation as the resulting items are not manipulated
    decltype(auto) split() const noexcept {
        return string::view::tokenizeVector(ViewType{gen()}, GenericSepChr,
                                            {&GenericSepChr, 1});
    }

    // Returns a component view
    const CompListType& components() const noexcept {
        if (!m_components) m_components = split();
        return *m_components;
    }

    auto move(FilePath&& path) noexcept {
        if (this == &path) return;
        reset();
        m_path = _mv(path.m_path);
        m_view = m_path;
    }

    auto copy(const FilePath& path) noexcept {
        if (this == &path) return;
        reset();
        m_path = path.m_path;
        m_view = m_path;
    }

    auto lock() const noexcept { return m_lock.acquire(); }

private:
    // Our internal path value, i.e. the original string handed to us at
    // construction
    mutable StrType m_path;

    // A view to the path, which allows us to adjust where it starts
    // if we need to skip a prefix for example
    mutable ViewType m_view;

    // Lightweight lock to protect the lazily evaluated properties
    mutable async::SpinLock m_lock;

    // Cached platform path, two forms, one with trailing sep, another without,
    // so we can cache both
    mutable Opt<StrType> m_plat, m_platTrailingSep;

    // Cached long platform path, two forms just like m_plat
    mutable Opt<StrType> m_platLong, m_platLongTrailingSep;

    // Cached generic path form, always as unix separator form
    mutable Opt<StrType> m_gen;

    // Cached prefix, extracted from m_path
    mutable Opt<ViewType> m_prefix;

    // Cached component view vector, views back to main path with no allocations
    mutable Opt<CompListType> m_components;

    // Path type, lazily parsed on first use of type() api
    mutable Opt<Type> m_type;
};

// Global operators for Str
template <typename LChrT, typename LAllocT, typename RChrT = char,
          typename RTraitsT = string::Case<RChrT>,
          typename RAllocT = string::Case<RChrT>>
inline auto operator/(const FilePath<LChrT, LAllocT>& path,
                      const char* comp) noexcept {
    return path.append(comp);
}

template <typename LChrT, typename LAllocT, typename RChrT = char,
          typename RTraitsT = string::Case<RChrT>,
          typename RAllocT = string::Case<RChrT>>
inline bool operator==(
    const FilePath<LChrT, LAllocT>& lhs,
    const string::Str<RChrT, RTraitsT, RAllocT>& rhs) noexcept {
    return lhs == FilePath<LChrT, LAllocT>{rhs};
}

template <typename LChrT, typename LAllocT, typename RChrT = char,
          typename RTraitsT = string::Case<RChrT>,
          typename RAllocT = string::Case<RChrT>>
inline bool operator!=(
    const FilePath<LChrT, LAllocT>& lhs,
    const string::Str<RChrT, RTraitsT, RAllocT>& rhs) noexcept {
    return lhs != FilePath<LChrT, LAllocT>{rhs};
}

template <typename LChrT, typename LAllocT, typename RChrT = char,
          typename RTraitsT = string::Case<RChrT>,
          typename RAllocT = string::Case<RChrT>>
inline bool operator<(
    const FilePath<LChrT, LAllocT>& lhs,
    const string::Str<RChrT, RTraitsT, RAllocT>& rhs) noexcept {
    return lhs < FilePath<LChrT, LAllocT>{rhs};
}

// Global operators for StrView
template <typename LChrT, typename LAllocT, typename RChrT = char,
          typename RTraitsT = string::Case<RChrT>>
inline bool operator==(const FilePath<LChrT, LAllocT>& lhs,
                       string::StrView<RChrT, RTraitsT> rhs) noexcept {
    return lhs == FilePath<LChrT, LAllocT>{rhs};
}

template <typename LChrT, typename LAllocT, typename RChrT = char,
          typename RTraitsT = string::Case<RChrT>>
inline bool operator!=(const FilePath<LChrT, LAllocT>& lhs,
                       string::StrView<RChrT, RTraitsT> rhs) noexcept {
    return lhs != FilePath<LChrT, LAllocT>{rhs};
}

template <typename LChrT, typename LAllocT, typename RChrT = char,
          typename RTraitsT = string::Case<RChrT>>
inline bool operator<(const FilePath<LChrT, LAllocT>& lhs,
                      string::StrView<RChrT, RTraitsT> rhs) noexcept {
    return lhs < FilePath<LChrT, LAllocT>{rhs};
}

// Global operators for raw character arrays
template <typename LChrT, typename LAllocT, size_t Length>
inline bool operator==(const FilePath<LChrT, LAllocT>& lhs,
                       const char (&rhs)[Length]) noexcept {
    return lhs == FilePath<LChrT, LAllocT>{rhs};
}

template <typename LChrT, typename LAllocT, size_t Length>
inline bool operator!=(const FilePath<LChrT, LAllocT>& lhs,
                       const char (&rhs)[Length]) noexcept {
    return lhs != FilePath<LChrT, LAllocT>{rhs};
}

template <typename LChrT, typename LAllocT, size_t Length>
inline bool operator<(const FilePath<LChrT, LAllocT>& lhs,
                      const char (&rhs)[Length]) noexcept {
    return lhs < FilePath<LChrT, LAllocT>{rhs};
}

}  // namespace ap::file
