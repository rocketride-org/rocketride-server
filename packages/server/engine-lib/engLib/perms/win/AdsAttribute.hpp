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

namespace engine::perms::adsi {

template <ADSTYPE AdsiValueType>
class Attribute abstract {
public:
    _const auto LogLevel = Lvl::Permissions;

    // For now, wrap a single ADSI object attribute, and retrieve the attribute
    // in the constructor
    Attribute(IDirectoryObject &object, const wchar_t *name) noexcept(false)
        : m_name{name} {
        ADS_ATTR_INFO *attributes;
        DWORD attributeCount;
        // TODO: Support fetching ranges of attribute values; see
        // http://systemmanager.ru/adam-sdk.en/ad/example_code_for_ranging_with_idirectoryobject.htm
        if (HRESULT hr = object.GetObjectAttributes(
                _constCast<wchar_t **>(&name), 1, &attributes, &attributeCount);
            FAILED(hr))
            APERRT_THROW(hr);

        // If we didn't get any attribute values back, done
        if (!attributeCount) return;

        // Cleanup the attributes if we leave early
        util::Guard attributesCleanup([=]() { ::FreeADsMem(attributes); });

        // Verify we got a single attribute of the expected type
        if (attributeCount > 1)
            APERRT_THROW(Ec::Unexpected,
                         "IDirectoryObject::GetObjectAttributes returned an "
                         "unexpected number of attributes",
                         name, attributeCount);

        auto &attribute = attributes[0];
        if (attribute.dwADsType != AdsiValueType)
            APERRT_THROW(Ec::Unexpected,
                         "IDirectoryObject::GetObjectAttributes returned an "
                         "attribute of an unexpected type",
                         name, attributes[0].dwADsType);

        // These should always be non-zero if we got this far
        ASSERT(attribute.pADsValues && attribute.dwNumValues);

        // Succeeded; cancel the attribute cleanup
        m_attributes = attributes;
        attributesCleanup.cancel();
    }

    virtual ~Attribute() noexcept {
        if (m_attributes) ::FreeADsMem(m_attributes);
    }

    Attribute(const Attribute &) = delete;
    Attribute(Attribute &&) = default;

    Utf16View name() const noexcept { return m_name; }

protected:
    bool empty() const noexcept { return m_attributes == nullptr; }

    size_t size() const noexcept {
        if (empty()) return 0;
        return m_attributes[0].dwNumValues;
    }

    const ADSVALUE *values() const noexcept {
        if (empty()) return nullptr;
        return m_attributes[0].pADsValues;
    }

protected:
    Utf16View m_name;
    ADS_ATTR_INFO *m_attributes = nullptr;
};

template <ADSTYPE AdsiValueType>
class SingleValueAttribute abstract : public Attribute<AdsiValueType> {
public:
    using Parent = Attribute<AdsiValueType>;

    SingleValueAttribute(IDirectoryObject &object,
                         const wchar_t *name) noexcept(false)
        : Parent{object, name} {
        if (Parent::size() > 1)
            APERRT_THROW(Ec::Unexpected,
                         "IDirectoryObject::GetObjectAttributes returned an "
                         "attribute with an unexpected number of values",
                         name, Parent::size());
    };

protected:
    const ADSVALUE &value() const noexcept {
        ASSERT(Parent::size());
        return Parent::values()[0];
    }
};

class OctetString : public SingleValueAttribute<ADSTYPE_OCTET_STRING> {
public:
    using Parent = SingleValueAttribute<ADSTYPE_OCTET_STRING>;

    OctetString(IDirectoryObject &object, const wchar_t *name) noexcept(false)
        : Parent{object, name} {
        if (!empty() && (!value().lpValue || !value().dwLength))
            APERRT_THROW(Ec::Unexpected,
                         "IDirectoryObject::GetObjectAttributes returned an "
                         "empty octet string",
                         name);
    };

    virtual ~OctetString() = default;
    OctetString(const OctetString &) = delete;
    OctetString(OctetString &&) = default;

    ADS_OCTET_STRING value() const noexcept {
        if (Parent::empty()) return {};
        return Parent::value().OctetString;
    }
};

class Sid : protected OctetString {
public:
    using Parent = OctetString;
    using Parent::LogLevel;

    Sid(IDirectoryObject &object) noexcept(false)
        : OctetString{object, L"objectSid"} {
        if (empty())
            APERRT_THROW(Ec::Unexpected,
                         "Failed to retrieve SID from IDirectoryObject");
    }

    virtual ~Sid() = default;
    Sid(const Sid &) = delete;
    Sid(Sid &&) = default;

    perms::Sid sid() const noexcept(false) {
        return perms::Sid::fromPtr(value().lpValue, value().dwLength);
    }

    operator perms::Sid() const noexcept(false) { return sid(); }
};

class DnString : public SingleValueAttribute<ADSTYPE_DN_STRING> {
public:
    using Parent = SingleValueAttribute<ADSTYPE_DN_STRING>;

    DnString(IDirectoryObject &object, const wchar_t *name) noexcept(false)
        : Parent{object, name} {
        if (!empty()) {
            m_value = Parent::value().DNString;
            if (!m_value)
                APERRT_THROW(Ec::Unexpected,
                             "IDirectoryObject::GetObjectAttributes returned "
                             "an empty DN string",
                             name);
        }
    };

    virtual ~DnString() = default;
    DnString(const DnString &) = delete;
    DnString(DnString &&) = default;

    Utf16View value() const noexcept { return m_value; }

    operator Utf16View() const noexcept { return value(); }

protected:
    Utf16View m_value;
};

class Dn : public DnString {
public:
    Dn(IDirectoryObject &object) noexcept(false)
        : DnString{object, L"distinguishedName"} {
        if (empty())
            APERRT_THROW(Ec::Unexpected,
                         "Failed to retrieve DN from IDirectoryObject");
        ASSERT(m_value);
    }

    virtual ~Dn() = default;
    Dn(const Dn &) = delete;
    Dn(Dn &&) = default;
};

class SidHistory : public Attribute<ADSTYPE_OCTET_STRING> {
public:
    using Parent = Attribute<ADSTYPE_OCTET_STRING>;

    SidHistory(IDirectoryObject &object) noexcept(false)
        : Parent{object, L"sIDHistory"} {}

    virtual ~SidHistory() = default;
    SidHistory(const SidHistory &) = delete;
    SidHistory(SidHistory &&) = default;

    // Expose the protected size() method
    using Parent::size;

    perms::Sid value(size_t index) const noexcept(false) {
        ASSERT(index < size());
        auto &value = Parent::values()[index].OctetString;
        if (!value.lpValue || !value.dwLength)
            APERRT_THROW(Ec::Unexpected,
                         "IDirectoryObject::GetObjectAttributes returned an "
                         "empty octet string",
                         name(), index);

        return perms::Sid::fromPtr(value.lpValue, value.dwLength);
    }
};

class DnStringArray : public Attribute<ADSTYPE_DN_STRING> {
public:
    using Parent = Attribute<ADSTYPE_DN_STRING>;

    DnStringArray(IDirectoryObject &object, const wchar_t *name) noexcept(false)
        : Parent(object, name) {}

    virtual ~DnStringArray() = default;
    DnStringArray(const DnStringArray &) = delete;
    DnStringArray(DnStringArray &&) = default;

    // Expose the protected size() method
    using Parent::size;

    Utf16View value(size_t index) const noexcept(false) {
        ASSERT(index < size());
        return Parent::values()[index].DNString;
    }
};

}  // namespace engine::perms::adsi
