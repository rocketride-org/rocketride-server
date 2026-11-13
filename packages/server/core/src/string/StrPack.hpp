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

namespace ap::string {

// A string pack is a data structure that copies view data into
// slab buffers, and efficiently packs them altogether
template <typename ChrT = TextChr, size_t SlabSizeT = 64 * Size::kKilobyte>
class StrPack {
public:
    // Declare our instantiated types
    using CharacterType = ChrT;
    using ViewType = StrView<CharacterType>;
    using StrType = Str<CharacterType>;
    _const auto SlabSize = SlabSizeT;

    // Declare default construction
    StrPack() = default;

    // Move ok, copy blocked
    StrPack(StrPack &&strs) = default;
    StrPack &operator=(StrPack &&str) = default;

    StrPack(const StrPack &strs) = delete;
    StrPack &operator=(const StrPack &str) = delete;

    // An entry packs a single string in the slab
    struct Entry {
        // Ptr to next entry
        Entry *next = nullptr;

        // Size of the data portion of this entry
        size_t size = NoPos;

        // Preserve byte alignment
        uint32_t reserved = {};

        // The data portion
        CharacterType data[1] = {};
    };

    static_assert(std::is_standard_layout_v<Entry>,
                  "Entry should be standard layout");

    // This headers overhead
    _const auto EntryOverhead = offsetof(Entry, data);

public:
    decltype(auto) operator==(const StrPack &pack) const noexcept {
        // Have to walk both, as the ptrs may have changed after a
        // toData/fromData translation
        auto lhs = first();
        auto rhs = pack.first();
        while (lhs || rhs) {
            if (lhs != rhs) return false;
            lhs = next(lhs);
            rhs = pack.next(rhs);
        }
        return true;
    }

    template <typename Out>
    auto __toData(Out &out) const noexcept(false) {
        // Write out the number of slabs we are dealing with
        *_tdb(out, memory::PackHdr{m_slabs.size()});

        // Write each slab out in order each Slab will self
        // marshal
        for (auto &slab : m_slabs) *_tdb(out, slab);

        LOG(Data, "{} Packed {} slabs", out, m_slabs.size());
    }

    // Returns the number of packed strings
    size_t size() const noexcept { return m_packCount; }

    // Adds a word, or adds a reference to an existing word
    ViewType add(ViewType str) noexcept {
        // Allocate an entry for it and fill it in
        auto entry = allocateEntry(str.size() + EntryOverhead);
        entry->size = str.size();

        std::memcpy(&entry->data[0], str.data(), str.size());

        // And give them a view pointing to its copy
        return {entry->data, entry->size};
    }

    // Returns the first view in the this pack
    ViewType first() const noexcept {
        if (m_packCount) {
            auto entry = m_slabs[0].template cast<Entry>();
            return toView(entry);
        }
        return {};
    }

    // Fetches the next view from the current view
    ViewType next(ViewType last) const noexcept {
        auto entry = fromView(last)->next;
        return toView(entry);
    }

    // Returns the total allocated memory used for string packs
    auto capacity() const noexcept { return m_slabs.size() * SlabSize; }

    // Clears the pack
    auto clear() noexcept {
        m_slabs.clear();
        m_currentSlab.reset();
        m_lastEntry = nullptr;
    }

private:
    // Convert a view to an entry by back tracing its ptr
    static Entry *fromView(ViewType view) noexcept {
        if (!view) return nullptr;

        auto data = _reCast<const unsigned char *>(view.data());
        data -= EntryOverhead;

        return _reCast<Entry *>(_constCast<unsigned char *>(data));
    }

    // Convert an entry ptr to a view
    static ViewType toView(const Entry *entry) noexcept {
        if (entry) return ViewType{entry->data, entry->size};
        return {};
    }

    // Allocates a new entry ptr to a free or allocated slab
    Entry *allocateEntry(size_t size) noexcept {
        // See if our current slab will do
        if (m_currentSlab && m_currentSlab->size() >= size) {
            // Initialize the new entry with its own default assignment
            auto nextEntry =
                m_currentSlab->consumeSlice(size).template cast<Entry>(size);
            *nextEntry = {};
            m_packCount++;

            // Link to the last entry if one was present
            if (m_lastEntry) m_lastEntry->next = nextEntry;

            // Last is now gone next is last
            return m_lastEntry = nextEntry;
        }

        // Create a new slab and put it in the slabs vector
        m_slabs.emplace_back(std::max(size, SlabSize));

        // Set this one as current and recurse
        m_currentSlab = m_slabs.back();
        return allocateEntry(size);
    }

    // Declare our slab vector, where slab ptrs live
    std::vector<Buffer> m_slabs;

    // Define our current slab, we add this to the slabs array and
    // consume it until its full before moving to another
    Opt<BufferView> m_currentSlab;

    // Keep the last entry around while we add to it, when the next
    // entry is added we'll link it to this before replacing it
    Entry *m_lastEntry = {};

    // Total number of stored strings
    size_t m_packCount = {};
};

}  // namespace ap::string
