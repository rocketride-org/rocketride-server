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

namespace engine {
//-------------------------------------------------------------------------
/// @details
///		Handles access to various fields
//-------------------------------------------------------------------------
template <typename T>
class EntryValue {
public:
    //=================================================================
    // Setters
    //=================================================================

    //-----------------------------------------------------------------
    ///	@details
    ///		Sets the value
    ///	@param[in]	value
    ///		The direct value
    //-----------------------------------------------------------------
    void set(const T value) noexcept {
        m_value = value;
        m_hasValue = true;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Sets the value
    ///	@param[in]	value
    ///		The value to set
    //-----------------------------------------------------------------
    T& operator()(const T& value) noexcept {
        m_value = value;
        m_hasValue = true;
        return m_value;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Sets the value
    ///	@param[in]	value
    ///		The value to set
    //-----------------------------------------------------------------
    T& operator()(T&& value) noexcept {
        m_value = _mv(value);
        m_hasValue = true;
        return m_value;
    }

    //=================================================================
    // Getters
    //=================================================================

    //-----------------------------------------------------------------
    ///	@details
    ///		Gets the value
    //-----------------------------------------------------------------
    T get() const noexcept { return m_value; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Gets the value
    //-----------------------------------------------------------------
    const T& operator()() const noexcept { return m_value; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Use only to geta writable copy for json::Values
    //-----------------------------------------------------------------
    T& value() noexcept { return m_value; }

    //=================================================================
    // Misc
    //=================================================================

    //-----------------------------------------------------------------
    ///	@details
    ///		Determines if a value is present
    //-----------------------------------------------------------------
    operator bool() const noexcept { return m_hasValue; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Resets the value
    //-----------------------------------------------------------------
    void reset() noexcept {
        m_value = {};
        m_hasValue = false;
    }

private:
    //-----------------------------------------------------------------
    ///	@details
    ///		Declare the value we are controlling
    //-----------------------------------------------------------------
    T m_value{};

    //-----------------------------------------------------------------
    ///	@details
    ///		Flag indicating whether the value was specifically set
    //-----------------------------------------------------------------
    bool m_hasValue{};
};

//-------------------------------------------------------------------------
/// @details
///		Handles various time formats
//-------------------------------------------------------------------------
class EntryTime : public EntryValue<time::SystemStamp> {
public:
    using T = time::SystemStamp;
    using Parent = EntryValue<time::SystemStamp>;
    using Parent::Parent;
    using Parent::operator();

    //=================================================================
    // Getters (additional)
    //=================================================================

    //-----------------------------------------------------------------
    ///	@details
    ///		Gets the time in seconds
    //-----------------------------------------------------------------
    time_t operator()() const {
        T systemTime = Parent::operator()();

        auto value = time::toTimeT(systemTime);
        if (value < 0)
            return 0;
        else {
            // jsoncpp<->NodeJS: 56 bits only (according to Rod Christensen )
            return value & 0xFF'FFFF'FFFF'FFFFull;
        }
    }

    //=================================================================
    // Setters (additional)
    //=================================================================

    //-----------------------------------------------------------------
    ///	@details
    ///		Sets the value via a text parse from ISO_8601 or the
    ///		default format
    ///	@param[in]	value
    ///		The time string
    //-----------------------------------------------------------------
    T operator()(const TextView value) {
        ErrorOr<T> res;

        res = time::parseDateTime(value, time::ISO_8601_DATE_TIME_FMT);
        if (!res) res = time::parseDateTime(value, time::DEF_FMT);
        if (res)
            return Parent::operator()(*res);
        else
            return time::SystemStamp::min();
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Sets the time in seconds
    ///	@param[in]	value
    ///		The time in seconds
    //-----------------------------------------------------------------
    T operator()(const time_t value) {
        T time = time::fromTimeT<time::SystemStamp>(value);
        return Parent::operator()(time);
    }
};

//-------------------------------------------------------------------------
/// @details
///		Handles various time formats
//-------------------------------------------------------------------------
class EntryComponentId : public EntryValue<crypto::Sha512Hash> {
public:
    using T = crypto::Sha512Hash;
    using Parent = EntryValue<crypto::Sha512Hash>;
    using Parent::Parent;
    using Parent::operator();

    //=================================================================
    // Setters (additional)
    //=================================================================

    //-----------------------------------------------------------------
    ///	@details
    ///		Sets the value via a text parse from ISO_8601 or the
    ///		default format
    ///	@param[in]	value
    ///		The time string
    //-----------------------------------------------------------------
    void operator()(const TextView value) {
        auto hash = _fsc<crypto::Sha512Hash>(value);
        if (!hash) {
            LOG(Always, "Warning: Invalid componentId hash detected", value,
                "; skipping assignment of compononentId");
            return;
        }
        Parent::operator()(_mv(*hash));
    }

    //=================================================================
    // Getters (additional)
    //=================================================================

    //-----------------------------------------------------------------
    ///	@details
    ///		Get the hash as a string
    //-----------------------------------------------------------------
    Text operator()() const { return _ts(Parent::operator()()); }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get the actual hash directly
    //-----------------------------------------------------------------
    const crypto::Sha512Hash& hash() const { return Parent::operator()(); }
};

//-------------------------------------------------------------------------
/// @details
///		Handles access to json fields
//-------------------------------------------------------------------------
class EntryJson : json::Value {
public:
    //=================================================================
    // Setters
    //=================================================================

    //-----------------------------------------------------------------
    ///	@details
    ///		Sets the value
    ///	@param[in]	value
    ///		The direct value
    //-----------------------------------------------------------------
    void set(const json::Value& value) noexcept {
        _cast<json::Value&>(*this) = value;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Sets the value
    ///	@param[in]	value
    ///		The direct value
    //-----------------------------------------------------------------
    void set(json::Value&& value) noexcept {
        _cast<json::Value&>(*this) = _mv(value);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Sets the value
    ///	@param[in]	value
    ///		The value to set
    //-----------------------------------------------------------------
    json::Value& operator()(const json::Value& value) noexcept {
        set(value);
        return *this;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Sets the value
    ///	@param[in]	value
    ///		The value to set
    //-----------------------------------------------------------------
    json::Value& operator()(json::Value&& value) noexcept {
        set(_mv(value));
        return *this;
    }

    //=================================================================
    // Getters
    //=================================================================

    //-----------------------------------------------------------------
    ///	@details
    ///		Gets the value (const)
    //-----------------------------------------------------------------
    const json::Value& get() const noexcept { return *this; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Gets the value (non-const)
    //-----------------------------------------------------------------
    json::Value& get() noexcept { return *this; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Gets the value
    //-----------------------------------------------------------------
    const json::Value& operator()() const noexcept { return get(); }

    //-----------------------------------------------------------------
    ///	@details
    ///		Gets the value (non-const)
    //-----------------------------------------------------------------
    json::Value& operator()() noexcept { return get(); }

    //=================================================================
    // Misc
    //=================================================================

    //-----------------------------------------------------------------
    ///	@details
    ///		Determines if a value is present
    //-----------------------------------------------------------------
    operator bool() const noexcept { return json::Value::operator bool(); }

    //-----------------------------------------------------------------
    ///	@details
    ///		Resets the value
    //-----------------------------------------------------------------
    void reset() noexcept { set({}); }
};

//------------------------------------------------------------------------
/// @details
///		Define the operation mark for objects. It should be either
///     A for Add or M for Modify or D for Delete operation.
//-------------------------------------------------------------------------
struct ENTRY_OPERATION {
    _const Text::CharacterType ADD = 'A';
    _const Text::CharacterType MODIFY = 'M';
    _const Text::CharacterType REMOVE = 'D';

    ENTRY_OPERATION() = delete;
    ~ENTRY_OPERATION() = delete;
    ENTRY_OPERATION(const ENTRY_OPERATION&) = delete;
    void operator=(const ENTRY_OPERATION&) = delete;
};

//------------------------------------------------------------------------
/// @details
///		Define the scan type for the sync token service.
///		FULL - all the children objects scanned not using the sync token.
///		DELTA - only the changed children objects scanned using sync token.
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM(EntrySyncScanType, 0, 2, FULL = _begin, DELTA);

//-------------------------------------------------------------------------
/// @details
///		Handles various operations
//-------------------------------------------------------------------------
class EntryOperation : public EntryValue<Text::CharacterType> {
public:
    using Parent = EntryValue<Text::CharacterType>;
    using Parent::set;
    using Parent::operator();

    //=================================================================
    // Setters (additional)
    //=================================================================

    //-----------------------------------------------------------------
    ///	@details
    ///		Sets the operation char if valid
    ///	@param[in]	value
    ///		The direct value
    //-----------------------------------------------------------------
    void set(Text::CharacterType value) noexcept {
        if (value != ENTRY_OPERATION::ADD && value != ENTRY_OPERATION::MODIFY &&
            value != ENTRY_OPERATION::REMOVE) {
            LOG(Error, "Unknown entry operation", value);
            return;
        }

        Parent::set(value);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Sets the operation char if valid
    ///	@param[in]	value
    ///		The direct value
    //-----------------------------------------------------------------
    void operator()(Text::CharacterType value) noexcept { set(value); }

    //-----------------------------------------------------------------
    ///	@details
    ///		Sets the operation char if the valid string given
    ///	@param[in]	value
    ///		The direct value
    //-----------------------------------------------------------------
    void operator()(const TextView value) noexcept {
        if (value.size() != 1) {
            LOG(Error, "Invalid entry operation", value);
            return;
        }

        set(value.front());
    }
};

//-------------------------------------------------------------------------
/// @details
///		Defines the entry info that is passed around between the pipes
///		scans, instance, etc
//-------------------------------------------------------------------------
class Entry {
public:
    //----------------------------------------------------------------
    /// @details
    ///		Define the flags for objects - these flags are also
    ///		passed directly into the java tika engine. See
    ///		TikaApi.java if these are changed!
    //----------------------------------------------------------------
    class FLAGS : public ap::flags::ENTRY_FLAGS {};

    //----------------------------------------------------------------
    /// @details
    ///		Define the iflags for objects - these iflags are also
    ///		sent directly from the App to engine to detect if a file has the
    ///"deleted" mark in DB.
    ///     App controls that iFlags.
    ///     See
    ///     https://bitbucket.org/rocketride/rocketride-app/src/92e3aba1d0dd4339fb91796f2ead0c1a9affa545/app/server/server/services/database/private/models/instances.ts#app/server/server/services/database/private/models/instances.ts-51
    //----------------------------------------------------------------
    class IFLAGS : public ap::flags::ENTRY_IFLAGS {};

    //----------------------------------------------------------------
    /// @details
    ///		Define the operation mark for objects.
    //----------------------------------------------------------------
    typedef ENTRY_OPERATION OPERATION;

    //----------------------------------------------------------------
    /// @details
    ///		Define the scan type of the children objects.
    //----------------------------------------------------------------
    typedef EntrySyncScanType SyncScanType;

    //-----------------------------------------------------------------
    // Constructor/drestructor
    //-----------------------------------------------------------------
    ~Entry() {}
    Entry() noexcept {}
    Entry(Url& url_) noexcept { url(url_); }

    Entry(Url&& url_) noexcept { url(url_); }

    //-----------------------------------------------------------------
    /// @details
    ///		The completion code is the way for the pipes layers to
    ///		signal a failure on the object.
    //-----------------------------------------------------------------
    EntryValue<Error> completionCode;

    bool objectFailed() const {
        if (completionCode())
            return true;
        else
            return false;
    }

    bool objectSkipped() const {
        if (completionCode() == Ec::Skipped)
            return true;
        else
            return false;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Set changed bit, increment version, and log diagnostic
    ///		details about why how it has changed
    //-----------------------------------------------------------------
    template <log::Lvl LvlT = Lvl::JobSign, typename... Args>
    void markChanged(Args... args) noexcept {
        // Log diagnostic reason why entry is being treated as changed
        LOGX(LvlT, args...);

        // If it has not yet been changed, bump the version
        if (!changed()) version(version() + 1);

        // Say it was changed
        changed(true);
    };

    //-----------------------------------------------------------------
    /// @details
    ///		The url of the entry
    //-----------------------------------------------------------------
    EntryValue<Url> url;

    //-----------------------------------------------------------------
    /// @details
    ///		The url by unique names of the entry.
    ///     Optional, set for sync entries only.
    //-----------------------------------------------------------------
    EntryValue<Url> uniqueUrl;

    Text fileName() const noexcept {
        Text t = url().fileName();
        return _mv(t);
    }
    Text path() const noexcept {
        Text t = (TextView)url().path();
        return _mv(t);
    }
    Text uniquePath() const noexcept {
        return uniqueUrl ? (TextView)uniqueUrl().path() : "";
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Instance id - this is mainly to/from the app - we don't
    ///		come up with the instance id
    //-----------------------------------------------------------------
    EntryValue<bool> changed;
    EntryValue<bool> isContainer;
    EntryValue<bool> isOffline;
    EntryValue<Text> name;
    EntryValue<Text> uniqueName;
    EntryValue<Text> parentUniqueName;
    EntryOperation operation;
    EntryValue<SyncScanType> syncScanType;
    EntryValue<Text> changeKey;

    EntryValue<Text> objectId;
    EntryValue<Text> parentId;
    EntryValue<uint64_t> instanceId;
    EntryValue<uint32_t> version;
    EntryValue<uint32_t> flags;
    EntryValue<uint32_t> iflags;
    EntryValue<uint32_t> attrib;
    EntryValue<uint64_t> size;
    EntryValue<uint64_t> storeSize;
    EntryValue<uint64_t> wordBatchId;
    EntryValue<uint64_t> vectorBatchId;
    EntryValue<uint32_t> serviceId;
    EntryValue<Text> keyId;
    EntryTime createTime;
    EntryTime changeTime;
    EntryTime modifyTime;
    EntryTime accessTime;
    EntryComponentId componentId;

    EntryValue<uint32_t> permissionId;
    EntryJson permissions;
    EntryJson metadata;
    EntryValue<uint64_t> tagSetId;
    EntryValue<Text> docCreator;
    EntryValue<Text> docModifier;
    EntryValue<uint32_t> classificationId;
    EntryJson classifications;
    EntryTime docCreateTime;
    EntryTime docModifyTime;
    EntryJson objectTags;
    EntryJson instanceTags;

    EntryJson response;

    uint32_t attempt;

    //-----------------------------------------------------------------
    /// @details
    ///		Returns true if the entry is an object, false otherwise
    //-----------------------------------------------------------------
    bool isObject() const noexcept { return !isContainer || !isContainer(); }

    //-----------------------------------------------------------------
    /// @details
    ///		Reset all the fields within the entry
    //-----------------------------------------------------------------
    void reset() {
        url.reset();
        uniqueUrl.reset();
        changed.reset();
        isContainer.reset();
        isOffline.reset();
        name.reset();
        uniqueName.reset();
        parentUniqueName.reset();
        operation.reset();

        objectId.reset();
        instanceId.reset();
        version.reset();
        flags.reset();
        // iflags.reset(); // App controls that iFlags.
        iflags(iflags() &
               ~IFLAGS::DELETED);  // At the moment we can reset only this bit
        attrib.reset();
        size.reset();
        storeSize.reset();
        wordBatchId.reset();
        vectorBatchId.reset();
        serviceId.reset();
        keyId.reset();
        createTime.reset();
        changeTime.reset();
        modifyTime.reset();
        accessTime.reset();
        componentId.reset();

        permissions.reset();
        permissionId.reset();
        metadata.reset();
        docCreator.reset();
        docModifier.reset();
        classificationId.reset();
        classifications.reset();
        docCreateTime.reset();
        docModifyTime.reset();
        objectTags.reset();
        instanceTags.reset();
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Parse our configs from a json value
    ///	@param[in]	parentUrl
    ///		The parent url
    ///	@param[in]	val
    ///		The value passed from an entry in the pipe file
    ///	@param[in]	allFields
    ///		Read all fields (used for reading output pipes)
    //-----------------------------------------------------------------
    static ErrorOr<Entry> makeEntry(const Url& parentUrl,
                                    const json::Value& val,
                                    bool allFields = false) noexcept {
        // Get the name
        Text name;
        if (auto value = val.getKey("name")) name = value->asString();

        // Get the caps of the protocol
        uint32_t caps = 0;
        if (auto ccode = Url::getCaps(parentUrl, caps)) return ccode;

        // Get the url
        Url url;
        if (caps & Url::PROTOCOL_CAPS::SYNC) {
            // Build the object url without query
            url = Url(parentUrl.protocol(), parentUrl.fullpath() / name, "");
        } else {
            url = parentUrl / name;
        }

        // Create the entry
        Entry entry(url);

        if (caps & Url::PROTOCOL_CAPS::SYNC) {
            // Get the parent unique url
            Url parentUniqueUrl;
            if (auto value = parentUrl.lookup("unique"))
                parentUniqueUrl = value;

            if (parentUniqueUrl.fullpath()) {
                // Get the unique name
                Text uniqueName;
                if (auto value = val.getKey("uniqueName"))
                    uniqueName = value->asString();

                // Get the unique url
                Url uniqueUrl{_mv(parentUniqueUrl / uniqueName)};

                // Set the unique url to the entry
                entry.uniqueUrl(uniqueUrl);
            }
        }

        // Update the entry fields
        if (auto ccode = __fromJson(entry, val, allFields)) return ccode;

        // And return it
        return entry;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Reads the entry fields from from a json value
    ///	@param[out]	entry
    ///		The entry to read the fields to
    ///	@param[in]	val
    ///		The json value to read the fields from
    ///	@param[in]	syncFields
    ///		Read sync fields (used for sync endpoints)
    ///	@param[in]	allFields
    ///		Read all fields (used for reading output pipes)
    //-----------------------------------------------------------------
    static Error __fromJson(Entry& entry, const json::Value& val,
                            bool allFields) noexcept {
        // Get the caps of the protocol
        uint32_t caps = 0;
        if (auto ccode = Url::getCaps(entry.url(), caps)) return ccode;

        if (auto value = val.getKey("name")) entry.name(value->asString());

        if (caps & Url::PROTOCOL_CAPS::SYNC) {
            if (auto value = val.getKey("operation"))
                entry.operation(value->asString());
            if (auto value = val.getKey("syncScanType"))
                entry.syncScanType(_fs<Entry::SyncScanType>(value->asString()));
            if (auto value = val.getKey("changeKey"))
                entry.changeKey(value->asString());
            if (auto value = val.getKey("uniqueName"))
                entry.uniqueName(value->asString());
            if (auto value = val.getKey("parentUniqueName"))
                entry.parentUniqueName(value->asString());
        }

        if (auto value = val.getKey("objectId"))
            entry.objectId(value->asString());
        if (auto value = val.getKey("parentId"))
            entry.parentId(value->asString());
        if (auto value = val.getKey("instanceId"))
            entry.instanceId(value->asUInt64());
        if (auto value = val.getKey("version")) entry.version(value->asUInt());
        if (auto value = val.getKey("flags")) entry.flags(value->asUInt());
        if (auto value = val.getKey("iFlags")) entry.iflags(value->asUInt());
        if (auto value = val.getKey("attrib")) entry.attrib(value->asUInt());
        if (auto value = val.getKey("size")) entry.size(value->asUInt64());
        if (auto value = val.getKey("storeSize"))
            entry.storeSize(value->asUInt64());
        if (auto value = val.getKey("wordBatchId"))
            entry.wordBatchId(value->asUInt64());
        if (auto value = val.getKey("vectorBatchId"))
            entry.vectorBatchId(value->asUInt64());
        if (auto value = val.getKey("serviceId"))
            entry.serviceId(value->asUInt());
        if (auto value = val.getKey("keyId")) entry.keyId(value->asString());
        if (auto value = val.getKey("createTime"))
            entry.createTime(value->asUInt64());
        if (auto value = val.getKey("changeTime"))
            entry.changeTime(value->asUInt64());
        if (auto value = val.getKey("modifyTime"))
            entry.modifyTime(value->asUInt64());
        if (auto value = val.getKey("accessTime"))
            entry.accessTime(value->asUInt64());
        if (auto value = val.getKey("classificationId"))
            entry.classificationId(value->asUInt());
        if (auto value = val.getKey("componentId"))
            entry.componentId(value->asString());
        if (auto value = val.getKey("metadata")) entry.metadata(*value);
        if (auto value = val.getKey("tagSetId"))
            entry.tagSetId(value->asUInt64());
        if (auto value = val.getKey("permissionId"))
            entry.permissionId(value->asUInt());
        if (auto value = val.getKey("objectTags")) entry.objectTags(*value);
        if (auto value = val.getKey("instanceTags")) entry.instanceTags(*value);
        if (auto value = val.getKey("isContainer"))
            entry.isContainer(value->asBool());

        // These are not normally passed
        if (allFields) {
            if (auto value = val.getKey("classifications"))
                entry.classifications(*value);
            if (auto value = val.getKey("docCreator"))
                entry.docCreator(value->asString());
            if (auto value = val.getKey("docModifier"))
                entry.docModifier(value->asString());
            if (auto value = val.getKey("docCreateTime"))
                entry.docCreateTime(value->asUInt64());
            if (auto value = val.getKey("docModifyTime"))
                entry.docModifyTime(value->asUInt64());
        }

        return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Output all the fields that have been set to the
    ///		json value
    ///	@param[in]	val
    ///		The json value to set
    //-----------------------------------------------------------------
    Error __toJson(json::Value& val) const noexcept {
        // Output isContainer only if it it really a container
        if (isContainer()) val["isContainer"] = true;

        // Name will be set by the scanner, otherwise get it from the url
        val["name"] = name ? name() : fileName();

        // Output all the other fields
        if (changed) val["isChanged"] = changed() ? true : false;
        if (uniqueName) val["uniqueName"] = uniqueName();
        if (parentUniqueName) val["parentUniqueName"] = parentUniqueName();
        // Do not include operation to json view
        // if (operation) val["operation"] = operation();
        if (syncScanType) val["syncScanType"] = _ts(syncScanType());
        if (changeKey) val["changeKey"] = _ts(changeKey());
        if (objectId) val["objectId"] = objectId();
        if (parentId) val["parentId"] = parentId();
        if (instanceId) val["instanceId"] = instanceId();
        if (version) val["version"] = version();
        if (flags) val["flags"] = flags();
        if (iflags) val["iFlags"] = iflags();
        if (attrib) val["attrib"] = attrib();
        if (size) val["size"] = size();
        if (storeSize) val["storeSize"] = storeSize();
        if (wordBatchId) val["wordBatchId"] = wordBatchId();
        if (vectorBatchId) val["vectorBatchId"] = vectorBatchId();
        if (serviceId) val["serviceId"] = serviceId();
        if (keyId) val["keyId"] = keyId();
#ifdef ROCKETRIDE_PLAT_MAC
        if (createTime)
            val["createTime"] = static_cast<unsigned long>(createTime());
        if (changeTime)
            val["changeTime"] = static_cast<unsigned long>(changeTime());
        if (modifyTime)
            val["modifyTime"] = static_cast<unsigned long>(modifyTime());
        if (accessTime)
            val["accessTime"] = static_cast<unsigned long>(accessTime());
#else
        if (createTime) val["createTime"] = createTime();
        if (changeTime) val["changeTime"] = changeTime();
        if (modifyTime) val["modifyTime"] = modifyTime();
        if (accessTime) val["accessTime"] = accessTime();
#endif
        if (classificationId) val["classificationId"] = classificationId();
        if (componentId) val["componentId"] = componentId();

        if (permissionId) val["permissionId"] = permissionId();
        if (metadata) val["metadata"] = metadata();
        if (tagSetId) val["tagSetId"] = tagSetId();
        if (classifications) val["classifications"] = classifications();
        if (docCreator) val["docCreator"] = docCreator();
        if (docModifier) val["docModifier"] = docModifier();
#ifdef ROCKETRIDE_PLAT_MAC
        if (docCreateTime)
            val["docCreateTime"] = static_cast<unsigned long>(docCreateTime());
        if (docModifyTime)
            val["docModifyTime"] = static_cast<unsigned long>(docModifyTime());
#else
        if (docCreateTime) val["docCreateTime"] = docCreateTime();
        if (docModifyTime) val["docModifyTime"] = docModifyTime();
#endif
        if (objectTags) val["objectTags"] = objectTags();
        if (instanceTags) val["instanceTags"] = instanceTags();

        if (response) val["response"] = response();

        return {};
    }
};

}  // namespace engine
