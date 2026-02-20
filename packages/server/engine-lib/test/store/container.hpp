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

//-----------------------------------------------------------------------------
//
//	The container filter driver is installed within the store
//	stack and keeps track of all the data flowing through it. This
//	allows us to perform an operation and then check what happened
//
//-----------------------------------------------------------------------------
#pragma once

namespace engine::test {
//------------------------------------------------------------------------
/// @details
///		Define the flags for objects - these flags are also
///		passed directly into the java tika engine. See
///		TikaApi.java if these are changed!
///
///		These are declared here since they are shared amongst
///		the Selection class, then Entry class and tika
//-------------------------------------------------------------------------
class FILTER_TEST_FLAGS {
public:
    _const uint32_t NONE = 0;
    _const uint32_t SKIP_METADATA = BIT(0);
    _const uint32_t SKIP_BEGINSTREAM = BIT(1);
};

//-------------------------------------------------------------------------
/// @details
///		Define a simple container that will create an endpoint and manage
///		the test process
//-------------------------------------------------------------------------
class IFilterTest {
public:
    static const uint32_t DefaultFlags =
        Entry::FLAGS::SIGNING | Entry::FLAGS::INDEX | Entry::FLAGS::CLASSIFY;
    static const uint32_t DefaultFilterFlags = FILTER_TEST_FLAGS::NONE;

    //-----------------------------------------------------------------
    //  Constructors/destructor
    //-----------------------------------------------------------------
    virtual ~IFilterTest() noexcept {
        // Release the tag buffer if we allocated it
        if (m_pTagBuffer) Memory::release(&m_pTagBuffer);

        disconnect();
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Create a test filter with the specified layers
    ///	@param[in]	filters
    ///		Filters to instantiate
    //-----------------------------------------------------------------
    IFilterTest(
        TextVector filters,
        json::Value testConfig = json::Value(json::ValueType::nullValue),
        uint32_t filterFlags = DefaultFilterFlags)
        : m_config(testConfig),
          m_filters(filters),
          m_filterFlags(filterFlags) {}

    //-----------------------------------------------------------------
    // Public API - low-level API
    //-----------------------------------------------------------------
    Error connect(OPEN_MODE openMode = OPEN_MODE::TARGET) noexcept;
    ErrorOr<ServicePipe> getPipe() noexcept;
    ErrorOr<ServicePipe> openObjectSimple(
        TextView name, uint32_t flags = DefaultFlags) noexcept;
    ErrorOr<ServicePipe> openObject(TextView name,
                                    uint32_t flags = DefaultFlags) noexcept;
    Entry getDummyEntry(TextView name);
    Error writeTagBeginObject(ServicePipe pipe, Entry &entry) noexcept;
    Error writeTagBeginStream(
        ServicePipe pipe,
        TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE streamType =
            TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_DATA,
        Dword streamAttributes = TAG_ATTRIBUTES::INSTANCE_DATA,
        Dword streamSize = 0, Qword streamOffset = 0,
        Text streamName = {}) noexcept;
    Error writeTagData(ServicePipe pipe, size_t size,
                       const void *pData) noexcept;
    Error writeTagEndStream(ServicePipe pipe) noexcept;
    Error writeTagEndObject(ServicePipe pipe) noexcept;
    Error closeObjectSimple(ServicePipe pipe) noexcept;
    Error closeObject(ServicePipe pipe) noexcept;
    Error putPipe(ServicePipe pipe) noexcept;
    Error disconnect() noexcept;

    const Entry &getEntry() const noexcept { return m_entry; }

    //-----------------------------------------------------------------
    // Public API - high-level API - sends text through writeTag
    //-----------------------------------------------------------------
    Error writeTagData(TextView file, size_t size, const void *pData,
                       uint32_t flags = DefaultFlags) noexcept;
    Error writeTagData(TextView file, TextView text,
                       uint32_t flags = DefaultFlags) noexcept;
    Error writeTagData(TextView file, std::initializer_list<TextView> text,
                       uint32_t flags = DefaultFlags) noexcept;
    Error writeTagData(TextView file, Utf16View text,
                       uint32_t flags = DefaultFlags) noexcept;
    Error writeTagData(TextView file, const char8_t *pText,
                       uint32_t flags) noexcept;
    Error writeTagData(TextView file, OutputData data,
                       uint32_t flags = DefaultFlags) noexcept;
    Error sendFile(TextView file, uint32_t flags = DefaultFlags) noexcept;

    //-----------------------------------------------------------------
    // Public API - high-level API - sends text through writeText
    //-----------------------------------------------------------------
    Error sendText(TextView file, Utf16View text,
                   uint32_t flags = DefaultFlags) noexcept;

private:
    //-----------------------------------------------------------------
    // Utility functions
    //-----------------------------------------------------------------
    virtual Error getTagBuffer(TAG **ppTag) noexcept;

private:
    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    ServiceEndpoint m_endpoint;

    //-----------------------------------------------------------------
    /// @details
    ///		Buffer we use to write data. Created by connect
    //-----------------------------------------------------------------
    Byte *m_pBuffer = nullptr;

    //-----------------------------------------------------------------
    /// @details
    ///		The entry we current are using
    //-----------------------------------------------------------------
    Entry m_entry;

    //-----------------------------------------------------------------
    /// @details
    ///		Filters passed in the contructor
    //-----------------------------------------------------------------
    TextVector m_filters;

    //-----------------------------------------------------------------
    /// @details
    ///		Configuration passed in the constructor
    //-----------------------------------------------------------------
    json::Value m_config;

    //-----------------------------------------------------------------
    /// @details
    ///		Buffer to construct processing result
    //-----------------------------------------------------------------
    std::vector<Byte> m_Buffer;

    //-----------------------------------------------------------------
    /// @details
    ///		Built in tag buffer allocated only when needed via the
    ///		allocateTagBuffer member
    //-----------------------------------------------------------------
    TAG *m_pTagBuffer = nullptr;

    //-----------------------------------------------------------------
    /// @details
    ///		Flags that influence what filters are active
    //-----------------------------------------------------------------
    uint32_t m_filterFlags = {};
};
}  // namespace engine::test
