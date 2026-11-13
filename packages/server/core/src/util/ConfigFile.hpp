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
// This class loads, and manipulates config file formatted files
// typical of the old dos days of configs, works with samba config
// files primarily.
class ConfigFile final {
public:
    // Default construction
    ConfigFile() = default;
    ~ConfigFile() = default;

    // Default move and copy
    ConfigFile(ConfigFile &&cfg) = default;
    ConfigFile(const ConfigFile &cfg) = default;

    ConfigFile &operator=(const ConfigFile &cfg) = default;
    ConfigFile &operator=(ConfigFile &&cfg) = default;

    // Construct from a path
    // @throws
    // Error
    ConfigFile(TextView path) noexcept(false) {
        if (auto ccode = openPath(path)) throw ccode;
    }

    // Static allocator method
    static decltype(auto) open(TextView path) noexcept {
        return _call([&] { return ConfigFile{path}; });
    }

    // Check if opened
    explicit operator bool() const noexcept { return m_lines.empty() == false; }

private:
    // Declare our whitespace characters
    _const auto WhiteSpace = " \r\t"_tv;

    // Line represents a line in the config file, it holds the line
    // which is determined at load time
    class Line final {
    public:
        // Default construct/move/assign
        Line() = default;
        Line(Line &&) = default;
        Line(const Line &) = default;
        Line &operator=(Line &&) = default;
        Line &operator=(const Line &) = default;

        // Construct from a value
        Line(TextView value) noexcept
            : m_value(value), m_type(classify(value)) {}

        // Line type, comments start with ; or #, sections [, and
        // options have = in their line
        enum class TYPE { Comment, Section, Option };

        // Returns true if this line has been modified
        auto modified() const noexcept { return m_modified; }

        // Update this line value to a new value
        decltype(auto) operator=(const Text &newVal) noexcept {
            m_value = newVal;
            m_modified = true;
            return *this;
        }

        // This is the sanitized version of value, trims leading
        // trailing spaces and removes spaces following periods
        static TextView sanitize(TextView value) noexcept {
            return value.trim(WhiteSpace);
        }

        // Determine the type of this line
        static TYPE classify(TextView value) noexcept {
            value.trim(WhiteSpace);
            if (value.startsWith("[") && value.endsWith("]"))
                return TYPE::Section;
            if (value.startsWith(";") || value.startsWith("#"))
                return TYPE::Comment;
            if (value.contains("=")) return TYPE::Option;
            return TYPE::Comment;
        }

        // This method returns a text view of the value for the
        // line itself, or newVal if set
        TextView value(bool sanitize = false) const noexcept {
            if (sanitize) return this->sanitize(m_value);
            return m_value;
        }

        // Compares this line to another
        decltype(auto) operator==(const Line &lhs) noexcept {
            return value(true) == lhs.value(true);
        }

        // Type accessor
        auto type() const noexcept { return m_type; }

    private:
        // This line type
        TYPE m_type;

        // Value of the option
        Text m_value;

        // When true means we were modified in memory
        bool m_modified = false;
    };

    // Alias our line list, we use a list so we can leverage their
    // indestructible iterators
    using Lines = std::list<Line>;
    using LinePos = Lines::const_iterator;

    // Option is used to break apart an option value pair
    struct Option final {
        static auto parse(const Line &line) noexcept {
            ASSERT(line.type() == Line::TYPE::Option);
            auto [name, value] = line.value().slice('=');
            return makePair(iText{Line::sanitize(name)},
                            value.trimLeft(WhiteSpace));
        }
    };

    // Key is a mini namespace hosting helper apis related to parsing
    // a user key path which is in the form: Section.Option
    struct Key final {
        static auto parse(TextView key) noexcept {
            auto [section, option] = key.slice('[').second.slice(']');
            return makePair(section, iTextView{option.trim(WhiteSpace)});
        }
    };

    // Looks up a section after breaking apart the key
    auto lookupSection(TextView key) const noexcept {
        auto [sectionName, optionName] = Key::parse(key);
        auto iter = m_sections.find(sectionName);
        if (iter == m_sections.end())
            return makeTuple(sectionName, optionName, m_sections.end());
        return makeTuple(sectionName, optionName, _mv(iter));
    }

    // A section holds lines in it
    struct Section {
        iTextView name;
        LinePos linePos;
        mutable std::map<iText, LinePos> options;
    };

    // Adds a section to the line list and updates the section index
    decltype(auto) addSection(iTextView name) noexcept {
        m_lines.emplace_back(Line{_fmt("[", name, "]")});
        return *m_sections.emplace(Section{name, --m_lines.end()}).first;
    }

