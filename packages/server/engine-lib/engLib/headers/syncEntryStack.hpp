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

namespace engine {
//-------------------------------------------------------------------------
/// @details
///		Handle the stack of the entries from Scan Output of Sync Service
//-------------------------------------------------------------------------
class SyncEntryStack {
public:
    SyncEntryStack() {}

    //-----------------------------------------------------------------
    ///	@details
    ///		Push the entry to the stack with keeping consistency
    ///		of the entries by properties parentName/name.
    ///		The top stack entry is removed until it is the parent
    ///		of the adding entry or the root entry is added
    ///		to the empty stack. Otherwise return the error.
    //-----------------------------------------------------------------
    Error push(Entry &entry, bool setUniqueUrl = false,
               iTextView scanProtocol = ""_itv) noexcept {
        auto patchEntry = [&](Entry &object, const Url &parentUrl) -> Entry & {
            // patch the object if neeeded
            if (setUniqueUrl) {
                Url url = parentUrl / entry.uniqueName();
                object.uniqueUrl(url);
            }

            // return back the object
            return object;
        };

        if (entry.isObject() && entry.syncScanType)
            // The object must not specify the property syncScanType
            return APERRL(JobScan, Ec::InvalidFormat,
                          "Invalid object: syncScanType specified");

        if (entry.parentUniqueName) {
            // Pop the top entry until it is the parent of the adding one or the
            // items itself
            _forever() {
                if (m_entryPath.empty()) {
                    // The parent entry was not found on the stack
                    return APERRL(JobScan, Ec::InvalidFormat,
                                  "Invalid object stack: parent not found:",
                                  entry.parentUniqueName());
                } else if (entry.uniqueName() ==
                           m_entryPath.back().uniqueName()) {
                    // The item is already on the stack, so just check the
                    // parent
                    if (entry.parentUniqueName() !=
                        m_entryPath.back().parentUniqueName())
                        return APERRL(
                            JobScan, Ec::InvalidFormat,
                            "Invalid object stack: parent not matched:",
                            entry.parentUniqueName());

                    // And skip the item
                    break;
                } else if (entry.parentUniqueName() ==
                           m_entryPath.back().uniqueName()) {
                    // The parent of the item is on the stack
                    if (!m_entryPath.back().isContainer())
                        // The parent entry must be a container
                        return APERRL(
                            JobScan, Ec::InvalidFormat,
                            "Invalid object stack: parent not container:",
                            entry.parentUniqueName());

                    // Append the child entry to the parent entry
                    m_entryPath.push_back(
                        patchEntry(entry, m_entryPath.back().uniqueUrl()));
                    break;
                } else {
                    // Go to the next parent
                    m_entryPath.pop_back();
                }
            }
        } else {
            Url url;
            if (setUniqueUrl) {
                if (auto ccode = Url::toUrl(scanProtocol, "", url))
                    return ccode;
            }

            // Clear all the entries when adding the root
            m_entryPath.clear();

            // Insert the root entry to the empty stack
            m_entryPath.push_back(patchEntry(entry, url));
        }

        // Find the last sync container on the stack
        auto syncEntry =
            std::find_if(m_entryPath.rbegin(), m_entryPath.rend(),
                         [](const auto &e) { return e.syncScanType; });
        if (syncEntry != m_entryPath.rend())
            // Update the current sync type
            m_scanType = syncEntry->syncScanType();
        else if (entry.isContainer())
            // Reset the current sync type to the default value
            m_scanType = Entry::SyncScanType::FULL;
        else
            // The object must be the descendant of the sync container
            return APERRL(JobScan, Ec::InvalidFormat,
                          "Invalid object stack: syncScanType not specified");

        return {};
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get the path by the property name of stacked entries
    //-----------------------------------------------------------------
    file::Path path() const noexcept {
        file::Path res;
        for (const auto &e : m_entryPath) res /= e.name();
        return _mv(res);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get the path by the properties displayName or name
    ///		of stacked entries
    //-----------------------------------------------------------------
    file::Path uniquePath() const noexcept {
        file::Path res;
        for (const auto &e : m_entryPath) res /= e.uniqueName();
        return _mv(res);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get the sync type of the current stack
    //-----------------------------------------------------------------
    Entry::SyncScanType scanType() const noexcept { return m_scanType; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Write the containers on the stack, which are not written yet.
    //-----------------------------------------------------------------
    Error writeContainers(
        const std::function<Error(Entry &, const file::Path &)>
            &writeObject) noexcept {
        file::Path path;
        auto it = m_entryPath.begin(), e = m_entryPath.end();
        // Skip the containers, which are written
        for (; it != e && it->isWritten(); ++it) {
            ASSERT(it->isContainer());
            path /= it->name();
        }
        // Skip the rest of the containers, which are not written
        for (; it != e && it->isContainer() && !it->isWritten(); ++it) {
            path /= it->name();
            if (auto ccode = writeObject(*it, path)) return ccode;
            it->setWritten();
        }
        return {};
    }

private:
    // Disable copy and move
    SyncEntryStack(const SyncEntryStack &) = delete;
    SyncEntryStack &operator=(const SyncEntryStack &) = delete;
    SyncEntryStack(SyncEntryStack &&) = delete;
    SyncEntryStack &operator=(SyncEntryStack &&) = delete;

    //-----------------------------------------------------------------
    ///	@details
    ///		Just an Entry with additional written flag.
    //-----------------------------------------------------------------
    class SyncEntry : public Entry {
    public:
        using Parent = Entry;
        using Parent::Parent;

        SyncEntry(const Entry &e) : Parent(e) {}

        bool isWritten() const noexcept { return written; }
        void setWritten() noexcept {
            ASSERT(isContainer() && !written);
            written = true;
        }

    private:
        bool written = false;
    };

    //-----------------------------------------------------------------
    ///	@details
    ///		The list of the current entries
    //-----------------------------------------------------------------
    std::vector<SyncEntry> m_entryPath;

    //-----------------------------------------------------------------
    ///	@details
    ///		The scan type of the last sync container on the stack
    //-----------------------------------------------------------------
    Entry::SyncScanType m_scanType = Entry::SyncScanType::FULL;
};
}  // namespace engine
