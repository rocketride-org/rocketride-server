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

namespace ap::memory {

template <typename Input>
class InputStreamBuf : public std::streambuf, public ChildOf<Input> {
public:
    using Parent = ChildOf<Input>;
    using Parent::parent;

public:
    InputStreamBuf(Input& in) noexcept : Parent(in) {}
    InputStreamBuf(const InputStreamBuf&) = default;
    InputStreamBuf(InputStreamBuf&&) = default;

protected:
    // Buffer management and positioning
    std::streampos seekoff(std::streamoff off, std::ios_base::seekdir way,
                           std::ios_base::openmode which) override {
        switch (way) {
            case std::ios_base::beg:
                return seekpos(off, which);

            case std::ios_base::cur:
                if (parent().offset() + off > parent().size()) return -1;

                parent().setOffset(parent().offset() + off);
                break;

            case std::ios_base::end:
                if (parent().offset() + off > parent().size()) return -1;

                parent().setOffset(parent().size() + off);
                break;
        }
        return _nc<std::streampos>(parent().offset());
    }

    std::streampos seekpos(std::streampos sp,
                           std::ios_base::openmode which) override {
        if (_cast<uint64_t>(sp) > parent().size()) return -1;

        parent().setOffset(_cast<uint64_t>(sp));
        return _nc<std::streampos>(parent().offset());
    }

    // Input functions
    std::streamsize showmanyc() override {
        return _nc<std::streamsize>(parent().size());
    }

    std::streamsize xsgetn(char* s, std::streamsize n) override {
        auto length =
            std::min<uint64_t>(n, parent().size() - parent().offset());
        return _nc<std::streamsize>(parent().read(
            OutputData{_reCast<uint8_t*>(s), _nc<size_t>(n)}, length));
    }

    int_type underflow() override {
        if (parent().offset() >= parent().size()) return traits_type::eof();

        uint8_t value;
        parent().read(OutputData{&value, 1});
        parent().setOffset(parent().offset() - 1);
        return traits_type::to_int_type(value);
    }

    int_type uflow() override {
        if (parent().offset() >= parent().size()) return traits_type::eof();

        uint8_t value;
        parent().read(OutputData{&value, 1});
        return traits_type::to_int_type(value);
    }

    int_type pbackfail(int_type ch) override {
        if (!parent().offset()) return traits_type::eof();

        parent().setOffset(parent().offset() - 1);
        uint8_t value;
        parent().read(OutputData{&value, 1});
        return traits_type::to_int_type(value);
    }
};

}  // namespace ap::memory