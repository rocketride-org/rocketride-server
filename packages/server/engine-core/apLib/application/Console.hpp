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

//<summary>
// InteractiveConsole - Hosts an interactive console session, using libedit
// style semantics. Supports command/help/colors at the console.
class InteractiveConsole {
public:
    InteractiveConsole(TextView name, FilePath historyFile) noexcept
        : m_historyFile(_mv(historyFile)), m_name(name) {
        rx_.install_window_change_handler();
        rx_.history_load(_ts(m_historyFile).data());
        rx_.set_max_history_size(999);
        rx_.set_max_line_size(256);
        rx_.set_word_break_characters(" ");

        rx_.set_completion_callback(
            [](auto ctx, auto index, auto data) {
                return static_cast<InteractiveConsole *>(data)->onCompletion(
                    ctx, index);
            },
            this);

        rx_.set_hint_callback(
            [](auto ctx, auto idx, auto color, auto data) {
                return static_cast<InteractiveConsole *>(data)->onHint(ctx, idx,
                                                                       color);
            },
            this);

        rx_.set_highlighter_callback(
            [](auto ctx, auto colors, auto data) {
                return static_cast<InteractiveConsole *>(data)->onColor(ctx,
                                                                        colors);
            },
            this);

        // Register sections, and their definitions as primary commands for auto
        // completion and help rendering. This allows you to just type in the
        // config name and apply its value without a leading config command key.
        for (auto &section : config::SectionManager::instance().sections()) {
            registerCommand(
                section->name(),
                {_ts("Config section: ", section->name()),
                 std::bind(&InteractiveConsole::onConfig, this, _1)});

            for (auto &option : section->definitions()) {
                registerCommand(
                    option.key().name(),
                    {option.description(),
                     std::bind(&InteractiveConsole::onConfig, this, _1),
                     std::bind(&InteractiveConsole::onCompleteConfig, this, _1,
                               _2),
                     " ="});
            }
        }
    }

    void run() {
        // display initial welcome message
        cout << m_name << "\n"
             << "Press 'tab' to view autocompletions\n"
             << "Type '.help' for help\n"
             << "Type '.quit' to exit\n\n";

        // main repl loop
        while (!async::isCancelled()) {
            auto e = error::block(_location, [&] { processInput(); });
            if (e) cout << "Error:" << e->message() << "\n";

            continue;
        }
    }

protected:
    //
    // Params - Holder of the params argument vector, provides helper apis to
    // easily check params and convert them.
    //
    struct Params {
        Params(std::vector<Str> args) : command_(_mv(args.front())) {
            if (args.size() > 1)
                std::copy(args.begin() + 1, args.end(),
                          std::back_inserter(argv_));
        }

        template <int Index>
        Str selectArg(bool throwIfInvalid) const {
            if constexpr (Index < 0) return command_;

            if (Index >= argv_.size()) {
                if (throwIfInvalid)
                    Ec::THROW(InvalidArgument, "No argument at index:", Index);
                return {};
            }
            return argv_[Index];
        }

        template <typename T, int Index = 0>
        T get() const {
            return _tr<T>(selectArg<Index>(true));
        }

        template <typename T, int Index = 0>
        T getOpt(T def) const {
            if (auto arg = selectArg<Index>(false); arg) return _tr<T>(arg);
            return def;
        }

        template <typename T, int Index = 0>
        std::optional<T> getOpt() const {
            if (auto arg = selectArg<Index>(false); arg) return _tr<T>(arg);
            return {};
        }

        size_t size() const noexcept { return argv_.size(); }
        decltype(auto) command() const noexcept { return command_; }

        std::vector<Str> argv_;
        Str command_;
    };

    //
    // CommandHandler - This structure defines a command handler, it contains
    // callbacks for command execution/completion and stores the help text
    // printed when someone uses the .help command.
    //
    struct CommandHandler {
        Str description;
        std::function<void(Params)> executeCb;
        std::function<Replxx::completions_t(Str const &context, int index)>
            completionCb;
        Str wordBreakCharacters = " ";
    };

    virtual void onInput(const char *input) { watchTasks_.stop(); }

