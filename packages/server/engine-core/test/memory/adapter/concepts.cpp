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

class TestInputAdapter {
public:
    TestInputAdapter(const TestInputAdapter&, file::Path path,
                     size_t size) noexcept
        : m_path(_mv(path)), m_size(size) {}

    TestInputAdapter make(Opt<file::Path> path = {}) const noexcept {
        return {*this, path ? this->path() : _mvOpt(path), size()};
    }

    TestInputAdapter make(Opt<file::Path> path = {}) noexcept {
        return {*this, path ? this->path() : _mvOpt(path), size()};
    }

    size_t read(OutputData, Opt<size_t> min = {}) const noexcept(false) {
        return 0;
    }

    uint64_t offset() const noexcept { return 0; }

    void setOffset(uint64_t) const noexcept {}

    uint64_t size() const noexcept { return m_size; }

    template <typename Buffer>
    void __toString(Buffer& buff) const noexcept {
        buff << m_path;
    }

    file::Path path() const noexcept { return m_path; }

    decltype(auto) operator*() const noexcept { return *this; }

private:
    file::Path m_path;
    size_t m_size;
    mutable size_t m_offset = {};
};

TEST_CASE("memory::adapter::concepts") {
    using namespace memory::adapter;

    SECTION("Input") {
        static_assert(concepts::IsInputV<Input<file::FileStream>>);

        static_assert(
            traits::IsDetectedExact<uint64_t, concepts::DetectOffsetMethod,
                                    Input<Text>>{});
        static_assert(
            traits::IsDetectedExact<uint64_t, concepts::DetectSizeMethod,
                                    Input<Text>>{});
        static_assert(
            traits::IsDetectedExact<void, concepts::DetectSetOffsetMethod,
                                    Input<Text>>{});
        static_assert(
            traits::IsDetectedExact<size_t, concepts::DetectReadMethod,
                                    Input<Text>>{});

        static_assert(concepts::IsInputV<Input<Text>>);
        static_assert(concepts::IsInputV<Input<std::vector<char>>>);
        static_assert(concepts::IsInputV<Input<BufferView>>);
    }

    SECTION("Output") {
        static_assert(concepts::IsOutputV<Output<file::FileStream>>);

        static_assert(
            traits::IsDetectedExact<uint64_t, concepts::DetectOffsetMethod,
                                    Output<Text>>{});
        static_assert(
            traits::IsDetectedExact<uint64_t, concepts::DetectSizeMethod,
                                    Output<Text>>{});
        static_assert(
            traits::IsDetectedExact<void, concepts::DetectSetOffsetMethod,
                                    Output<Text>>{});
        static_assert(traits::IsDetectedExact<void, concepts::DetectWriteMethod,
                                              Output<Text>>{});

        static_assert(concepts::IsOutputV<Output<Text>>);
        static_assert(concepts::IsOutputV<Output<std::vector<char>>>);
        static_assert(concepts::IsOutputV<Output<BufferView>>);

        static_assert(traits::IsDetectedExact<TestInputAdapter,
                                              concepts::DetectMakeMethod,
                                              TestInputAdapter>{});
        static_assert(traits::IsDetectedExact<TestInputAdapter,
                                              concepts::DetectConstMakeMethod,
                                              TestInputAdapter>{});
    }
}
