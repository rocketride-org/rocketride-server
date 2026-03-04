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

namespace engine::store::filter::parse::Tika {
//-------------------------------------------------------------------------
/// @details
///		This class allows us to wrap a memory buffer and send it
///		back to tika like it was a file. This is used when a file can
///		be completely contained in memory (usually <5Mb)
//-------------------------------------------------------------------------
class TikaStream {
private:
    //-----------------------------------------------------------------
    // Define out methods we are going to use
    //-----------------------------------------------------------------
    struct TikaStreamMethods {
        TikaStreamMethods(const java::Jni &jni) noexcept(false) {
            m_class = jni.getClass("com/rocketride/tika_api/NativeInputStream");
            m_constructorMethodId = jni.getConstructorMethodId(m_class, "(J)V");
        }

        jobject createNativeInputStream(const java::Jni &jni,
                                        void *userData) noexcept(false) {
            return jni.createObject(m_class, m_constructorMethodId,
                                    _reCast<jlong>(userData));
        }

        jclass m_class;
        jmethodID m_constructorMethodId;
    };

    //-----------------------------------------------------------------
    // Construct the methods
    //-----------------------------------------------------------------
    static auto &methods(const java::Jni &jni) noexcept(false) {
        static TikaStreamMethods methods(jni);
        return methods;
    }

    //-----------------------------------------------------------------
    // Return the methods
    //-----------------------------------------------------------------
    auto &methods() const noexcept(false) { return methods(m_jni); }

public:
    //-----------------------------------------------------------------
    // Constructor
    //-----------------------------------------------------------------
    TikaStream(IBuffer &buffer, const java::Jni &jni) noexcept(false)
        : m_buffer(buffer), m_jni(jni) {
        m_tikaStream = methods().createNativeInputStream(m_jni, this);
    }

    //-----------------------------------------------------------------
    // Disable moves/copies
    //-----------------------------------------------------------------
    TikaStream(const TikaStream &) = delete;
    TikaStream(TikaStream &&) = delete;

    //-----------------------------------------------------------------
    /// @details
    ///     Returns the underlying javascript object created by this
    ///     stream. Used to pass over to java
    //-----------------------------------------------------------------
    jobject stream() noexcept { return m_tikaStream; }

    //-----------------------------------------------------------------
    /// @details
    ///     Read data into the buffer
    /// @param[in] offset
    ///     Offset to read from
    /// @param[out] data
    ///		Dataview which receives the data
    //-----------------------------------------------------------------
    ErrorOr<size_t> read(uint64_t offset, OutputData &data) {
        return m_buffer.readData(offset, data);
    }

private:
    //-----------------------------------------------------------------
    /// @details
    ///     The bound jni interface
    //-----------------------------------------------------------------
    java::Jni m_jni;

    //-----------------------------------------------------------------
    /// @details
    ///     The tika stream object we created
    //-----------------------------------------------------------------
    jobject m_tikaStream;

    //-----------------------------------------------------------------
    /// @details
    ///     The bound buffer
    //-----------------------------------------------------------------
    IBuffer &m_buffer;
};
}  // namespace engine::store::filter::parse::Tika
