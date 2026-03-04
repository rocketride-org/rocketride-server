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

#include <engLib/eng.h>

namespace engine::store::filter::parse {
IFilterInstance::IFilterInstance(const FactoryArgs &args)
    : Parent(args),
      m_tikaThread(_location,
                   _ts(async::ThreadApi::thisCtx()->name(), "/tika-parser"),
                   _bind(&IFilterInstance::tikaThreadProc, this)) {}

//-------------------------------------------------------------------------
/// @details
///		Begins the filter operation
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::beginFilterInstance() noexcept {
    LOGPIPE();

    // Call the parent
    if (auto ccode = Parent::beginFilterInstance()) return ccode;

    // Start tika thread
    if (auto ccode = m_tikaThread.start()) return ccode;

    // Get an ICU normalizer instance. Note the use of NFC here - for parsing,
    // we will use NFC, and for classification, the classificaton filter
    // will normalize this to NFKC mode
    auto normalizer =
        string::icu::getNormalizer(string::icu::NormalizationForm::NFC);
    if (!normalizer)
        return APERRT(normalizer.ccode(), "Unable to get normalizer instance");

    // Get our index section
    const json::Value &indexConfig =
        endpoint->config.taskConfig.lookup("index");

    // Get the max file size to process
    indexConfig.lookupAssign("maxFileSize", m_maxFileSize);

    // Save it
    m_normalizer.emplace(_mv(*normalizer));
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Ends the filter operation
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::endFilterInstance() noexcept {
    LOGPIPE();

    auto ccode = Parent::endFilterInstance();

    // Notify tika thread to complete
    ccode = ccode || m_tikaBeginObjectEvent.set();

    // And wait for tika thread completed
    ccode = ccode || m_tikaThread.join();

    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Sends the notification that we are begining a document
///	@param[in] path
///		Path the we are beginning
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::onDocumentBegin() noexcept { return {}; }

//-------------------------------------------------------------------------
/// @details
///		Sends the metadata to the stack
///	@param[in] metadata
///		The metadata value
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::onMetadata(const Metadata &metadata) noexcept {
    // Push to process in instance thread
    auto guard = m_tikaCallbackLock.acquire();
    m_tikaCallbackQueue.push(metadata);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Sends the parsed text to the top of the filter chain. We are
///		going to make some assumptions here about what tika is going
///		to send us:
///
///		1)	The buffer sent will NOT split a surrogate pair
///	@param[in] text
///		The text we parsed
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::onText(const Utf16View text) noexcept {
    if (!binder.hasListener("text")) {
        LOGT("Skipping text: no listeners on the text lane");
        return {};
    }
    // Push to process in instance thread
    auto guard = m_tikaCallbackLock.acquire();
    auto textData = TextData(text);
    m_tikaCallbackQueue.push(_mv(textData));
    return {};
};

//-------------------------------------------------------------------------
/// @details
///     Sends the parsed Video buffer to the top of the filter chain.
///
/// @param[in] AVI_ACTION
///     signals three events (BEGIN/WRITE/END) to stream video bytes to Python
/// @param[in] mimetype
///     signals the type of the video stream
/// @param[in] binaryData
///     content of the video stream as binary data
/// @returns
///     Error
//-------------------------------------------------------------------------
Error IFilterInstance::onVideo(
    const AVI_ACTION action, Text &mimeType,
    const std::vector<uint8_t> &binaryData) noexcept {
    if (!binder.hasListener("video")) {
        LOGT("Skipping video: no listeners on the video lane");
        return {};
    }
    auto guard = m_tikaCallbackLock.acquire();
    VideoData videoData(action, mimeType, binaryData);
    m_tikaCallbackQueue.push(_mv(videoData));
    return {};
}

//-------------------------------------------------------------------------
/// @details
///     Sends the parsed Audio buffer to the top of the filter chain.
///
/// @param[in] AVI_ACTION
///     signals three events (BEGIN/WRITE/END) to stream audio bytes to Python
/// @param[in] mimetype
///     signals the type of the audio stream
/// @param[in] binaryData
///     content of the audio stream as binary data
/// @returns
///     Error
//-------------------------------------------------------------------------
Error IFilterInstance::onAudio(
    const AVI_ACTION action, Text &mimeType,
    const std::vector<uint8_t> &binaryData) noexcept {
    if (!binder.hasListener("audio")) {
        LOGT("Skipping audio: no listeners on the audio lane");
        return {};
    }
    auto guard = m_tikaCallbackLock.acquire();
    AudioData audioData(action, mimeType, binaryData);
    m_tikaCallbackQueue.push(_mv(audioData));
    return {};
}

//-------------------------------------------------------------------------
/// @details
///     Sends the parsed Image buffer to the top of the filter chain.
///
/// @param[in] AVI_ACTION
///     signals three events (BEGIN/WRITE/END) to stream image bytes to Python
/// @param[in] mimetype
///     signals the type of the image stream
/// @param[in] binaryData
///     content of the image stream as binary data
/// @returns
///     Error
//-------------------------------------------------------------------------
Error IFilterInstance::onImage(
    const AVI_ACTION action, Text &mimeType,
    const std::vector<uint8_t> &binaryData) noexcept {
    if (!binder.hasListener("image")) {
        LOGT("Skipping image: no listeners on the image lane");
        return {};
    }
    auto guard = m_tikaCallbackLock.acquire();
    ImageData imageData(action, mimeType, binaryData);
    m_tikaCallbackQueue.push(_mv(imageData));
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Sends the parsed text to the top of the filter chain. We are
///		going to make some assumptions here about what tika is going
///		to send us:
///
///		1)	The buffer sent will NOT split a surrogate pair
///	@param[in] text
///		The text we parsed
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::onTable(const Utf16View text) noexcept {
    if (!binder.hasListener("table")) {
        LOGT("Skipping table: no listeners on the table lane");
        return {};
    }
    // Push to process in instance thread
    auto guard = m_tikaCallbackLock.acquire();
    auto tableData = TableData(text);
    m_tikaCallbackQueue.push(_mv(tableData));
    return {};
};

//-------------------------------------------------------------------------
/// @details
///		Notifies that we have completed the parsing of the document
///	@param[in] path
///		The metadata value
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::onDocumentComplete() noexcept {
    // Complete the buffer to stop collecting data on writeTag
    Error ccode = m_buffer.setComplete();
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Tika thread procedure. Starts tika, sends incoming enties to tika,
/// 	ends tika when pipe completed.
//-------------------------------------------------------------------------
Error IFilterInstance::tikaThreadProc() noexcept {
    // Start tika
    if (auto ccode = m_tika.begin(endpoint->config)) return ccode;

    for (;;) {
        LOGT("TIKA waiting for the object to process ...");
        if (auto ccode = m_tikaBeginObjectEvent.wait()) return ccode;

        // ATTENTION:
        //     Non-thread safe currentEntry is accessed in this tika thread:
        //     * access to the pointer itself is safe since it synchronized by
        //     the object events;
        //     * flags() refer int value which is assumed to be safe.
        if (currentEntry != nullptr) {
            util::Guard guard{[this] {
                if (auto ccode =
                        m_buffer.setComplete() || m_tikaEndObjectEvent.set())
                    LOG(Error, ccode);
            }};

            // Now, we can't get the full path, because there may not actually
            // be one, but pass it the terminal object/filename to give tika
            // a hint on how to parse it
            auto filename = m_buffer.name();

            LOGT("TIKA process object:", filename, "...");

            // Setup our ontext
            ParserContext context(*this);

            // Extract the text
            auto ccode = m_tika.extractTextFromBuffer(
                filename, m_buffer, currentEntry->flags(), context);

            // Push error code to callback queue always to process in instance
            // thread
            {
                auto guard = m_tikaCallbackLock.acquire();
                m_tikaCallbackQueue.push(ccode);
            }

            LOGT("TIKA process object:", filename, ": done");
        } else {
            LOGT("TIKA ended");
            break;
        }
    }

    // Stop tika
    if (auto ccode = m_tika.end()) return ccode;

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Re-calls in instance thread all the tika callbacks called in tika
/// 	thread. So, the text lane of the pipe is called in the same
/// 	instance thread and thus is synchronized with the pipe.
//-------------------------------------------------------------------------
Error IFilterInstance::pumpTikaCallbacks() noexcept {
    auto ccode = Error{};

    auto guard = m_tikaCallbackLock.acquire();

    while (!m_tikaCallbackQueue.empty()) {
        auto &callback = m_tikaCallbackQueue.front();

        ccode =
            ccode ||
            _visit(
                overloaded{
                    // onText
                    [&](const TextData &data) noexcept -> Error {
                        Utf16View text(data.text);

                        // Do a check to see if we even need to normalize it
                        // (most likely)
                        if (m_normalizer->isNormalized(text)) {
                            // Nope, send it is as
                            return binder.writeText(text);
                        } else {
                            // Attempt to normalize it
                            auto normalized = m_normalizer->normalize(text);

                            // If we couldn't just write it out as is
                            if (!normalized)
                                return binder.writeText(text);
                            else
                                return binder.writeText(*normalized);
                        }
                    },
                    [&](const TableData &data) noexcept -> Error {
                        Utf16View table(data.text);

                        // Do a check to see if we even need to normalize it
                        // (most likely)
                        if (m_normalizer->isNormalized(table)) {
                            // Nope, send it is as
                            return binder.writeTable(table);
                        } else {
                            // Attempt to normalize it
                            auto normalized = m_normalizer->normalize(table);

                            // If we couldn't just write it out as is
                            if (!normalized)
                                return binder.writeTable(table);
                            else
                                return binder.writeTable(*normalized);
                        }
                    },
                    [&](const ImageData &imageData) noexcept -> Error {
                        // Ensure the current thread is attached to the Python
                        // interpreter
                        engine::python::LockPython lock;

                        // Convert the vector of image data to a pybind11::bytes
                        // object
                        pybind11::bytes streamData("");
                        if (imageData.binaryData.size() > 0) {
                            streamData = pybind11::bytes(
                                _reCast<const char *>(
                                    imageData.binaryData.data()),
                                imageData.binaryData.size());
                        }

                        // Create a mutable copy of the MIME type
                        Text mimeType = imageData.mimeType;
                        return binder.writeImage(imageData.action, mimeType,
                                                 streamData);
                    },
                    [&](const AudioData &audioData) noexcept -> Error {
                        // Ensure the current thread is attached to the Python
                        // interpreter
                        engine::python::LockPython lock;

                        pybind11::bytes streamData("");
                        if (audioData.binaryData.size() > 0) {
                            streamData = pybind11::bytes(
                                _reCast<const char *>(
                                    audioData.binaryData.data()),
                                audioData.binaryData.size());
                        }

                        // Create a mutable copy of the MIME type
                        Text mimeType = audioData.mimeType;
                        return binder.writeAudio(audioData.action, mimeType,
                                                 streamData);
                    },
                    [&](const VideoData &videoData) noexcept -> Error {
                        // Ensure the current thread is attached to the Python
                        // interpreter
                        engine::python::LockPython lock;

                        pybind11::bytes streamData("");
                        if (videoData.binaryData.size() > 0) {
                            streamData = pybind11::bytes(
                                _reCast<const char *>(
                                    videoData.binaryData.data()),
                                videoData.binaryData.size());
                        }

                        // Create a mutable copy of the MIME type
                        Text mimeType = videoData.mimeType;
                        return binder.writeVideo(videoData.action, mimeType,
                                                 streamData);
                    },
                    // onMetadata
                    [&](const Metadata &metadata) noexcept -> Error {
                        // Pick up the creating user from the metadata
                        if (auto value = metadata.get("dc:creator"))
                            currentEntry->docCreator(value);

                        // Pick up the modifing user from the metadata
                        if (auto value = metadata.get("dc:modifier"))
                            currentEntry->docModifier(value);

                        // Pick up the creation date from the metadata
                        if (auto value = metadata.get("dcterms:created"))
                            currentEntry->docCreateTime(value);

                        // Pick up the modification date from the metadata
                        if (auto value = metadata.get("dcterms:modified"))
                            currentEntry->docModifyTime(value);

                        // Convert the metadata into a json object in the entry
                        auto jsonMetadata = _tj(metadata);

                        // Save the encyption setting
                        if (metadata.isEncrypted())
                            jsonMetadata["isEncrypted"] = true;

                        // Merge (not overwrite) the metadata into the entry
                        currentEntry->metadata(
                            currentEntry->metadata.get().merge(jsonMetadata));
                        return {};
                    },
                    [&](Error ccode) -> Error {
                        // If no error happened - process the OCR_DONE flag
                        if (currentEntry->flags() & Entry::FLAGS::OCR) {
                            // If OCR is enabled: update the flags - set
                            // OCR_DONE flag
                            currentEntry->flags(currentEntry->flags() |
                                                Entry::FLAGS::OCR_DONE);
                        } else {
                            // If OCR is disabled: update the flags - explicitly
                            // reset OCR_DONE flag
                            currentEntry->flags(currentEntry->flags() &
                                                ~Entry::FLAGS::OCR_DONE);
                        }

                        // Now, we pretty much ignore any parsing errors here.
                        // Just because we can't parse the file does not mean we
                        // should fail it, it just won't have any content
                        // indexing or classification info. It will have a
                        // signature since the hasher still worked, file
                        // metadata is still valid, but we will not be calling
                        // the writeText or writeWords interfaces
                        if (ccode)
                            return endpoint->taskWriteWarning(*currentEntry,
                                                              ccode);
                        return {};
                    },
                    [&](std::monostate) {
                        return APERR(Ec::NotSupported, "invalid Tika callback");
                    }},
                callback);

        m_tikaCallbackQueue.pop();
    }

    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Proesses a new object stream header
///	@param[in]	pTag
///		The stream begin tag
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::processObjectStreamBegin(
    TAG_OBJECT_STREAM_BEGIN *pTag) noexcept {
    // Determine if the is the primary data stream or not
    m_streamEnabled = isPrimaryDataStream(pTag);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Proesses the data within the stream
///	@param[in]	pTag
///		The stream data tag
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::processObjectStreamData(
    TAG_OBJECT_STREAM_DATA *pTag) noexcept {
    Error ccode;

    // This happens if we are not restoring a windows file and
    // it is a non-data or non-sparse data stream - see processObjectStreamBegin
    // to determine if a stream is enabled or not
    if (!m_streamEnabled) return {};

    // Make an output buffer view out of it
    auto data = InputData(pTag->data.data, pTag->size);

    // Write it to the tika buffer
    if (ccode = m_buffer.writeData(data)) return ccode;

    // Process text returned by tika
    if (ccode = pumpTikaCallbacks()) return ccode;

    // And done
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Processes the incoming tags
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::writeTag(const TAG *pTag) noexcept {
    Error ccode;

    LOGPIPE();

    // If we are supposed to parse this document
    if (m_canParse) {
        // We received a tag and we are able to parse this file, so
        // setup the parsing of it
        if (!m_parsing) {
            m_buffer.setup(currentEntry->url().fileName(),
                           currentEntry->size());

            // Notify tika thread to process the current object
            if (auto ccode = m_tikaBeginObjectEvent.set()) return ccode;

            // Say we are now ready to start parsing and we inited the parser
            m_parsing = true;
        }

        // Switch it to generic format so we can read the
        // data values from it
        TAGS *pTagData = (TAGS *)pTag;

        // Based on the tag type
        switch (pTag->tagId) {
            case TAG_OBJECT_STREAM_BEGIN::ID: {
                // Begin a new stream within the object
                if (ccode = processObjectStreamBegin(&pTagData->streamBegin))
                    return ccode;
                break;
            }

            case TAG_OBJECT_STREAM_DATA::ID: {
                // Write stream data
                if (ccode = processObjectStreamData(&pTagData->streamData))
                    return ccode;
                break;
            }

            default:
                // Ignore any unknown tags
                break;
        }
    }

    // Send this down, we are just montoring the flow
    return Parent::writeTag(pTag);
}

//-------------------------------------------------------------------------
/// @details
/// 	Opens an entry for processing.
///	@param[in]	object
///		The object information about the object being opened
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::open(Entry &object) noexcept {
    LOGPIPE();

    // Clear the buffer
    m_buffer.clear();

    // Something went wrong if tika callback queue is not empty
    if (!m_tikaCallbackQueue.empty())
        return APERR(Ec::Unexpected, "Empty Tika callbacks queue expected");

    // Default to not parsing this file
    m_canParse = false;
    m_parsing = false;

    // We were incuded in the chain, so do it - don't be too clever in trying to
    // figure out whether we are needed or not
    if (m_maxFileSize && object.size() > m_maxFileSize) {
        MONERR(warning, Ec::Excluded, "Skipping", object.fileName(),
               "due to file size", _ts(object.size()),
               "which exceeds processing configured limit", _ts(m_maxFileSize));
    } else if (object.objectFailed()) {
        MONERR(warning, Ec::Excluded, "Skipping", object.fileName(),
               "due to error", object.completionCode());
    } else if (!object.size()) {
        MONERR(warning, Ec::Excluded, "Skipping", object.fileName(),
               "because the file is empty");
    } else {
        // We can parse it - it is enabled, the size is ok and no error
        m_canParse = true;
    }

    // Call the parent
    if (auto ccode = Parent::open(object)) return ccode;

    return {};
}

//-------------------------------------------------------------------------
/// @details
/// 	Closing the target object. This actually drives the tika parsing
///		process. Up until now, we have just been buffering data streams
///		into the tika buffer
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::closing() noexcept {
    Error ccode;

    LOGPIPE();

    if (m_parsing) {
        // Set that object data is completed
        ccode = m_buffer.setComplete() || ccode;

        // Wait for tika to complete parsing
        ccode = m_tikaEndObjectEvent.wait();

        // Process final tika callbacks
        ccode = pumpTikaCallbacks() || ccode;
    }

    // Call the parent
    return Parent::closing() || ccode;
}
}  // namespace engine::store::filter::parse
