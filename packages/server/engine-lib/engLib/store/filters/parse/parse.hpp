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
//	The parser filter is responsible for forking lanes by accepting tags via
//	the writeTag interface parsing the data and calling the writeText
//	interfaces
//
//	We consider this a "forking" filter since even though it intercepts
//	incoming data on the writeTag interface, it continues to pump data
//	through that interface and sends data through the writeText
//	interface as well.
//
//	Source Mode:
//		This filter has no effect in source mode
//
//	Target Mode:
//		In target mode, monitors for incoming primary data streams, gathers
//		up the incoming data until close method is called. If the data we
//		accumulate is over 5Mb in length, we will overflow to a temporary
//		disk file that is automatically removed when the stack is terminated.
//
//		Once we have all the data, we create a tika parsing instance and
//		accept incoming read requests of the data from tika, and use our
//		5mb buffer+overflow file to return the data requested. Unlike
//		previous versions, this version uses the tika stream interface rather
//		than the file interface so that the data can come from any source,
//		email, sharepoint, onedrive, etc. It is all spooled out into the
//		5mb+overflow stream.
//
//		As tika parses through the file, it raises event and callback within
//		this filter driver, which are then sent over to the writeText
//		interface. The writeText interface accepts blocks of UCS-2 unicode
//		buffers, that can then be boundary check by the worder filter, divided
//		up into words by the worder filter for adding into the wordDb by the
//		indexer. Prior to issuing the writeText, the buffer is NFC normalized
//		so all code points with accents, combining marks, etc are in the
//		correct, normalized order.
//
//		It would be reasonable to ask why this is separate from the word
//		filter. Why not just parse and split into words in this module. Well,
//		the classification filter, also accepts the same exact text produce
//		by tika so we can run our classification and indexing concurrently
//		in the same stack.
//
//-----------------------------------------------------------------------------
#pragma once

//-----------------------------------------------------------------------------
// Include our dependencies
//-----------------------------------------------------------------------------
#include "./tika/stream.hpp"
#include "./tika/tika.hpp"

namespace engine::store::filter::parse {
class ParserContext;
class IFilterGlobal;

//-------------------------------------------------------------------------
/// @details
///		Declare our factory info
//-------------------------------------------------------------------------
_const auto Type = "parse"_itv;

//-------------------------------------------------------------------------
///	@details
///		The trace flag for this filter
//-------------------------------------------------------------------------
_const auto Level = Lvl::ServiceParser;

//-------------------------------------------------------------------------
/// @details
///		Define the instance class for this filter
//-------------------------------------------------------------------------
class IFilterInstance : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;

    IFilterInstance(const FactoryArgs &args);
    ~IFilterInstance() { LOGT("Destroying parser instance"); }

    //-----------------------------------------------------------------
    ///	@details
    ///		Allow the context we create to access our private
    ///		functions
    //-----------------------------------------------------------------
    friend ParserContext;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterInstance, Parent>(Type);

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error beginFilterInstance() noexcept override;
    virtual Error open(Entry &object) noexcept override;
    virtual Error writeTag(const TAG *pTag) noexcept override;
    virtual Error closing() noexcept override;
    virtual Error endFilterInstance() noexcept override;

private:
    //-----------------------------------------------------------------
    // Privates
    //-----------------------------------------------------------------
    Error processObjectStreamBegin(TAG_OBJECT_STREAM_BEGIN *pTag) noexcept;
    Error processObjectStreamData(TAG_OBJECT_STREAM_DATA *pTag) noexcept;
    Error onDocumentBegin() noexcept;
    Error onMetadata(const Metadata &metadata) noexcept;
    Error onText(const Utf16View text) noexcept;
    Error onTable(const Utf16View text) noexcept;
    Error onImage(const AVI_ACTION action, Text &mimeType,
                  const std::vector<uint8_t> &binaryData) noexcept;
    Error onAudio(const AVI_ACTION action, Text &mimeType,
                  const std::vector<uint8_t> &binaryData) noexcept;
    Error onVideo(const AVI_ACTION action, Text &mimeType,
                  const std::vector<uint8_t> &binaryData) noexcept;
    Error onDocumentComplete() noexcept;
    Error tikaThreadProc() noexcept;
    Error pumpTikaCallbacks() noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		ICU normalizer for NFC
    //-----------------------------------------------------------------
    Opt<string::icu::Normalizer> m_normalizer;

    //-----------------------------------------------------------------
    /// @details
    ///		Our tika instance data
    //-----------------------------------------------------------------
    Tika::TikaInstance m_tika;

    //-----------------------------------------------------------------
    /// @details
    ///		Our buffer we fill with data in the instance thread and
    ///     tika extracts and process data in the tika thread
    //-----------------------------------------------------------------
    MemoryBuffer m_buffer;

    //-----------------------------------------------------------------
    /// @details
    ///		Dedicated thread for tika to process
    //-----------------------------------------------------------------
    async::Thread m_tikaThread;

    //-----------------------------------------------------------------
    /// @details
    ///		Signalers between tika and instance threads.
    /// 	The instance thread signals to the tika thread to process
    /// 	the current entry. The tika thread signals to the instance
    /// 	thread when the current entry is processed.
    //-----------------------------------------------------------------
    async::Event m_tikaBeginObjectEvent;
    async::Event m_tikaEndObjectEvent;

    class TableData {
    public:
        TableData(Utf16View text_) : text(text_) {}
        Utf16 text;
    };

    class TextData {
    public:
        TextData(Utf16View text_) : text(text_) {}
        Utf16 text;
    };

