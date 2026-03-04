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

//
//	The rocketride logger api implementation
//
#pragma once

namespace ap::log {

// This function stores the static instantiation for the Level states
// array, each level state is indexed by its corresponding level id
inline LvlStateArray &LvlState() noexcept {
    static LvlStateArray states = {};
    return states;
}

// Maps a level from a Lvl enum, a TextView, or a uint32_t level id
// if a valid level is encountered the Lvl enum will be returned
// any invalid ones a lvl value of Lvl::_begin will be returned.
inline Lvl mapLogLevel(Lvl lvl) noexcept { return lvl; }

inline Lvl mapLogLevel(iText lvl) noexcept {
    auto str = lvl.trim();
    return _fsc<Lvl>(str).valueOr(Lvl::_end);
}

inline Lvl mapLogLevel(uint32_t lvl) noexcept {
    return mapLogLevel(EnumFrom<Lvl>(lvl));
}

// Enumerates passed in args to all of our log control apis,
// smart enough to auto expand any strings with comma delimiters
template <typename Callback, typename... Levels>
inline Error enumerateLevelStates(Callback &&callback,
                                  Levels &&...levels) noexcept {
    auto processLevelArgs = [&](const auto &lvl) noexcept -> Error {
        if constexpr (std::is_constructible_v<Text, decltype(lvl)>) {
            Text lvls{lvl};
            for (auto &&lvlStr : lvls.split(',')) {
                if (auto id = mapLogLevel(lvlStr); id != Lvl::_end)
                    callback(LvlState()[EnumIndex(id)], id);
                else if constexpr (plat::IsRelease)
                    LOG(Always, "WARNING: Invalid log level:", lvlStr);
                else
                    return APERR(Ec::NotFound, "Invalid log level:", lvlStr);
            }
        }
        // If its a tuple, explode it out
        else if constexpr (traits::IsTupleV<decltype(lvl)>) {
            _forEach(lvl,
                     [&](auto id) { callback(LvlState()[EnumIndex(id)], id); });
        } else {
            auto &state = LvlState();
            if (auto id = mapLogLevel(lvl); id != Lvl::_end)
                callback(state[EnumIndex(id)], id);
            else
                return APERR(Ec::NotFound, "Invalid log level:", lvl);
        }

        return {};
    };

    return (processLevelArgs(levels), ...);
}

// Enables a log level, a level may be specified by its numeric
// id or its string name.
template <bool Sticky, typename... Levels>
inline Error disableLevel(Levels &&...levels) noexcept {
    return enumerateLevelStates(
        [&](auto &state, auto id) noexcept {
            if (!state.sticky || Sticky) {
                state.sticky = false;
                state.enabled = false;
            }
        },
        std::forward<Levels>(levels)...);
}

// Enables a log level, a level may be specified by its numeric
// id or its string name. Also allows for a sticky bit, the sticky bit
// when set on a level prevents it from being disabled when
// disableAllLevels is called. Sticky bit levels can only be
// disabled by an explicit call to disable.
template <bool Sticky, typename... Levels>
inline Error enableLevel(Levels &&...levels) noexcept {
    return enumerateLevelStates(
        [&](auto &state, auto id) noexcept {
            state.enabled = true;
            if (Sticky) state.sticky = Sticky;
        },
        std::forward<Levels>(levels)...);
}

// Checks to see if all of the levels specified are enabled. a level
// may be specified by its numeric id or its string name.
// The log level must be explicitly enabled, i.e. "all" is ignored
template <bool Conjunction, typename... Levels>
inline bool isLevelExplicitlyEnabled(Levels &&...levels) noexcept {
    auto notEnabledCount = 0, enabledCount = 0;
    enumerateLevelStates(
        [&](auto &state, auto id) noexcept {
            if (state.enabled || id == Lvl::Always)
                enabledCount++;
            else if (!state.enabled)
                notEnabledCount++;
        },
        std::forward<Levels>(levels)...);

    if constexpr (Conjunction)
        return notEnabledCount == 0;
    else
        return enabledCount > 0;
}

// Checks to see if all of the levels specified are enabled. a level
// may be specified by its numeric id or its string name.
template <bool Conjunction, typename... Levels>
inline bool isLevelEnabled(Levels &&...levels) noexcept {
    if (LvlState()[EnumIndex(Lvl::All)].enabled) return true;

    return isLevelExplicitlyEnabled<Conjunction>(
        std::forward<Levels>(levels)...);
}

// Disables all levels, excluding any marked sticky
inline void disableAllLevels() noexcept {
    // Disable all non sticky levels
    for (auto &state : LvlState()) {
        if (!state.sticky) state.enabled = false;
    }
}

// Returns a comma delimited string of enabled levels
template <>
inline Text getEnabledLevels() noexcept {
    Text result;

    for (auto i : Lvl{}) {
        auto name = LvlNames[EnumIndex(i)];
        if (!name) continue;
        auto &state = LvlState()[EnumIndex(i)];
        if (state.enabled) {
            if (result) result += ",";
            result += name;
        }
    }

    return result;
}

// Allocates a log scope
template <typename... Levels>
util::Scope enableLevelScope(Levels &&...levels) noexcept {
    log::enableLevel(levels...);
    return util::Scope([=] { log::disableLevel(levels...); });
}

}  // namespace ap::log
