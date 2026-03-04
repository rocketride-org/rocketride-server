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

namespace engine::index::db::internal {

template <typename Type>
class PaginatedVectorWordDBDataSupplier
    : public ap::memory::IPaginatedVectorDataSupplier<Type> {
public:
    using Parent = ap::memory::IPaginatedVectorDataSupplier<Type>;
    // Information about paginated data
    //  - pointer to data buffer
    //  - size of compressed data
    //  - size of uncompressed data
    using Page = std::tuple<const Type*, size_t, size_t>;
    using Pages = std::vector<Page>;

public:
    PaginatedVectorWordDBDataSupplier(const Pages& pages) : m_pages{pages} {
        calculateInternals();
    };
    PaginatedVectorWordDBDataSupplier(Pages&& pages) : m_pages{_mv(pages)} {
        calculateInternals();
    };
    PaginatedVectorWordDBDataSupplier(
        const PaginatedVectorWordDBDataSupplier&) = default;
    PaginatedVectorWordDBDataSupplier(PaginatedVectorWordDBDataSupplier&&) =
        default;
    PaginatedVectorWordDBDataSupplier& operator=(
        const PaginatedVectorWordDBDataSupplier&) = default;
    PaginatedVectorWordDBDataSupplier& operator=(
        PaginatedVectorWordDBDataSupplier&&) = default;

public:
    virtual bool empty() const noexcept override { return m_size == 0; }
    virtual size_t size() const noexcept override { return m_size; }

    /**
     * Load specific page from the data supplier into corresponding memory.
     * Does basic checking, e.g. returns `false` if `pageNumber` is out of
     * boundaries.
     * @param pageSize - page size (in elements)
     * @param pageNumber - number of the page to load
     * @param data - pointer where to load data into
     * @return boolean indicated if corresponding page was loaded successfully
     * or no Does nothing if specific page is already loaded.
     */
    virtual bool loadPage(size_t pageSize, size_t pageNumber,
                          Type* data) override {
        if (pageNumber < m_pages.size()) {
            Type* buffer = _constCast<Type*>(std::get<0>(m_pages[pageNumber]));
            size_t compressedSize = std::get<1>(m_pages[pageNumber]);
            size_t uncompressedSize = std::get<2>(m_pages[pageNumber]);

            // create DataView into current chunk, it can be compressed or
            // uncompressed
            memory::DataView<Type> compIds(buffer, compressedSize);

            // create DataView of needed size to uncompress or copy directly
            // into
            memory::DataView out{data, uncompressedSize};

            if (compressedSize ==
                uncompressedSize) {  // chunk is uncompressed => just copy
                std::copy(compIds.begin(), compIds.end(), out.data());
            } else {  // chunk is compressed => decompress directly into
                      // fullDocStruct
                if (auto ccode = compress::inflate<compress::Type::FASTPFOR>(
                        compIds, out))
                    dev::fatality(_location, "Failed to inflate ids", ccode);
            }
            return true;
        }
        return false;
    }

private:
    void calculateInternals() {
        m_size = std::accumulate(m_pages.begin(), m_pages.end(),
                                 static_cast<size_t>(0),
                                 [&](size_t result, Page& p) -> size_t {
                                     return result + std::get<2>(p);
                                 });
    }

private:
    // Contains information about pages
    Pages m_pages;
    // Contains total number of pages
    size_t m_size;
};

}  // namespace engine::index::db::internal
