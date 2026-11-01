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

#include "../store.h"

#if ROCKETRIDE_PLAT_UNX
#include <algorithm>
#include <functional>
#include <sys/stat.h>
#include <unistd.h>

namespace filesys_render_test {
using namespace engine::store;

// A real regular file; truncation deliberately does not acquire flock.
struct File {
    char path[64] = "/tmp/rocketride-render-XXXXXX";
    int fd = ::mkstemp(path);
    explicit File(size_t size, bool sparse = false) {
        REQUIRE(fd >= 0);
        if (sparse) {
            REQUIRE(::ftruncate(fd, size) == 0);
        } else {
            std::vector<char> bytes(size, 'x');
            REQUIRE(::write(fd, bytes.data(), bytes.size()) ==
                    static_cast<ssize_t>(bytes.size()));
        }
    }
    ~File() {
        if (fd >= 0) ::close(fd);
        ::unlink(path);
    }
    File(const File &) = delete;
    File &operator=(const File &) = delete;
    Entry entry() const { return Entry(Url{Text("filesys://test") + path}); }
};

// Intercept the real renderer's downstream boundary without a pipeline binder
// saving return-only errors on the Entry. All stat/open/seek/read code is real.
struct Sink : IServiceFilterInstance {
    using IServiceFilterInstance::IServiceFilterInstance;
    std::function<Error(const TAG *)> onTag;
    std::vector<TAG_ID> tags;
    size_t bytes = 0;
    bool allZero = true;
    size_t emptyDataTags = 0;
    Error sendTag(ServicePipe &, const TAG *tag) noexcept override {
        tags.push_back(tag->tagId);
        if (tag->tagId == TAG_OBJECT_STREAM_DATA::ID) {
            bytes += tag->size;
            const auto *data = static_cast<const TAG_OBJECT_STREAM_DATA *>(tag);
            allZero &= std::all_of(data->data.data, data->data.data + tag->size,
                                   [](Byte value) { return value == 0; });
            if (!tag->size) {
                ++emptyDataTags;
                // Bound a broken zero-progress loop so the regression fails
                // instead of hanging the test process.
                return APERR(Ec::Failed, "Unexpected empty data tag");
            }
        }
        return onTag ? onTag(tag) : Error{};
    }
    size_t count(TAG_ID id) const {
        return std::count(tags.begin(), tags.end(), id);
    }
};

inline Error render(Entry &entry,
                    const std::function<void(Sink &)> &configure,
                    const std::function<void(const Sink &)> &verify) {
    auto job = R"({"taskId":"filesys-render-regression","config":{}})"_json;
    auto service = R"({"type":"filesys","key":"filesys://*",
        "name":"Local files","mode":"source","parameters":{}})"_json;
    auto config = job["config"];
    auto endpointOr = IServiceEndpoint::getSourceEndpoint(
        {.jobConfig = job, .taskConfig = config, .serviceConfig = service,
         .openMode = OPEN_MODE::SOURCE});
    REQUIRE_NO_ERROR(endpointOr);
    auto endpoint = *endpointOr;
    auto endpointGuard = util::Guard([&] { endpoint->endEndpoint(); });
    auto pipeOr = endpoint->getPipe();
    REQUIRE_NO_ERROR(pipeOr);
    auto pipe = *pipeOr;
    auto pipeGuard = util::Guard([&] { endpoint->putPipe(pipe); });
    using Renderer = filter::filesys::base::IBaseSysInstance<Lvl::ServiceFilesys>;
    Renderer *renderer = nullptr;
    for (auto *current = static_cast<IServiceFilterInstance *>(pipe.get());
         current && !renderer; current = current->pDown.get())
        renderer = dynamic_cast<Renderer *>(current);
    REQUIRE(renderer != nullptr);
    auto sink = makeShared<Sink>(IServiceFilterInstance::FactoryArgs{
        renderer->pipeType, renderer->endpoint, renderer->global, renderer->pipe});
    configure(*sink);
    auto downstream = renderer->pDown;
    auto restoreGuard = util::Guard([&] { renderer->pDown = downstream; });
    renderer->pDown = sink;
    ServicePipe target;  // Sink consumes the tags directly.
    auto result = renderer->renderObject(target, entry);
    verify(*sink);
    return result;
}
}  // namespace filesys_render_test
#endif
