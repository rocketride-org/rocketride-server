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

#include "test.h"

template <class Type>
using IPaginatedVectorDataSupplier =
    ap::memory::IPaginatedVectorDataSupplier<Type>;
template <class Type>
using PaginatedVector = ap::memory::PaginatedVector<Type>;

template <typename Type>
class PaginatedVectorDataSupplierFromVector
    : public IPaginatedVectorDataSupplier<Type> {
public:
    using parent = ap::memory::IPaginatedVectorDataSupplier<Type>;

public:
    // rule of file + destructor
    virtual ~PaginatedVectorDataSupplierFromVector() override {}
    PaginatedVectorDataSupplierFromVector(const std::vector<Type> &data)
        : m_data{data} {}
    PaginatedVectorDataSupplierFromVector(
        const PaginatedVectorDataSupplierFromVector<Type> &) = default;
    PaginatedVectorDataSupplierFromVector(
        PaginatedVectorDataSupplierFromVector<Type> &&) = default;
    PaginatedVectorDataSupplierFromVector &operator=(
        const PaginatedVectorDataSupplierFromVector &) = default;
    PaginatedVectorDataSupplierFromVector &operator=(
        PaginatedVectorDataSupplierFromVector &&) = default;

public:
    // interface implementation
    /**
     * Check if underlying container is empty
     * @return 'True' if there is data, `False` otherwise
     */
    virtual bool empty() const noexcept override { return m_data.empty(); }

    /**
     * Get data size
     */
    size_t size() const noexcept override { return m_data.size(); }

    /**
     * Load corresponding page into supplied memory
     * @param pageSize size of the page
     * @param pageNumber number of the page to load
     * @param data memory to load page into
     * @return true if load was successful, false otherwise
     */
    virtual bool loadPage(size_t pageSize, size_t pageNumber,
                          typename parent::value_type *data) override {
        if (pageSize == 0) return false;

        size_t maxIndex = (pageSize * (pageNumber + 1) > m_data.size()
                               ? m_data.size()
                               : pageSize * (pageNumber + 1));
        for (size_t index = pageSize * pageNumber; index != maxIndex; ++index)
            *data++ = m_data[index];

        return true;
    }

private:
    std::vector<Type> m_data;
};

