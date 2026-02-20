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

namespace engine {
//-------------------------------------------------------------------------
/// @details
///		Clears the metadata
///	@returns
///		Error
//-------------------------------------------------------------------------
void Metadata::clear() noexcept {
    m_properties.clear();
    m_wordIdWithKeys.clear();
    return;
}

//-------------------------------------------------------------------------
/// @details
///		Determines if the document is an encrypted document
///	@returns
///		Error
//-------------------------------------------------------------------------
bool Metadata::isEncrypted() const noexcept {
    if (auto encrypted =
            _fsc<bool>(get(metadata::intrinsics::XRocketRideIsEncrypted));
        encrypted.hasValue())
        return encrypted.value();
    return false;
}

//-------------------------------------------------------------------------
/// @details
///		Sets the name and value of an item
///	@param[in] name
///		The name of the item
/// @param[in] value
///		The value of an item
//-------------------------------------------------------------------------
void Metadata::set(Text name, Text value) noexcept {
    // Bail if name is empty
    if (!name) return;

    // If the value is empty, just remove the property
    if (!value) {
        remove(name);
        return;
    }

    // No point truncating the name of a property
    if (name.length() > MaxWordSize) {
        LOGTT(Parse,
              "Metadata key exceeds word length limit; discarding metadata "
              "property",
              name, value);
        return;
    }

    // Set it
    m_properties.emplace(_mv(name), _mv(value));
}

//-------------------------------------------------------------------------
/// @details
///		Gets a value from the properties
///	@param[in] name
///		The name of the item
//-------------------------------------------------------------------------
TextView Metadata::get(TextView name) const noexcept {
    auto it = m_properties.find(name);
    if (it != m_properties.end()) return it->second;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Allows ["name"] format
///	@param[in] name
///		The name of the item
//-------------------------------------------------------------------------
TextView Metadata::operator[](TextView name) const noexcept {
    return get(name);
}

//-------------------------------------------------------------------------
/// @details
///		Remove an item from the properties
///	@param[in] name
///		The name of the item
//-------------------------------------------------------------------------
void Metadata::remove(TextView name) noexcept { m_properties.erase(name); }

//-------------------------------------------------------------------------
/// @details
///		Get a property value and remove the property in one operation
///	@param[in] name
///		The name of the item
//-------------------------------------------------------------------------
Text Metadata::extract(TextView name) noexcept {
    auto it = m_properties.find(name);
    if (it == m_properties.end()) return {};

    Text value = _mv(it->second);
    m_properties.erase(it);
    return value;
}

//-------------------------------------------------------------------------
/// @details
///		Do we have an properties?
//-------------------------------------------------------------------------
bool Metadata::empty() const noexcept { return m_properties.empty(); }

//-------------------------------------------------------------------------
/// @details
///		Allows if(!metdata)...
//-------------------------------------------------------------------------
Metadata::operator bool() const noexcept { return !empty(); }

//-------------------------------------------------------------------------
/// @details
///		Gets the number of properties
//-------------------------------------------------------------------------
size_t Metadata::size() const noexcept { return m_properties.size(); }

//-------------------------------------------------------------------------
/// @details
///		Provides for the begin iterator
//-------------------------------------------------------------------------
auto Metadata::begin() const noexcept { return m_properties.begin(); }

//-------------------------------------------------------------------------
/// @details
///		Provides for the end iterator
//-------------------------------------------------------------------------
auto Metadata::end() const noexcept { return m_properties.end(); }

//-------------------------------------------------------------------------
/// @details
///		Compare of the properties are identical
///	@param[in] cmp
///		The property to compare to
//-------------------------------------------------------------------------
bool Metadata::operator==(const Metadata& cmp) const noexcept {
    return m_properties == cmp.m_properties;
}

//-------------------------------------------------------------------------
/// @details
///		Compare of the properties are different
///	@param[in] cmp
///		The property to compare to
//-------------------------------------------------------------------------
bool Metadata::operator!=(const Metadata& cmp) const noexcept {
    return m_properties != cmp.m_properties;
}

//-------------------------------------------------------------------------
/// @details
///		Render a property for display
///	@param[in] name
///		The name of the property
///	@param[in] value
///		The value
//-------------------------------------------------------------------------
Text Metadata::renderProperty(TextView name, TextView value) noexcept {
    return _ts(name, "=", value);
}

//-------------------------------------------------------------------------
/// @details
///		Returns the closes item we can find based on its
///     index value
///	@param[in] id
///		The index of the property to retrieve
//-------------------------------------------------------------------------
TextView Metadata::getClosestKeyByIndex(size_t id) noexcept {
    auto it = m_wordIdWithKeys.lower_bound(id);
    if (it != m_wordIdWithKeys.end()) return it->second;
    return {};
}
}  // namespace engine