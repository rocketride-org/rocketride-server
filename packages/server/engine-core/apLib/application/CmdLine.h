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

namespace ap::application {
// Commandline abstracts the usage and parsing of the classic argc/argv
// params which get passed to main
// @notes
// Each argument will be trimmed and its quotes removed
class CmdLine {
public:
    // Construct from a array of ptrs of any character type whose
    // size matches that with OsChr
    template <typename ChrT,
              typename = std::enable_if_t<sizeof(ChrT) == sizeof(OsChr)>>
    CmdLine(int argc, const ChrT **argv) noexcept {
        // Convert or copy the arg from its native encoding
        m_args_processed.reserve(argc);
        m_args_original.reserve(argc);

        // Add all the arguments and save the original
        for (auto i = 0; i < argc; i++) {
            addArg(argv[i]);

            Text arg = argv[i];
            m_args_original.push_back(arg);
        }
    }

    // Define default construction and assignment
    CmdLine() = default;
    CmdLine(const CmdLine &) = default;
    CmdLine(CmdLine &&) = default;
    CmdLine &operator=(const CmdLine &) = default;
    CmdLine &operator=(CmdLine &&) = default;

    //---------------------------------------------------------------------
    /// @details Returns a classic array of char ptrs
    //---------------------------------------------------------------------
    const char **argv() const noexcept {
        ASSERT(!m_argv.empty());
        return &m_argv.front();
    }

    //---------------------------------------------------------------------
    /// @details Return the number of arguments (including exec path)
    //---------------------------------------------------------------------
    int argc() const noexcept { return (int)m_argv.size(); }

    //---------------------------------------------------------------------
    /// @details Return a reference to the arguments
    //---------------------------------------------------------------------
    const std::vector<Text> &args() const noexcept { return m_args_processed; }

    //---------------------------------------------------------------------
    /// @details Return the number of the arguments
    //---------------------------------------------------------------------
    size_t size() const noexcept { return m_args_processed.size(); }

    //---------------------------------------------------------------------
    /// @details Return a const reference to an argument at an index
    //---------------------------------------------------------------------
    decltype(auto) at(size_t index) const noexcept {
        ASSERT(index < m_args_processed.size());
        return m_args_processed[index];
    }

    //---------------------------------------------------------------------
    /// @details Array operator accesses arg strings
    //---------------------------------------------------------------------
    TextView operator[](size_t index) const noexcept {
        ASSERT(index < m_args_processed.size());
        return m_args_processed[index];
    }

    //---------------------------------------------------------------------
    /// @details Returns a reference to the orginal arguments
    //---------------------------------------------------------------------
    auto &args_original() const noexcept { return m_args_original; }

    //---------------------------------------------------------------------
    /// @details Sets an argument to a new value
    //---------------------------------------------------------------------
    const Text &set(size_t index, Text val) noexcept {
        ASSERT(index < m_args_processed.size());

        m_args_processed[index] = val;
        updateArgv();

        return m_args_processed[index];
    }

    //---------------------------------------------------------------------
    /// @details Adds an arg
    //---------------------------------------------------------------------
    TextView addArg(Text val) noexcept {
        // Save the value in the processed args
        m_args_processed.push_back(val);

        // Update our argv
        updateArgv();

        // Return it
        return m_args_processed.back();
    }

    //---------------------------------------------------------------------
    /// @details Adds an arg
    //---------------------------------------------------------------------
    template <typename... Args>
    decltype(auto) add(Args &&...args) noexcept {
        (addArg(std::forward<Args>(args)), ...);
        return *this;
    }

    //---------------------------------------------------------------------
    /// @details Removes an argument at an index
    //---------------------------------------------------------------------
    auto remove(size_t index) noexcept {
        ASSERT(index < m_args_processed.size());
        auto arg = m_args_processed[index];

        // Remove it from the processed args only
        m_args_processed.erase(m_args_processed.begin() + index);

        // Move it to the removed list
        m_args_removed.push_back(arg);

        // Update our argv
        updateArgv();

        // Return it
        return arg;
    }