    // In parse-instance.cpp or a common header that defines callback data
    // types.
    class ImageData {
    public:
        AVI_ACTION action;  // The AVI_ACTION associated with this chunk, e.g.,
                            // BEGIN, WRITE, or END.
        Text mimeType;      // The MIME type for the image.
        std::vector<uint8_t> binaryData;  // Binary data for the current chunk

        ImageData(const AVI_ACTION a, Text &mt,
                  const std::vector<uint8_t> &data)
            : action(a), mimeType(mt), binaryData(data) {}
    };

    // In parse-instance.cpp or a common header that defines callback data
    // types.
    class AudioData {
    public:
        AVI_ACTION action;  // The AVI_ACTION associated with this chunk, e.g.,
                            // BEGIN, WRITE, or END.
        Text mimeType;      // The MIME type for the audio.
        std::vector<uint8_t> binaryData;  // Binary data for the current chunk

        AudioData(const AVI_ACTION a, Text &mt,
                  const std::vector<uint8_t> &data)
            : action(a), mimeType(mt), binaryData(data) {}
    };

    class VideoData {
    public:
        AVI_ACTION action;  // The AVI_ACTION associated with this chunk, e.g.,
                            // BEGIN, WRITE, or END.
        Text mimeType;      // The MIME type for the video.
        std::vector<uint8_t> binaryData;  // Binary data for the current chunk

        VideoData(const AVI_ACTION a, Text &mt,
                  const std::vector<uint8_t> &data)
            : action(a), mimeType(mt), binaryData(data) {}
    };

    //-----------------------------------------------------------------
    /// @details
    ///		The queue for tika callbacks called in tika thread
    /// 	to re-call in instance thread
    //-----------------------------------------------------------------
    typedef Variant<std::monostate,
                    TextData,   // to onText
                    TableData,  // to onTable
                    ImageData,  // to onImage
                    AudioData,  // to onAudio
                    VideoData,  // to onVideo
                    Metadata,   // to onMetadata
                    Error>      // to tika result code
        TikaCallback;
    std::queue<TikaCallback> m_tikaCallbackQueue;

    //-------------------------------------------------------------------------
    /// @details
    ///		Lock for accessing tika callback queue.
    //-------------------------------------------------------------------------
    async::MutexLock m_tikaCallbackLock;

    //-----------------------------------------------------------------
    /// @details
    ///		Can we parse this document? This is setup in the open and
    ///     indicates that, if we get tag data, we can go ahead and
    ///     parse it
    //-----------------------------------------------------------------
    bool m_canParse = false;

    //-----------------------------------------------------------------
    /// @details
    ///		Are we actually parsing this document? Has the tika pump
    ///     been assigned? This is lazily set up on the first call to
    ///     to writeTag. If we can parse it, once the writeTag is
    ///     received, will set this once we are set up
    //-----------------------------------------------------------------
    bool m_parsing = false;

    //-----------------------------------------------------------------
    /// @details
    ///		Is the current stream one of our parsable streams?
    //-----------------------------------------------------------------
    bool m_streamEnabled = true;

    //-----------------------------------------------------------------
    /// @details
    ///		Determine the max file size we are going to parse
    //-----------------------------------------------------------------
    uint64_t m_maxFileSize = 0;
};

//-------------------------------------------------------------------------
/// @details
///		Define the common class for this filter
//-------------------------------------------------------------------------
class IFilterGlobal : public IServiceFilterGlobal {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterGlobal;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    ~IFilterGlobal() { LOGT("Destroying parser global"); }

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterGlobal, Parent>(Type);

    //-----------------------------------------------------------------
    /// @details
    ///		Public API
    //-----------------------------------------------------------------
    virtual Error beginFilterGlobal() noexcept override;
    virtual Error endFilterGlobal() noexcept override;

private:
    //-----------------------------------------------------------------
    /// @details
    ///		Our tika global data - we use this to control the jvm
    //-----------------------------------------------------------------
    Tika::TikaGlobal m_tika;
};

//-------------------------------------------------------------------------
/// @details
///		Tika context handler to forward off calls to our instance
//-------------------------------------------------------------------------
class ParserContext : public Tika::TikaContext {
public:
    //-----------------------------------------------------------------
    // Constructor
    //-----------------------------------------------------------------
    ParserContext(IFilterInstance &filter) : m_instance(filter) {};

    //-----------------------------------------------------------------
    // Override these to send to our instances
    //-----------------------------------------------------------------
    virtual Error onDocumentBegin() noexcept override {
        return m_instance.onDocumentBegin();
    }
    virtual Error onMetadata(const Metadata &metadata) noexcept override {
        return m_instance.onMetadata(metadata);
    }
    virtual Error onText(const Utf16View text) noexcept override {
        return m_instance.onText(text);
    };
    virtual Error onTable(const Utf16View text) noexcept override {
        return m_instance.onTable(text);
    };
    virtual Error onImage(
        const AVI_ACTION action, Text &mimeType,
        const std::vector<uint8_t> &binaryData) noexcept override {
        return m_instance.onImage(action, mimeType, binaryData);
    };
    virtual Error onAudio(
        const AVI_ACTION action, Text &mimeType,
        const std::vector<uint8_t> &binaryData) noexcept override {
        return m_instance.onAudio(action, mimeType, binaryData);
    };
    virtual Error onVideo(
        const AVI_ACTION action, Text &mimeType,
        const std::vector<uint8_t> &binaryData) noexcept override {
        return m_instance.onVideo(action, mimeType, binaryData);
    };
    virtual Error onDocumentComplete() noexcept override {
        return m_instance.onDocumentComplete();
    }

private:
    //-----------------------------------------------------------------
    /// @details
    ///		Reference to our bound instance
    //-----------------------------------------------------------------
    IFilterInstance &m_instance;
};
}  // namespace engine::store::filter::parse