    virtual void processInput() {
        // display the prompt and retrieve input from the user
        char const *cinput{nullptr};
        do {
            auto stats = memory::stats();
            auto _prompt = prompt();

            // Include the additional memory used if set (currently only JVM
            // heap usage)
            Text promptText;
            if (Size additionalMemoryUsed =
                    log::options().additionalMemoryUsed.load()) {
                promptText = _ts(
                    _prompt.first, "<", _prompt.second, "[",
                    stats.virtualMemoryUsedByProcess, "|",
                    stats.physicalMemoryUsedByProcess, "|",
                    additionalMemoryUsed, "|",
                    Count(
                        signals::internal::SlotContextTable::instance().size()),
                    "]>");
            } else {
                promptText = _ts(
                    _prompt.first, "<", _prompt.second, "[",
                    stats.virtualMemoryUsedByProcess, "|",
                    stats.physicalMemoryUsedByProcess, "|",
                    Count(
                        signals::internal::SlotContextTable::instance().size()),
                    "]>");
            }

            cinput = rx_.input(_mv(promptText));
            onInput(cinput);
        } while ((cinput == nullptr) && (errno == EAGAIN));

        if (cinput == nullptr || strlen(cinput) == 0) return;

        execute(cinput);
    }

    void execute(Str cinput) {
        rx_.history_add(cinput);
        rx_.history_save(_ts(m_historyFile).data());

        auto args = string::splitVector(" ", cinput);
        if (args.size() == 1 && string::count("=", cinput)) {
            auto [_cmd, _leaf] = string::split("=", cinput);

            // Do a little something special for the config case here
            if (auto iter = commands_.find(_cmd); iter != commands_.end()) {
                if (string::count("=", iter->second.wordBreakCharacters)) {
                    cout << "\n";
                    auto e = error::block(_location, iter->second.executeCb,
                                          std::vector<Str>{cinput});
                    cout << "\n";
                    if (e) cout << e << "\n";
                    return;
                }
            }
        }

        if (!args.empty()) {
            if (auto iter = commands_.find(args.front());
                iter != commands_.end()) {
                cout << "\n";
                auto e = error::block(_location, iter->second.executeCb, args);
                cout << "\n";
                if (e) cout << e << "\n";
                return;
            }
        }

        cout << "Invalid command" << "\n";
        onHelp();
    }

    //
    // prompt - Requires two keys, the first key is placed in the prefix
    // portion of the prompt, and the second is placed within <>'s as the
    // second entry.
    //
    virtual std::pair<Str, Str> prompt() const = 0;

    // Auto complete configurations
    virtual Replxx::completions_t onCompleteConfig(Str const &context,
                                                   int index) {
        if (index >= context.size()) return {};

        Str key{context.substr(index)};
        Replxx::completions_t completions;

        auto sections = config::SectionManager::instance().sections();

        if (string::count("=", key)) {
            auto _key = config::Key::parse(key, false);

            for (auto &section : sections) {
                if (!string::startsWith(section->name(), key) &&
                    section->name() != _key.section())
                    continue;
                // Hunt for options next
                for (auto &option : section->definitions()) {
                    // If equals is used auto-complete the value of the config
                    // in place
                    if (string::startsWith(_ts(option.key().name(), "="), key))
                        completions.emplace_back(
                            _ts(option.key().name(), "=",
                                config::fetch<Str>(option.key())));
                    else if (string::startsWith(option.key().name(), key))
                        completions.emplace_back(option.key().name());
                }
            }
        } else {
            if (!key) {
                for (auto &section : sections)
                    completions.emplace_back(section->name());
                return completions;
            }
        }

        return completions;
    }

    // Auto complete watch
    Replxx::completions_t onCompleteWatch(Str const &context, int index) {
        return onCompletion(context, index);
    }

    void onMemory(Params params) { cout << memory::stats(); }

    void onHandle(Params params) {
        auto slots =
            signals::internal::SlotContextTable::instance().allocatedSlots();
        cout << "\n  " << _tsd("\n  ", slots) << "\n";
    }

    void onWatch(Params params) {
        watchTasks_ << async::task::start(
            _ts("Watch:", params.get<Str>()),
            [this](Str command, time::Duration interval) {
                while (!async::isCancelled()) {
                    execute(command);
                    async::sleep(interval);
                }
            },
            params.get<Str>(), params.getOpt<time::Duration, 1>(5s));
    }

