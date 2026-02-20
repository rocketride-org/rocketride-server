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

namespace engine::perms {
template <typename MapT>
class KeyStatusMap {
public:
    static_assert(traits::IsMapV<MapT> || traits::IsUnorderedMapV<MapT>,
                  "Invalid argument, map types only");
    using KeyT = traits::KeyT<MapT>;
    using StatusT = traits::MappedT<MapT>;
    using AllocT = typename MapT::allocator_type;

    KeyStatusMap(const AllocT &alloc = {}) : m_map(alloc) {}

    KeyStatusMap(const KeyStatusMap &) = default;
    KeyStatusMap &operator=(const KeyStatusMap &) = default;

    KeyStatusMap(KeyStatusMap &&) = default;
    KeyStatusMap &operator=(KeyStatusMap &&) = default;

    Opt<StatusT> lookupStatus(const KeyT &key) const noexcept {
        auto lock = m_lock.readLock();
        auto it = m_map.find(key);
        if (it != m_map.end())
            return it->second;
        else
            return {};
    }

    void updateStatus(const KeyT &key, const StatusT &status) noexcept {
        auto lock = m_lock.writeLock();
        // Search the map and keep the emplacement hint
        bool keyFound = false;
        auto it = m_map.lower_bound(key);
        if (it != m_map.end()) {
            if constexpr (traits::IsMapV<MapT>)
                keyFound = m_map.key_comp()(key, it->first);
            else if constexpr (traits::IsUnorderedMapV<MapT>)
                keyFound = m_map.key_eq()(key, it->first);
        }

        if (keyFound) {
            // If the key is ever mapped successfully, treat it as successfully
            // mapped going forward
            if (!it->second) it->second = status;
        } else
            m_map.emplace_hint(it, key, status);
    }

private:
    MapT m_map;
    mutable async::SharedLock m_lock;
};

}  // namespace engine::perms