TEST_CASE("PaginatedVector") {
    auto testData =
        GENERATE(std::make_tuple(10240, 1024, 10, 19, 10),
                 std::make_tuple(102400, 10240, 10, 19, 10),
                 std::make_tuple(102400, 1024, 100, 199, 10),
                 std::make_tuple(102400, 10000, 11, 21, 10),
                 std::make_tuple(102400, 1024, 100, 199, 10),
                 std::make_tuple(1024000, 1000, 1024, 2047, 100)
                 // , std::make_tuple(10240000, 10000, 1024, 2047, 1000)
        );

    SECTION("PaginatedVector<int>") {
        const size_t KVectorSize = std::get<0>(testData);
        const size_t KPageSize = std::get<1>(testData);
        const size_t KPageLoad1 = std::get<2>(testData);
        const size_t KPageLoad2 = std::get<3>(testData);
        const size_t KStep = std::get<4>(testData);

        LOG(Test,
            "Start for paginated vector with size of {} and page with size of "
            "{}",
            KVectorSize, KPageSize);

        using Vector = PaginatedVector<int>;

        std::vector<int> d(KVectorSize);
        std::iota(d.begin(), d.end(), 0);
        auto pvds =
            std::make_shared<PaginatedVectorDataSupplierFromVector<int>>(d);

        Vector v{KPageSize, pvds};

        // general checks
        REQUIRE(v.empty() == false);
        REQUIRE(v.size() == KVectorSize);
        REQUIRE(v.pageSize() == KPageSize);

        // forward check using operator[]
        for (size_t index = 0; index != v.size(); ++index)
            REQUIRE(v[index] == index);
        // it should be KPageLoad1
        REQUIRE(v.getPageLoadCount() == KPageLoad1);

        // reverse check using operator[]
        for (size_t index = v.size() - 1; true; --index) {
            REQUIRE(v[index] == index);
            if (index == 0) break;
        }
        // it should be KPageLoad2 here
        REQUIRE(v.getPageLoadCount() == KPageLoad2);

        // forward iterator check
        {
            size_t index = 0;
            for (Vector::iterator it = v.begin(); it != v.end(); ++it, ++index)
                REQUIRE(*it == index);
            --index;
            for (Vector::iterator it = v.end() - 1;; --it, --index) {
                REQUIRE(*it == index);
                if (it == v.begin()) break;
            }
            index = 0;
            for (Vector::iterator it = v.begin(); it < v.end();
                 it += KStep, index += KStep)
                REQUIRE(*it == index);
        }
        // reverse iterator check
        {
            size_t index = KVectorSize - 1;
            for (Vector::reverse_iterator it = v.rbegin(); it != v.rend();
                 ++it, --index) {
                REQUIRE(*it == index);
                REQUIRE(*(it.base() - 1) == index);
            }
            index = 0;
            for (Vector::reverse_iterator it = v.rend() - 1;; --it, ++index) {
                REQUIRE(*it == index);
                if (it == v.rbegin()) break;
            }
        }

        LOG(Test,
            "Finished for paginated vector with size of {} and page with size "
            "of {}",
            KVectorSize, KPageSize);
    }

    SECTION("std::vector<int>") {
        const size_t KVectorSize = std::get<0>(testData);

        LOG(Test, "Start for standard vector with size of {}", KVectorSize);

        // type
        using Vector = std::vector<int>;

        Vector v;
        v.resize(KVectorSize);
        std::iota(v.begin(), v.end(), 0);

        // general checks
        REQUIRE(v.empty() == false);
        REQUIRE(v.size() == KVectorSize);

        // forward check using operator[]
        for (size_t index = 0; index != v.size(); ++index)
            REQUIRE(v[index] == index);

        // reverse check using operator[]
        for (size_t index = v.size() - 1; true; --index) {
            REQUIRE(v[index] == index);
            if (index == 0) break;
        }

        // forward iterator check
        {
            size_t index = 0;
            for (Vector::iterator it = v.begin(); it != v.end(); ++it, ++index)
                REQUIRE(*it == index);
            --index;
            for (Vector::iterator it = v.end() - 1;; --it, --index) {
                REQUIRE(*it == index);
                if (it == v.begin()) break;
            }
            index = 0;
            for (Vector::iterator it = v.begin(); it < v.end();
                 it += 10, index += 10)
                REQUIRE(*it == index);
        }
        // reverse iterator check
        {
            size_t index = KVectorSize - 1;
            for (Vector::reverse_iterator it = v.rbegin(); it != v.rend();
                 ++it, --index) {
                REQUIRE(*it == index);
                REQUIRE(*(it.base() - 1) == index);
            }
            index = 0;
            for (Vector::reverse_iterator it = v.rend() - 1;; --it, ++index) {
                REQUIRE(*it == index);
                if (it == v.rbegin()) break;
            }
        }

        LOG(Test, "Finished for paginated vector with size of {}", KVectorSize);
    }

    SECTION("PaginatedVector<std::string>") {
        const size_t KVectorSize = std::get<0>(testData);
        const size_t KPageSize = std::get<1>(testData);
        const size_t KPageLoad1 = std::get<2>(testData);
        const size_t KPageLoad2 = std::get<3>(testData);
        const size_t KStep = std::get<4>(testData);

        LOG(Test,
            "Start for paginated vector with size of {} and page with size of "
            "{}",
            KVectorSize, KPageSize);

        // type
        using Vector = PaginatedVector<std::string>;

        std::vector<std::string> d(KVectorSize);
        for (size_t index = 0; index != KVectorSize; ++index)
            d[index] = std::to_string(index);
        auto pvds = std::make_shared<
            PaginatedVectorDataSupplierFromVector<std::string>>(d);

        Vector v{KPageSize, pvds};

        // general checks
        REQUIRE(v.empty() == false);
        REQUIRE(v.size() == KVectorSize);
        REQUIRE(v.pageSize() == KPageSize);

        // forward check using operator[]
        for (size_t index = 0; index != v.size(); ++index)
            REQUIRE(v[index] == std::to_string(index));
        // it should be KPageLoad1
        REQUIRE(v.getPageLoadCount() == KPageLoad1);

        // reverse check using operator[]
        for (size_t index = v.size() - 1; true; --index) {
            REQUIRE(v[index] == std::to_string(index));
            if (index == 0) break;
        }
        // it should be KPageLoad2 here
        REQUIRE(v.getPageLoadCount() == KPageLoad2);

        // forward iterator check
        {
            size_t index = 0;
            for (Vector::iterator it = v.begin(); it != v.end(); ++it, ++index)
                REQUIRE(*it == std::to_string(index));
            --index;
            for (Vector::iterator it = v.end() - 1;; --it, --index) {
                REQUIRE(*it == std::to_string(index));
                if (it == v.begin()) break;
            }
            index = 0;
            for (Vector::iterator it = v.begin(); it < v.end();
                 it += KStep, index += KStep)
                REQUIRE(*it == std::to_string(index));
        }
        // reverse iterator check
        {
            size_t index = KVectorSize - 1;
            for (Vector::reverse_iterator it = v.rbegin(); it != v.rend();
                 ++it, --index) {
                REQUIRE(*it == std::to_string(index));
                REQUIRE(*(it.base() - 1) == std::to_string(index));
            }
            index = 0;
            for (Vector::reverse_iterator it = v.rend() - 1;; --it, ++index) {
                REQUIRE(*it == std::to_string(index));
                if (it == v.rbegin()) break;
            }
        }

        LOG(Test,
            "Finished for paginated vector with size of {} and page with size "
            "of {}",
            KVectorSize, KPageSize);
    }

    SECTION("std::vector<std::string>") {
        const size_t KVectorSize = std::get<0>(testData);
        const size_t KStep = std::get<4>(testData);

        LOG(Test, "Start for standard vector with size of {}", KVectorSize);

        // type
        using Vector = std::vector<std::string>;

        Vector v;
        v.resize(KVectorSize);
        for (size_t index = 0; index != KVectorSize; ++index)
            v[index] = std::to_string(index);

        // general checks
        REQUIRE(v.empty() == false);
        REQUIRE(v.size() == KVectorSize);

        // forward check using operator[]
        for (size_t index = 0; index != v.size(); ++index)
            REQUIRE(v[index] == std::to_string(index));

        // reverse check using operator[]
        for (size_t index = v.size() - 1; true; --index) {
            REQUIRE(v[index] == std::to_string(index));
            if (index == 0) break;
        }

        // forward iterator check
        {
            size_t index = 0;
            for (Vector::iterator it = v.begin(); it != v.end(); ++it, ++index)
                REQUIRE(*it == std::to_string(index));
            --index;
            for (Vector::iterator it = v.end() - 1;; --it, --index) {
                REQUIRE(*it == std::to_string(index));
                if (it == v.begin()) break;
            }
            index = 0;
            for (Vector::iterator it = v.begin(); it < v.end();
                 it += KStep, index += KStep)
                REQUIRE(*it == std::to_string(index));
        }
        // reverse iterator check
        {
            size_t index = KVectorSize - 1;
            for (Vector::reverse_iterator it = v.rbegin(); it != v.rend();
                 ++it, --index) {
                REQUIRE(*it == std::to_string(index));
                REQUIRE(*(it.base() - 1) == std::to_string(index));
            }
            index = 0;
            for (Vector::reverse_iterator it = v.rend() - 1;; --it, ++index) {
                REQUIRE(*it == std::to_string(index));
                if (it == v.rbegin()) break;
            }
        }

        LOG(Test, "Finished for standard vector with size of {}", KVectorSize);
    }
}