    virtual void onConfig(Params params) {
        Str key;
        if (params.size())
            key = params.get<Str>();
        else if (params.command() == "config")
            SWEc::THROW(InvalidArgument, "Missing required arg");
        else
            key = params.command();

        // To apply a config just write 'section.option=value', to print
        // a config value write 'section.option'
        auto [option, value] = string::split("=", key);
        auto _key = config::Key::parse(option, false);

        // Attempt to resolve the option/section
        config::Option _option;
        config::Section::Ptr _section;
        if (_key) {
            _option = config::lookupOption(_key, false);
            _section = config::lookupSection(_key.name(), false);
            if (!_section)
                _section = config::lookupSection(_key.section(), false);
        } else {
            _section = config::lookupSection(key, false);
        }

        if (value) {
            if (_option) {
                applyConfig(_key, value);
            } else {
                cout << "Invalid option" << "\n";
            }
        } else {
            if (!_option && _section) {
                cout << "Section: " << _key.name() << "\n";
                for (auto &def : _section->definitions())
                    cout << "  " << def.key() << "=" << fetchConfig(def.key())
                         << "\n";
            } else if (_option) {
                cout << "Section: " << _option.key().section() << "\n";
                cout << "  Option: " << _option.key().option() << "\n";
                cout << "  Description: " << _option.description() << "\n";
                cout << "  Current value: " << fetchConfig(_key) << "\n";
            } else {
                cout << "Invalid option" << "\n";
            }
        }
    }

    virtual void onHistory() {
        // display the current history
        for (size_t i = 0, sz = rx_.history_size(); i < sz; ++i)
            cout << std::setw(4) << i << ": "
                 << rx_.history_line(numericCast<int>(i)) << "\n";
    }

    virtual void onQuit() {
        // Cancel the thread we're running on (main works too here)
        async::cancel();
    }

    virtual void onClear() { rx_.clear_screen(); }

    virtual void onHelp() {
        for (auto &entry : commands_)
            cout << entry.first << "\n\t" << entry.second.description << "\n";
    }

    virtual Replxx::completions_t onCompletion(Str const &context, int index) {
        Replxx::completions_t completions;
        Str prefix{context.substr(index)};

        // First lookup the command handler to find a completion handler
        // callback
        if (context) {
            for (const auto &entry : commands_) {
                // Once we notice it starts with the command name, plus a space
                // hand off to it for processing
                auto match = util::anyOf(
                    entry.second.wordBreakCharacters, [&](const auto &chr) {
                        return string::startsWith(context, entry.first + chr,
                                                  false);
                    });
                if (match) {
                    if (entry.second.completionCb)
                        return entry.second.completionCb(prefix, 0);
                }
            }
        }

        for (const auto &entry : commands_) {
            if (!prefix || string::startsWith(entry.first, prefix, false))
                completions.emplace_back(entry.first);
        }

        return completions;
    }

    virtual Replxx::hints_t onHint(Str const &context, int index,
                                   Replxx::Color &color) {
        Replxx::hints_t hints;

        // only show hint if prefix is at least 'n' chars long
        // or if prefix begins with a specific character
        Str prefix{context.substr(index)};

        if (prefix.size() >= 2 || (!prefix.empty() && prefix.at(0) == '.')) {
            for (const auto &entry : commands_) {
                if (prefix.size() >= entry.first.size()) continue;
                if (string::startsWith(prefix, entry.first, false))
                    hints.emplace_back(
                        entry.first.substr(prefix.size()).c_str());
            }
        }

        // set hint color to green if single match found
        if (hints.size() == 1) color = Replxx::Color::GREEN;

        return hints;
    }

    virtual void onColor(Str const &context, Replxx::colors_t &colors) {
        // highlight matching regex sequences
        for (auto const &entry : regexColors_) {
            size_t pos{0};
            std::string str = context;
            std::smatch match;

            while (std::regex_search(str, match, std::regex(entry.first))) {
                std::string c{match[0]};
                pos += std::string(match.prefix()).size();

                for (size_t i = 0; i < c.size(); ++i)
                    colors.at(pos + i) = entry.second;

                pos += c.size();
                str = match.suffix();
            }
        }
    }

