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

namespace ap {

template <size_t BaseIndex = 0, char ContentChar = 'A'>
struct FastDataFactory {
    static Path generateFile(Size maxSize, const Path &_path) noexcept {
        // Hack in long path prefix so this works on any path length
#if ROCKETRIDE_PLAT_WIN
        Path path =
            (Path::LongPathPrefix + _ts(_path).replace("/", "\\")).c_str();
#else
        Path path = _path;
#endif

        std::error_code code;
        file::create_directories(path.parent_path(), code);

        auto randomSize = crypto::randomNumber<size_t>(0, maxSize);
        if (auto ccode = file::putContents(
                path, string::repeat(_ts(ContentChar), randomSize)))
            ASSERTD_MSG(!ccode, "Failed to generate random file", path, ccode);
        return path;
    }

    static auto generate(Count count, Size maxSize, size_t maxDepth,
                         const Path &path) noexcept(false) {
        std::vector<async::work::Item> tasks;
        for (auto i = 0; i < count; i++) {
            tasks.emplace_back(_mv(*async::work::submit(
                _location, "Generator",
                [i, maxSize, maxDepth,
                 path = path]() mutable noexcept -> std::vector<Path> {
                    auto nextIndex = BaseIndex;
                    std::vector<Path> result;

                    if (maxDepth) {
                        auto randomDepth =
                            crypto::randomNumber<size_t>(1, maxDepth);

                        for (auto ri = 0; ri < randomDepth; ri++) {
                            result.emplace_back(generateFile(
                                maxSize,
                                path / _fmt("file-{,~X}-{,~X}.txt",
                                            i + nextIndex, ri + nextIndex)));
                            path /=
                                WordsFactory::randomWord<std::string_view>();
                        }

                        result.emplace_back(generateFile(
                            maxSize,
                            path / _fmt("file-{,~X}.txt", i + nextIndex)));
                    } else {
                        result.emplace_back(generateFile(
                            maxSize,
                            path / _fmt("file-{,~X}.txt", i + nextIndex)));
                    }

                    LOG(Test, "Generated {}", _tsd<'\n'>(result));
                    return result;
                })));
        }

        // Collapse the results
        std::set<Path> result;
        for (auto &task : tasks) {
            for (auto &&file : *task->result<std::vector<Path>>())
                result.insert(_mv(file));
        }

        return result;
    }
};

}  // namespace ap
