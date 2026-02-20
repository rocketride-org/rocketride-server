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

static const Text NULL_SID = "S-1-0-0";
static const Text WORLD_SID = "S-1-1-0";
static const Text LOCAL_SID = "S-1-2-0";
static const Text CREATOR_OWNER_ID_SID = "S-1-3-0";
static const Text CREATOR_GROUP_ID_SID = "S-1-3-1";

static bool matchesWellKnownSID(const Text& input) {
    return (input == NULL_SID || input == WORLD_SID || input == LOCAL_SID ||
            input == CREATOR_OWNER_ID_SID || input == CREATOR_GROUP_ID_SID);
}

struct Permission {
    Text principalId;
    Rights rights;

    bool operator<(const Permission& other) const noexcept {
        return principalId < other.principalId ||
               (!(other.principalId < principalId) && rights < other.rights);
    }

    bool operator==(const Permission& other) const noexcept {
        return principalId == other.principalId && rights == other.rights;
    }

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        buff << principalId << "|" << rights;
    }
};

struct PermissionSet {
    Text ownerId;
    std::set<Permission> perms;
    size_t index = {};

    uint32_t id() const noexcept {
        // permissionSetId is 1-based to make it simpler for TypeScript
        return _cast<uint32_t>(index + 1);
    }

    // Ignore index when calculating identity
    bool operator<(const PermissionSet& other) const noexcept {
        return ownerId < other.ownerId ||
               (!(other.ownerId < ownerId) && perms < other.perms);
    }

    bool operator==(const PermissionSet& other) const noexcept {
        return ownerId == other.ownerId && perms == other.perms;
    }

    bool operator!=(const PermissionSet& other) const noexcept {
        return !(*this == other);
    }

    bool empty() const noexcept { return !ownerId && perms.empty(); }

    explicit operator bool() const noexcept { return !empty(); }

    void __toJson(json::Value& val) const noexcept {
        val["ownerId"] = ownerId;
        val["perms"] = json::Value(json::arrayValue);
        val["index"] = index;

        json::Value permVal;

        for (const auto& [principal, rights] : perms) {
            permVal["principalId"] = principal;
            permVal["rights"] = _ts(rights);
            val["perms"].append(permVal);
        }
    }

    static Error __fromJson(PermissionSet& permissionSet,
                            const json::Value& val) noexcept {
        if (!val.isObject())
            return APERR(Ec::InvalidJson, "PermissionSet type must be object",
                         val);

        if (auto value = val.getKey("ownerId"))
            permissionSet.ownerId = value->asString();
        else
            return APERR(Ec::InvalidJson,
                         "Missing ownerId property in PermissionSet object",
                         val);

        if (auto value = val.getKey("index"))
            permissionSet.index = value->asUInt64();
        else
            return APERR(Ec::InvalidJson,
                         "Missing index property in PermissionSet object", val);

        if (auto value = val.getKey("perms"); value && value->isArray()) {
            for (auto& v : *value) {
                Permission perm;
                perm.principalId = v["principalId"].asString();
                perm.rights = _fs<Rights>(v["rights"].asString());
                permissionSet.perms.insert(perm);
            }
        } else {
            return APERR(Ec::InvalidJson,
                         "Missing perms property in PermissionSet object", val);
        }

        return {};
    }
};

using PermissionSetList = std::set<PermissionSet>;

class PermissionSetBuilder {
public:
    // Add unique permissions
    uint32_t add(PermissionSet perms) noexcept {
        if (!perms) {
            LOG(Permissions, "Cannot add empty permission set");
            return {};
        }

        // Check if the entry already exists (ignores index)
        _using(auto lock = m_lock.readLock()) {
            if (auto it = m_perms.find(perms); it != m_perms.end())
                return it->id();
        }

        // Add the entry
        _using(auto lock = m_lock.writeLock()) {
            // Check to see if it was added by some other thread between locks
            auto hint = m_perms.lower_bound(perms);
            if (hint != m_perms.end() && *hint == perms) return hint->id();

            // Initialize the index
            perms.index = m_perms.size();
            m_perms.insert(hint, _mv(perms));
            ASSERT_MSG(m_perms.size() > perms.index,
                       "Permission set identity failed");
            return perms.id();
        }
    }

    auto add(Text&& ownerId, std::set<Permission>&& perms) noexcept {
        return add({.ownerId = _mv(ownerId), .perms = _mv(perms)});
    }

    auto build() const noexcept {
        auto lock = m_lock.writeLock();
        return m_perms;
    }

    auto size() const noexcept {
        auto lock = m_lock.readLock();
        return m_perms.size();
    }

protected:
    mutable async::SharedLock m_lock;
    PermissionSetList m_perms;
};

class PermissionInformation {
public:
    void add(const perms::UserRecord& userInfo) noexcept {
        add<perms::UserRecord>(m_lockUsers, userInfo, m_users);
    }
    void add(const perms::GroupRecord& groupInfo) noexcept {
        add<perms::GroupRecord>(m_lockGroups, groupInfo, m_groups);
    }

    // redirect to PermissionSetBuilder
    uint32_t add(PermissionSet&& perms) noexcept {
        return m_builder.add(_mv(perms));
    }
    auto add(Text ownerId, std::set<Permission>&& perms) noexcept {
        return m_builder.add(_mv(ownerId), _mv(perms));
    }
    auto build() const noexcept { return m_builder.build(); }
    auto size() const noexcept { return m_builder.size(); }

    auto getUsers() const noexcept {
        _using(auto lock = m_lockUsers.writeLock()) { return m_users; }
    }

    auto getGroups() const noexcept {
        _using(auto lock = m_lockGroups.writeLock()) { return m_groups; }
    }

private:
    template <class Record>
    void add(async::SharedLock& lockObject, const Record& what,
             std::unordered_map<Text, Record>& where) noexcept {
        // Check if the entry already exists (ignores index)
        _using(auto lock = lockObject.readLock()){
            if (auto it = where.find(what.id); it != where.end()) return;
}

// Add the entry
_using(auto lock = lockObject.writeLock()) {
    where[what.id] = what;
}
};  // namespace engine::perms

private:
PermissionSetBuilder m_builder;

//-------------------------------------------------------------
/// @details
///		Information about users.
//-------------------------------------------------------------
std::unordered_map<Text, perms::UserRecord> m_users;
mutable async::SharedLock m_lockUsers;

//-------------------------------------------------------------
/// @details
///		Information about groups.
//-------------------------------------------------------------
std::unordered_map<Text, perms::GroupRecord> m_groups;
mutable async::SharedLock m_lockGroups;
}
;

}  // namespace engine::perms