    // Base commands
    std::map<iStr, CommandHandler> commands_ = {
        {".quit",
         {"Exits the console", std::bind(&InteractiveConsole::onQuit, this)}},
        {".help",
         {"Prints help for commands",
          std::bind(&InteractiveConsole::onHelp, this)}},
        {".clear",
         {"Clears the screen", std::bind(&InteractiveConsole::onClear, this)}},
        {".history",
         {"Shows command history",
          std::bind(&InteractiveConsole::onHistory, this)}},
        {"watch",
         {
             "Run a command repeatedly to monitor its output",
             std::bind(&InteractiveConsole::onWatch, this, _1),
             std::bind(&InteractiveConsole::onCompleteWatch, this, _1, _2),
         }},
        {"config",
         {
             "Fetch/Apply configuration options",
             std::bind(&InteractiveConsole::onConfig, this, _1),
             std::bind(&InteractiveConsole::onCompleteConfig, this, _1, _2),
         }},
        {"handle",
         {"Show handle allocations",
          std::bind(&InteractiveConsole::onHandle, this, _1)}},
        {"memory",
         {"Show memory allocations",
          std::bind(&InteractiveConsole::onMemory, this, _1)}},
    };

    virtual void registerCommand(StrView key, CommandHandler &&handler) {
        commands_[key.data()] = _mv(handler);
    }

    // Regex matched color encoders
    std::vector<std::pair<Str, Replxx::Color>> regexColors_ = {
        // single chars
        {"\\`", Replxx::Color::BRIGHTCYAN},
        {"\\'", Replxx::Color::BRIGHTBLUE},
        {"\\\"", Replxx::Color::BRIGHTBLUE},
        {"\\-", Replxx::Color::BRIGHTBLUE},
        {"\\+", Replxx::Color::BRIGHTBLUE},
        {"\\=", Replxx::Color::BRIGHTBLUE},
        {"\\/", Replxx::Color::BRIGHTBLUE},
        {"\\*", Replxx::Color::BRIGHTBLUE},
        {"\\^", Replxx::Color::BRIGHTBLUE},
        {"\\.", Replxx::Color::BRIGHTMAGENTA},
        {"\\(", Replxx::Color::BRIGHTMAGENTA},
        {"\\)", Replxx::Color::BRIGHTMAGENTA},
        {"\\[", Replxx::Color::BRIGHTMAGENTA},
        {"\\]", Replxx::Color::BRIGHTMAGENTA},
        {"\\{", Replxx::Color::BRIGHTMAGENTA},
        {"\\}", Replxx::Color::BRIGHTMAGENTA},

        // commands
        {"\\.help", Replxx::Color::BRIGHTMAGENTA},
        {"\\.history", Replxx::Color::BRIGHTMAGENTA},
        {"\\.quit", Replxx::Color::BRIGHTMAGENTA},
        {"\\.clear", Replxx::Color::BRIGHTMAGENTA},

        // numbers
        {"[\\-|+]{0,1}[0-9]+", Replxx::Color::YELLOW},           // integers
        {"[\\-|+]{0,1}[0-9]*\\.[0-9]+", Replxx::Color::YELLOW},  // decimals
        {"[\\-|+]{0,1}[0-9]+e[\\-|+]{0,1}[0-9]+",
         Replxx::Color::YELLOW},  // scientific notation

        // strings
        {"\".*?\"", Replxx::Color::BRIGHTGREEN},  // double quotes
        {"\'.*?\'", Replxx::Color::BRIGHTGREEN},  // single quotes
    };

    // Specialize to direct the fetch and apply logic to a specific config
    // context default is the global context
    virtual void applyConfig(config::Key key, const Str &value) {
        config::apply(key, value);
    }
    virtual Str fetchConfig(config::Key key) { return config::fetch<Str>(key); }

    Replxx rx_;
    const TExt m_name;
    const FilePath m_historyFile;
    async::work::Group m_watchTasks;
};

}  // namespace sw::application

}  // namespace ap::application
