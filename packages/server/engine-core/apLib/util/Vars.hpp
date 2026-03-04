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

// Vars is a contextual macro expansion utility to expand
// custom keys enclosed by %'s
class Vars final {
public:
    using Container = FlatMap<iText, Text>;

    void add(iText key, Text val) noexcept {
        m_vars[_mv(expandEnvInplace(key))] = _mv(expandEnvInplace(val));
    }

    // This now works as expected:
    //      If a %% is found, it will be replaced with a single %
    //      If the %key% is found, it will be replaced by the value
    template <typename ChrT, typename TraitsT, typename AllocT>
    decltype(auto) expandInplace(
        string::Str<ChrT, TraitsT, AllocT> &str) const noexcept {
        if (!str || m_vars.empty()) return str;

        size_t cursor = 0;
        while (cursor < str.size()) {
            // Step 1: Find the next '%'
            size_t start = str.find('%', cursor);
            if (start == std::string::npos) break;

            // Step 2: Check if it's "%%"
            if (start + 1 < str.size() && str[start + 1] == '%') {
                // Replace "%%" with "%"
                str.erase(start, 1);
                cursor = start + 1;  // Move past the single '%'
                continue;
            }

            // Step 3: Find the closing '%'
            size_t end = str.find('%', start + 1);
            if (end == std::string::npos)
                break;  // No closing '%', stop processing

            // Extract token name
            ap::string::Str<ap::Utf8Chr, ap::string::NoCase<char>,
                            std::allocator<char>>
                token = str.substr(start + 1, end - start - 1);

            // Step 4: Replace %key% if found, otherwise continue from end '%'
            if (auto iter = m_vars.find(token); iter != m_vars.end()) {
                str.replace(start, end - start + 1, iter->second);
                cursor =
                    start + iter->second.size();  // Move past the replacement
            } else {
                // Treat the closing '%' as the new starting '%'
                cursor = end;
            }
        }

        return expandEnvInplace(str);
    }

    [[nodiscard]] auto expand(Text str) const noexcept {
        expandInplace(str);
        return str;
    }
    static Text expandRequired(iTextView str, Text key, Text keyVal) noexcept {
        Vars vars;
        vars.add(key, _mv(keyVal));
        ASSERTD(str.contains("%" + key + "%"));
        return vars.expand(str);
    }

    static Text expand(iTextView str, Text key, Text keyVal) noexcept {
        Vars vars;
        vars.add(key, _mv(keyVal));
        return vars.expand(str);
    }

    template <typename Val>
    static auto __fromJson(Vars &vars, const Val &val) noexcept {
        if (val.isObject()) {
            for (auto &&key : val.keys())
                vars.add(_mv(key), val.template lookup<Text>(key));
        }
    }

    explicit operator bool() const noexcept { return m_vars.empty() == false; }

private:
    template <typename ChrT, typename TraitsT, typename AllocT>
    string::Str<ChrT, TraitsT, AllocT> &expandEnvInplace(
        string::Str<ChrT, TraitsT, AllocT> &val) const noexcept {
        // Allow $ENV[key1,key2] to expand to the system env value
        if (val.startsWith("$ENV[") && val.contains("]")) {
            string::Str<ChrT, TraitsT, AllocT> res(val.get_allocator());

            // Extract the env keys from what may be trailing items in the list
            auto [keys, trailing] = val.slice(']', {}, true);

            for (auto key : string::extract(keys, '[', ']').split(',')) {
                auto env = plat::env(key);
                ASSERTD_MSG(env, "Invalid env added to vars", val);
                res += env;
            }
            ASSERTD_MSG(res, "Invalid env added to vars", val);
            val = res.append(trailing);
        }

        return val;
    }

    Container m_vars;
};

}  // namespace ap::util
