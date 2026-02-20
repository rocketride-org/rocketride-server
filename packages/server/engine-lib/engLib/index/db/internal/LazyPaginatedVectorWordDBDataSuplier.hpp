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

namespace engine::index::db::internal {

template <typename Type>
class LazyWordDBPaginatedVectorDataSupplier
    : public ap::memory::IPaginatedVectorDataSupplier<Type> {
public:
    using Parent = ap::memory::IPaginatedVectorDataSupplier<Type>;
    // Information about paginated data
    //  - offset to where the chunk data starts
    //  - size of compressed data
    //  - size of uncompressed data
    struct Page {
        size_t offset;
        size_t compressedSize;
        size_t uncompressedSize;
    };
    using Pages = std::vector<Page>;

public:
    LazyWordDBPaginatedVectorDataSupplier(Pages&& pages, StreamPtr stream,
                                          async::MutexLockSharedPtr mutex)
        : m_pages{_mv(pages)}, m_stream{_mv(stream)}, m_mutex{_mv(mutex)} {
        calculateInternals();
    };

    LazyWordDBPaginatedVectorDataSupplier(const Pages& pages, StreamPtr stream,
                                          async::MutexLockSharedPtr mutex)
        : m_pages{pages}, m_stream{_mv(stream)}, m_mutex{_mv(mutex)} {
        calculateInternals();
    };

    LazyWordDBPaginatedVectorDataSupplier(
        const LazyWordDBPaginatedVectorDataSupplier&) = default;
    LazyWordDBPaginatedVectorDataSupplier(
        LazyWordDBPaginatedVectorDataSupplier&&) = default;
    LazyWordDBPaginatedVectorDataSupplier& operator=(
        const LazyWordDBPaginatedVectorDataSupplier&) = default;
    LazyWordDBPaginatedVectorDataSupplier& operator=(
        LazyWordDBPaginatedVectorDataSupplier&&) = default;

public:
    virtual bool empty() const noexcept override { return m_size == 0; }
    virtual size_t size() const noexcept override { return m_size; }

    /**
     * Load specific page from the data supplier into corresponding memory.
     * Does basic checking, e.g. returns `false` if `pageNumber` is out of
     * boundaries.
     * @param pageSize - page size (in elements). Not used here, but is kept for
     * compatibility with other implementations.
     * @param pageNumber - number of the page to load
     * @param data - pointer where to load data into
     * @return boolean indicated if corresponding page was loaded successfully
     * or no Does nothing if specific page is already loaded.
     */
    virtual bool loadPage(size_t pageSize, size_t pageNumber,
                          Type* data) override {
        if (pageNumber < m_pages.size()) {
            auto& [offset, compressedSize, uncompressedSize] =
                m_pages[pageNumber];

            // Looks like capturing stucture bindings is ill-formed, so we
            // can work around it by using a ref initializer
            // https://burnicki.pl/en/2021/04/19/capture-structured-bindings.html
            auto readFromStream = [&stream = m_stream, &offset = offset,
                                   &mutex = m_mutex](Type* buffer,
                                                     size_t size) {
                // create data view to fill the buffer either with compressed or
                // uncompressed ids
                auto outView =
                    OutputData{_reCast<uint8_t*>(buffer), size * sizeof(Type)};

                auto guard = mutex->lock();

                if (auto res = stream->tryReadAtOffset(offset, outView);
                    res.check())
                    dev::fatality(_location,
                                  "Failed to read from remote word database",
                                  res.ccode());
            };

            if (compressedSize ==
                uncompressedSize) {  // chunk is uncompressed read directly into
                                     // data view
                readFromStream(data, uncompressedSize);
            } else {  // chunk is compressed, read it and then decompress
                      // directly into data view
                readFromStream(m_buffer.data(), compressedSize);

                // create DataView into current compressed chunk
                memory::DataView<Type> compIds(m_buffer, compressedSize);

                // create DataView to uncompress directly into output data
                memory::DataView out{data, uncompressedSize};

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
        size_t maxCompressedSize = 0;
        // Use accumulate predicate to also calculate the max
        // compressed size from all the pages
        m_size = std::accumulate(
            m_pages.begin(), m_pages.end(), static_cast<size_t>(0),
            [&](size_t result, const Page& p) -> size_t {
                maxCompressedSize =
                    std::max(maxCompressedSize, p.compressedSize);
                return result + p.uncompressedSize;
            });
        m_buffer.resize(maxCompressedSize);
    }

private:
    // Contains information about pages
    Pages m_pages;
    // Contains total number of elements
    size_t m_size;
    // Reference to the WordDB where elements are loaded from
    StreamPtr m_stream;
    // Mutex to guard the stream reads
    async::MutexLockSharedPtr m_mutex;
    // Reusable buffer to store compressed chunks
    std::vector<Type> m_buffer;
};

}  // namespace engine::index::db::internal