    //---------------------------------------------------------------------
    /// @details Removes an looked up argument
    //---------------------------------------------------------------------
    auto remove(TextView arg, bool caseAware = true) noexcept {
        return lookupOrRemoveInternal(arg, true, caseAware);
    }

    //---------------------------------------------------------------------
    /// @details Looks up an arg, optionally removes it, and returns it
    //---------------------------------------------------------------------
    Opt<Text> option(TextView arg, bool rem = false,
                     bool caseAware = true) noexcept {
        return lookupOrRemoveInternal(arg, rem, caseAware);
    }

    //---------------------------------------------------------------------
    /// @details Api to access the executable path, argv[0]
    //---------------------------------------------------------------------
    auto execPath(bool stripExec = false) const noexcept {
        file::Path path;
        if (m_execPath)
            path = m_execPath.value();
        else if (argc() > 1)
            path = m_args_processed.front();
        else
            return path;

        if (stripExec) return path.parent();
        return path;
    }

    //---------------------------------------------------------------------
    /// @details Sets the exec path
    //---------------------------------------------------------------------
    file::Path setExecPath(Text path) noexcept;

    //---------------------------------------------------------------------
    /// @details Allow this object to work with range fors
    //---------------------------------------------------------------------
    auto begin() const { return m_args_processed.begin() + 1; }
    auto end() const { return m_args_processed.end(); }
    auto rbegin() const { return m_args_processed.rbegin() - 1; }
    auto rend() const { return m_args_processed.rend(); }

    //---------------------------------------------------------------------
    /// @details Convert to a string
    //---------------------------------------------------------------------
    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        _tsbo(buff, {0, 0, ' '}, m_args_processed);
    }

    //---------------------------------------------------------------------
    /// @details Cast to text
    //---------------------------------------------------------------------
    operator Text() const noexcept { return _ts(*this); }

protected:
    //---------------------------------------------------------------------
    /// @details Rebuild the argv from the processed args
    //---------------------------------------------------------------------
    void updateArgv() noexcept {
        m_argv.clear();
        for (auto &arg : m_args_processed) m_argv.push_back(arg);
    }

    //---------------------------------------------------------------------
    /// @details Looks up and optional removes an argument from the args
    //---------------------------------------------------------------------
    Opt<Text> lookupOrRemoveInternal(TextView arg, bool rem,
                                     bool caseAware) noexcept {
        for (size_t i = 0; i < m_args_processed.size(); i++) {
            if (matches(arg, m_args_processed[i], caseAware)) {
                if (rem) return remove(i);
                return m_args_processed[i];
            }
        }

        if (rem) {
            for (auto &removedArg : m_args_removed) {
                if (matches(arg, removedArg, caseAware)) return removedArg;
            }
        }

        return {};
    }

    //---------------------------------------------------------------------
    /// @details Determines if a given pattern matches
    //---------------------------------------------------------------------
    bool matches(TextView pattern, TextView subject,
                 bool caseAware = true) const noexcept;

    //---------------------------------------------------------------------
    // Optional held ptr to execpath, to avoid ambiguities with
    // argv[0] on unix systems (which are not guaranteed to even
    // set argv[0]), we hold an overridden exec path here if set
    // otherwise we assume argv[0] is the exec path if this is empty
    //---------------------------------------------------------------------
    Opt<file::Path> m_execPath;

    //---------------------------------------------------------------------
    // Here's where we hold the Text converted arguments in a vector
    // The processed are "active" arguments, the removed are those that
    // that have either been explicitly removed or were an options
    //---------------------------------------------------------------------
    std::vector<Text> m_args_processed;
    std::vector<Text> m_args_removed;

    //---------------------------------------------------------------------
    // Original, unmodified parameters that we passed
    //---------------------------------------------------------------------
    std::vector<Text> m_args_original;

    //---------------------------------------------------------------------
    // Raw ptrs to the c_str's are held in another vector so that we
    // can pass our argv to other mains if needed. These are actually
    // base on the processed arguments so no recognized options are included
    //---------------------------------------------------------------------
    mutable std::vector<const Utf8Chr *> m_argv;
};
}  // namespace ap::application