    // Adds an option to a section
    decltype(auto) addOption(const Section &section, iTextView optionName,
                             Text value) noexcept {
        m_lines.emplace_back(Line{_fmt(" {} = {}", optionName, value)});
        return section.options[optionName] = --m_lines.end();
    }

public:
    // Looks up a value from the global section
    template <typename T = Text>
    auto lookup(TextView key, T defaultValue = {}) const noexcept {
        static_assert(
            !(traits::IsStdStringViewV<T> && traits::IsStdStringViewV<T>),
            "Cannot read config with views");
        auto [sectionName, optionName, section] = lookupSection(key);
        if (section == m_sections.end()) return _mv(defaultValue);

        auto option = section->options.find(optionName);
        if (option == section->options.end()) return _mv(defaultValue);

        auto [_optionName, value] = Option::parse(*option->second);
        auto res = _fsc<T>(value);
        if (res.check()) return _mv(defaultValue);
        return _mv(res.value());
    }

    // Looks up a value from the global section
    template <typename T>
    auto apply(TextView key, const T &value) noexcept {
        auto [sectionName, optionName, section] = lookupSection(key);
        if (section == m_sections.end()) {
            addOption(addSection(sectionName), optionName, _ts(value));
            return;
        }
        auto option = section->options.find(optionName);
        if (option == section->options.end()) {
            addOption(*section, optionName, _ts(value));
            return;
        }
        const_cast<Line &>((*(option->second))) =
            _fmt("{} = {}", optionName, _ts(value));
    }

    // Remove a section or option
    // @returns
    // Boolean true if something was removed
    auto remove(TextView key) noexcept {
        auto [sectionName, optionName, section] = lookupSection(key);
        if (section == m_sections.end()) return false;

        // If an option name was specified just remove the option
        // otherwise remove the entire section
        if (optionName) {
            auto option = section->options.find(optionName);
            if (option != section->options.end()) {
                auto [name, pos] = *option;
                m_lines.erase(pos);
                section->options.erase(option);
                return true;
            }
            return false;
        }

        // Delete all lines up to the final option or the next section
        Opt<LinePos> lastOption;
        for (auto iter = std::next(section->linePos); iter != m_lines.end();) {
            if (iter->type() == Line::TYPE::Section) {
                if (!lastOption) lastOption = iter;
                break;
            }
            if (iter->type() == Line::TYPE::Option) lastOption = iter;

            iter++;
        }
        m_lines.erase(section->linePos, lastOption.value_or(m_lines.end()));
        if (lastOption) m_lines.erase(*lastOption);
        m_sections.erase(section);
        return true;
    }

    // Commits changes to disk
    auto commit() noexcept {
        Text data;
        for (auto &line : m_lines) data += line.value() + "\n";
        return file::put(m_path, data);
    }

private:
    // Opens a path and loads its sections
    Error openPath(TextView path) noexcept {
        // Clear state for a re-open
        m_lines.clear();
        m_path = path;

        // Load the data
        auto data = file::fetch<TextChr>(m_path);
        if (!data) return _mv(data.ccode());

        // Transform the text lines into line objects
        m_lines = util::transform<Lines>(
            string::split(*data, "\n", true), [&](auto lineString) noexcept {
                return Line{lineString.trimTrailing({'\r'})};
            });

        // Now build the section index, always a global section on first
        // use
        Opt<Ref<const Section>> section;

        for (auto iter = m_lines.begin(); iter != m_lines.end(); iter++) {
            if (iter->type() == Line::TYPE::Section) {
                auto key = iter->value();
                section =
                    *m_sections.emplace(Section{key.trim("[]"), iter}).first;
            } else if (iter->type() == Line::TYPE::Option) {
                if (!section)
                    section =
                        *m_sections.emplace(Section{"", m_lines.begin()}).first;
                auto [optionName, value] = Option::parse(iter->value());
                section->get().options[_mv(optionName)] = iter;
            }
        }
        return {};
    }

    // Loaded lines
    Lines m_lines;

    // Define a heterogeneous comparator so we don't have to
    // allocate texts during lookup
    struct Comparator {
        // Set the is_transparent flag, this allows this to work
        using is_transparent = std::true_type;

        bool operator()(const Section &lhs, const Section &rhs) const noexcept {
            return lhs.name < rhs.name;
        }

        bool operator()(const iTextView &lhs,
                        const Section &rhs) const noexcept {
            return lhs < rhs.name;
        }

        bool operator()(const Section &lhs,
                        const iTextView &rhs) const noexcept {
            return lhs.name < rhs;
        }
    };

    // Section index, indexes a section to its position in the
    // lines array
    std::set<Section, Comparator> m_sections;

    // Copy of the path
    Text m_path;
};

}  // namespace ap::util
