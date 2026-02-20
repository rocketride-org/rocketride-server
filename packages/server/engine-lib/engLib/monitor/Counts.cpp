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

#include <engLib/eng.h>

namespace engine::monitor {
//-------------------------------------------------------------------------
/// @details
///		Start the rate timer
//-------------------------------------------------------------------------
void Counts::startCounters() noexcept { m_rate.start(); }

//-------------------------------------------------------------------------
/// @details
///		Add on set of counts to this one
///	@param[in]	other
///		Other status to add to this one
//-------------------------------------------------------------------------
Counts& Counts::operator+=(const Counts& other) noexcept {
    if (this == &other) return *this;

    m_total += other.m_total;
    m_failed += other.m_failed;
    m_rate += other.m_rate;
    m_words += other.m_words;
    m_updateCounts = true;
    return *this;
}

//-------------------------------------------------------------------------
/// @details
///		Add to the completed count
///	@param[in]	counts
///		Count/size to add
//-------------------------------------------------------------------------
Counts& Counts::addCompleted(CountSize counts) noexcept {
    auto guard = lock();
    m_rate.report(counts.size, counts.count);
    m_total += counts;
    m_updateCounts = true;
    return *this;
}

//-------------------------------------------------------------------------
/// @details
///		Add to the failed count
///	@param[in]	counts
///		Count/size to add
//-------------------------------------------------------------------------
Counts& Counts::addFailed(CountSize counts) noexcept {
    auto guard = lock();
    m_failed += counts;
    m_total += counts;
    m_updateCounts = true;
    return *this;
}

//-------------------------------------------------------------------------
/// @details
///		Add to the word count
///	@param[in]	counts
///		Count/size to add
//-------------------------------------------------------------------------
Counts& Counts::addWords(CountSize counts) noexcept {
    auto guard = lock();
    m_words += counts;
    m_updateCounts = true;
    return *this;
}

//-------------------------------------------------------------------------
/// @details
///		Indicates the engine is starting an object
///	@param[in]	object
///		Object we are starting
//-------------------------------------------------------------------------
void Counts::beginObject(TextView path, uint64_t size) noexcept {
    auto guard = lock();
    CountObject obj{path, size};

    // Put it in the list
    m_objects.emplace_back(obj);

    // Needs an update
    m_updateObject = true;
}

//-------------------------------------------------------------------------
/// @details
///		Indicates the engine is starting an object
///	@param[in]	object
///		Object we are starting
//-------------------------------------------------------------------------
void Counts::beginObject(Entry& object) noexcept {
    beginObject(static_cast<TextView>(object.url()), object.size());
}

//-------------------------------------------------------------------------
/// @details
///		Indicates the engine is done with an object
///	@param[in]	object
///		Object we are stopping
//-------------------------------------------------------------------------
void Counts::endObject(TextView path) noexcept {
    auto guard = lock();

    // Walk through our list and find it
    for (auto it = m_objects.begin(); it != m_objects.end(); it++) {
        // If ths is not it, skip it
        if (it->path != path) continue;

        // Remove the object
        m_objects.erase(it);

        // Needs an update
        m_updateObject = true;
        return;
    }

    ASSERT_MSG(false, "End object path not found, possible memory leak");
}

//-------------------------------------------------------------------------
/// @details
///		Indicates the engine is done with an object
///	@param[in]	object
///		Object we are stopping
//-------------------------------------------------------------------------
void Counts::endObject(Entry& object) noexcept {
    // Remove it
    endObject(static_cast<TextView>(object.url()));
}

//-------------------------------------------------------------------------
/// @details
///		Convert the counts to json
///	@param[in]	val
///		Receives the json info
//-------------------------------------------------------------------------
void Counts::__toJson(json::Value& val) const noexcept {
    auto guard = lock();

    auto stats = rate();

    val = json::ValueType::objectValue;

    val["countTotal"] = _tso(Format::HEX, m_total.count);
    val["sizeTotal"] = _tso(Format::HEX, m_total.size);

    val["countCompleted"] = _tso(Format::HEX, stats.count);
    val["sizeCompleted"] = _tso(Format::HEX, stats.size);

    val["countFailed"] = _tso(Format::HEX, m_failed.count);
    val["sizeFailed"] = _tso(Format::HEX, m_failed.size);

    val["countRate"] = _tso(Format::HEX, _nc<int>(stats.rateCount * 100));
    val["sizeRate"] = _tso(Format::HEX, _nc<int>(stats.rateSize * 100));

    val["wordCount"] = _tso(Format::HEX, m_words.count);
    val["wordSize"] = _tso(Format::HEX, m_words.size);
}

//-------------------------------------------------------------------------
/// @details
///		Convert the counts to a string
///	@param[out]	buff
///		Receives the string
///	@param[in] opts
///		Formatting options
//-------------------------------------------------------------------------
template <typename Buffer>
void Counts::__toString(Buffer& buff, FormatOptions opts) const noexcept {
    auto guard = lock();
    buff << "Completed: " << m_rate.counts();
    if (m_failed) _tsbo(buff, opts, " ", Color::Red, "Failed: ", m_failed);
    if (m_words) _tsbo(buff, opts, Color::Yellow, " Words: ", m_words);

    _tsbo(buff, opts, " ", Color::Yellow, m_rate.stats(), Color::Reset);
}

//-------------------------------------------------------------------------
/// @details
///		Stop the rate timer
//-------------------------------------------------------------------------
void Counts::stopCounters() noexcept {
    // Stop the rate timer
    m_rate.stop();
}
}  // namespace engine::monitor
