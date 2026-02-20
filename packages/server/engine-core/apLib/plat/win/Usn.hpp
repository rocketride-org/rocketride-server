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

#pragma once

namespace ap::plat {

// Types for UsnWalker class which is required to make sure the
// static constexpr function is available to the UsnWalker class
struct UsnWalkerTypes {
    using JournalIdType =
        decltype(std::declval<USN_JOURNAL_DATA &>().UsnJournalID);
    using UsnType = decltype(std::declval<USN_JOURNAL_DATA &>().FirstUsn);
    using VersionType =
        decltype(std::declval<USN_RECORD_COMMON_HEADER &>().MajorVersion);
    using ReasonType = decltype(std::declval<USN_RECORD_V4 &>().Reason);
    using RawBufferArray = Array<uint8_t, 4_kb + sizeof(UsnType)>;
    using PlatformFileIdDescriptor = FILE_ID_DESCRIPTOR;

    // Normalize windows reason flags into consumable reasons
    // place most significant change reasons before less significant ones
    APUTIL_DEFINE_ENUM_C(
        Reason, 0, 6, AttributesChanged = _begin, ContentsAdded,
        ContentsRemoved, ContentsChanged, HardLinkChanged,

        // Ignored attributes should be filtered but for the sake of a
        // complete LUT, an enum is needed as an ignored placeholder
        Ignored)

    using ReasonLutPair = Pair<ReasonType, Reason>;

    // Lookup table to map change attribute flags to the most significant
    // change notification type about the journal entry
    // https://docs.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-usn_record_v4
    _const Pair<uint32_t, Reason> WindowsToNormalizedReasonLut[] = {
        {USN_REASON_BASIC_INFO_CHANGE, Reason::AttributesChanged},
        {USN_REASON_CLOSE, Reason::ContentsChanged},
        {USN_REASON_COMPRESSION_CHANGE, Reason::Ignored},
        {USN_REASON_DATA_EXTEND, Reason::ContentsAdded},
        {USN_REASON_DATA_OVERWRITE, Reason::ContentsChanged},
        {USN_REASON_DATA_TRUNCATION, Reason::ContentsChanged},
        {USN_REASON_EA_CHANGE, Reason::AttributesChanged},
        {USN_REASON_ENCRYPTION_CHANGE, Reason::Ignored},
        {USN_REASON_FILE_CREATE, Reason::ContentsAdded},
        {USN_REASON_FILE_DELETE, Reason::ContentsRemoved},
        {USN_REASON_HARD_LINK_CHANGE, Reason::HardLinkChanged},
        {USN_REASON_INDEXABLE_CHANGE, Reason::Ignored},
        {USN_REASON_INTEGRITY_CHANGE, Reason::ContentsChanged},
        {USN_REASON_NAMED_DATA_EXTEND, Reason::ContentsAdded},
        {USN_REASON_NAMED_DATA_OVERWRITE, Reason::ContentsChanged},
        {USN_REASON_NAMED_DATA_TRUNCATION, Reason::ContentsChanged},
        {USN_REASON_OBJECT_ID_CHANGE, Reason::ContentsChanged},
        {USN_REASON_RENAME_NEW_NAME, Reason::ContentsAdded},
        {USN_REASON_RENAME_OLD_NAME, Reason::ContentsRemoved},
        {USN_REASON_REPARSE_POINT_CHANGE, Reason::ContentsChanged},
        {USN_REASON_SECURITY_CHANGE, Reason::AttributesChanged},
        {USN_REASON_STREAM_CHANGE, Reason::ContentsChanged},
        {USN_REASON_TRANSACTED_CHANGE, Reason::ContentsChanged}};

    // Create a bit filter of USN reasons that need not be examined/scanned
    static constexpr ReasonType makeReasonFilter() noexcept {
        ReasonType filterReason{};
        for (auto entry : WindowsToNormalizedReasonLut) {
            if (entry.second != Reason::Ignored) continue;
            filterReason |= entry.first;
        }
        return filterReason;
    }
};

// Scanner of the USN journal to determine what changes have happened to the
// filesystem since the start of the journal, or since a specific checkpoint
// in the USN journalling's record keeping
class UsnWalker final : public UsnWalkerTypes {
    struct JournalToken;

public:
    _const auto LogLevel = Lvl::Usn;

    ~UsnWalker() noexcept { close(); }

    // Open a volume assuming the volume supports journalling and the
    // caller has administrative privileges to access the journalling
    Error open(const file::Path &path) noexcept {
        if (!application::elevated())
            return APERRT(Ec::ElevationRequired, "Must run as administrator",
                          path);

        ASSERT(m_rootPath.empty());  // Once set, this object cannot be reused
        ASSERT((!path.empty()) && (!path.isUnc()) && (!path.isUnc()) &&
               (!path.isSnap()) && (!path.isRelative()));

        m_rootPath = path;

        // Seems platLong will add a final "/" but not remove a final "/"
        Utf16 usePath = m_rootPath.platLong();
        usePath.trimTrailing({'\\'});

        // Administrative privileges required for paths that are direct
        // drive letters, like C: (which becomes \\?\C:)
        m_volume.reset(::CreateFileW(usePath, GENERIC_READ | GENERIC_WRITE,
                                     FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                                     OPEN_EXISTING, 0, NULL));

        if (!m_volume)
            return APERRT(::GetLastError(),
                          "Failed to open file to obtain volume information");

        if (auto ccode = refresh()) return ccode;

        if (auto ccode = primeBuffer()) return ccode;

        LOGT("Volume open");

        return {};
    }

    // Rewind to the very first entry found in the USN journal
    Error seekFirst() noexcept {
        ASSERT(m_volume);

        // starting over
        m_token.reset();
        m_buffer.reset();

        if (auto ccode = refresh()) return ccode;

        if (auto ccode = primeBuffer()) return ccode;

        LOGT("Seek first succeeded, token:", token());
        return {};
    }

    // Fast-forward to the very last journal record to start walking any
    // new entries that become found from this point forward
    Error seekLast() noexcept {
        ASSERT(m_volume);

        if (auto ccode = refresh()) return ccode;

        m_token.emplace();
        m_token->journalId = m_journalData.UsnJournalID;
        m_token->usnId = m_journalData.NextUsn;

        if (auto ccode = primeBuffer(true)) return ccode;

        LOGT("Seek last succeeded, token:", token());
        return {};
    }

    // Seek a specific position in the journal to start scanning the journal
    // from that point forward
    Error seek(TextView inputToken) noexcept {
        ASSERT(m_volume);

        auto oldToken = m_token;

        util::Guard resetToken{[&]() noexcept { m_token = oldToken; }};

        auto tokens = split(inputToken, ":");

        if (tokens.size() != 3)
            return APERRT(Ec::InvalidKeyToken, "Invalid token", inputToken);

        // A magic string is used in case the walking token was done with a
        // previous version's token algorithm that is not supported anymore
        auto magic = _fs<UsnType>(tokens[0]);
        if (magic != MagicToken)
            return APERRT(Ec::Unexpected, "Unexpected token value:", inputToken,
                          "version:", magic, "expecting:", MagicToken);

        if (auto ccode = refresh()) return ccode;

        m_token.emplace();
        m_token->journalId = _fs<JournalIdType>(tokens[1]);
        m_token->usnId = _fs<UsnType>(tokens[2]);

        if (m_token->journalId != m_journalData.UsnJournalID)
            return APERRT(Ec::InvalidKeyToken, "Token expired", inputToken,
                          "found", m_token->journalId,
                          "expecting:", m_journalData.UsnJournalID);

        if (auto ccode = primeBuffer(true)) return ccode;

        resetToken.cancel();

        LOGT("Seek token succeeded, new token:", token(),
             "requested:", inputToken,
             "old token:", oldToken ? token(*oldToken) : Text{});
        return {};
    }

    ErrorOr<Text> token() const noexcept {
        if (!m_token) return Text{};
        ASSERT(m_volume);
        return token(*m_token);
    }

    struct Entry {
        file::Path path;
        Reason reason{};
        size_t skipped{};
        PlatformFileIdDescriptor rawDescriptor;

        // Return a DataView into the real identifier within the rawDescriptor
        // whose length is <= sizeof(PlatformFileIdDescriptor)
        InputData fileDescriptorId() const noexcept {
            return fileDescriptorIdRawData(rawDescriptor);
        }
    };

    // Reads the next journal entry if available,
    // or returns an error if the journal error if a failure occurs
    ErrorOr<Opt<Entry>> next(
        bool includeFilesNoLongerPresent = false) noexcept {
        ASSERT(m_volume);
        ASSERT(m_buffer);

        size_t totalSkipped{};

        // Needs to be a union; this aligns all the types in memory as they
        // all overlap and they have additional trailing "extra" data appended
        // after each structure
        union AlignedBuffers {
            RawBufferArray rawData{};  // NOT used; only for reserving space
            USN_RECORD_COMMON_HEADER common;
            USN_RECORD_V2 v2;
            USN_RECORD_V3 v3;
            USN_RECORD_V4 v4;
        } record;

        _forever() {
            if (auto ccode = primeNextResult()) return ccode;

            if (!m_buffer) return NullOpt;
            if (!m_buffer->common) return NullOpt;

            // Read the raw source buffer record into an aligned record so
            // the actual data can be directly accessed via the union/structure
            memcpy(&(record.common), m_buffer->common,
                   std::min(_nc<size_t>(m_buffer->extractedCommon.RecordLength),
                            sizeof(record)));

            LOGTO(UsnDetails,
                  "Read common record, version:", record.common.MajorVersion,
                  "record length", record.common.RecordLength);

            ReasonType reason{};

            PlatformFileIdDescriptor descriptor{};
            descriptor.dwSize = sizeof(PlatformFileIdDescriptor);

            BufferView fileIdRaw{};

            // Figure out what type of structure this really is and extract
            // out the file identifier so the file can be opened (sorry for the
            // magic numbers but they are exactly that, magic)...
            switch (EnumFrom<Version>(record.common.MajorVersion)) {
                case Version::Major2: {
                    auto &useRecord = record.v2;
                    reason = useRecord.Reason;
                    descriptor.Type = FILE_ID_TYPE::FileIdType;
                    descriptor.FileId.QuadPart = useRecord.FileReferenceNumber;
                    fileIdRaw = {
                        _reCast<uint8_t *>(&useRecord.FileReferenceNumber),
                        sizeof(useRecord.FileReferenceNumber)};
                    break;
                }
                case Version::Major3: {
                    auto &useRecord = record.v3;
                    reason = useRecord.Reason;
                    descriptor.Type = FILE_ID_TYPE::ExtendedFileIdType;
                    descriptor.ExtendedFileId = useRecord.FileReferenceNumber;
                    fileIdRaw = {
                        _reCast<uint8_t *>(&useRecord.FileReferenceNumber),
                        sizeof(useRecord.FileReferenceNumber)};
                    break;
                }
                case Version::Major4: {
                    auto &useRecord = record.v4;
                    reason = useRecord.Reason;
                    descriptor.Type = FILE_ID_TYPE::ExtendedFileIdType;
                    descriptor.ExtendedFileId = useRecord.FileReferenceNumber;
                    fileIdRaw = {
                        _reCast<uint8_t *>(&useRecord.FileReferenceNumber),
                        sizeof(useRecord.FileReferenceNumber)};
                    break;
                }
                default: {
                    ASSERT(false);
                    LOGT("Unexpected USN record type found:",
                         m_buffer->extractedCommon.MajorVersion);
                    break;
                }
            }

            // Consume the record from the source buffer
            ASSERT(m_buffer->bytesRead >= record.common.RecordLength);
            m_buffer->bytesRead -= record.common.RecordLength;

            // Point the next record to the record after this one
            m_buffer->common = _reCast<decltype(m_buffer->common)>(
                _reCast<uint8_t *>(m_buffer->common) +
                record.common.RecordLength);

            // Normalize the reason into a reason more easily interpreted
            // as a simple enum instead of a complex bitfield
            auto normalizedReason = toNormalizedReason(reason);
            if (normalizedReason == Reason::Ignored) {
                LOGTO(UsnDetails, "Ignoring record, original reason:", reason);
                continue;
            }

            DWORD access{};
            DWORD shareMode =
                FILE_SHARE_DELETE | FILE_SHARE_READ | FILE_SHARE_WRITE;
            DWORD flagsAndAttributes = FILE_FLAG_BACKUP_SEMANTICS;
            StackUtf16Arena fileNameArena;
            StackUtf16 fileName;

            // The actual name of the real file is not known; to figure out the
            // real name, open the file first then ask for the OS to give its
            // name (assuming the file is still present on the system)
            wil::unique_hfile handle{::OpenFileById(m_volume.get(), &descriptor,
                                                    access, shareMode, 0,
                                                    flagsAndAttributes)};

            // Track files that are "gone" if the caller doesn't care...
            util::Guard autoSkipped{[&]() noexcept { ++totalSkipped; }};

            auto readFileName{[&]() noexcept -> bool {
                // Read the file name on the stack unless the file name is
                // so massive that it must be read on the heap
                _forever() {
                    fileName.resize(fileName.size() + MAX_PATH);
                    auto result = GetFinalPathNameByHandleW(
                        handle.get(), fileName.data(),
                        _nc<DWORD>(fileName.size()), FILE_NAME_NORMALIZED);

                    if (result < 1) {
                        LOGT("Failed to read file name, last error:",
                             APERR(::GetLastError()),
                             "reason:", normalizedReason);
                        return false;
                    }

                    if (result > _nc<DWORD>(fileName.size())) {
                        LOGT("File name exceeds max path:", fileName.max_size(),
                             "max path:", MAX_PATHNAME,
                             "reason:", normalizedReason,
                             "original reason:", reason, "file id:", fileIdRaw);
                        continue;
                    }

                    fileName.resize(_nc<size_t>(result));
                    break;
                }
                return true;
            }};

            if (handle) {
                if (!readFileName()) continue;
            } else {
                // The file can't be opened; if the caller doesn't care then
                // skip, or if the file couldn't be opened for "other" reasons
                // aside from the file being no longer present then the file
                // is skipped
                if ((!includeFilesNoLongerPresent) ||
                    (::GetLastError() != ERROR_INVALID_PARAMETER)) {
                    LOGTO(UsnDetails, "Failed to open file by id, last error:",
                          APERR(::GetLastError()), "reason:", normalizedReason,
                          "original reason:", reason, "file id:", fileIdRaw);
                    continue;
                }
            }

            // Found a real entry that is not filtered
            autoSkipped.cancel();

            LOGTO(UsnDetails, "Found entry", fileName.data(),
                  "reason:", normalizedReason, "original reason:", reason,
                  "skipped:", totalSkipped, "file id:", fileIdRaw);
            return Entry{file::Path{fileName.data()}, normalizedReason,
                         totalSkipped, descriptor};
        }

        return NullOpt;
    }

    template <typename Buffer>
    void __toString(Buffer &buff) const noexcept {
        _tsb(buff, "Usn[", m_rootPath, "]");
    }

private:
    static Text token(const JournalToken &value) noexcept {
        return _ts(MagicToken, ":", value.journalId, ":", value.usnId);
    }

    static InputData fileDescriptorIdRawData(
        const PlatformFileIdDescriptor &id) noexcept {
        switch (id.Type) {
            case FILE_ID_TYPE::FileIdType:
                return {_reCast<const uint8_t *>(&id.FileId.QuadPart),
                        sizeof(id.FileId.QuadPart)};
            case FILE_ID_TYPE::ObjectIdType:
                return {_reCast<const uint8_t *>(&id.ObjectId),
                        sizeof(id.ObjectId)};
            case FILE_ID_TYPE::ExtendedFileIdType:
                return {_reCast<const uint8_t *>(&id.ExtendedFileId),
                        sizeof(id.ExtendedFileId)};
        }
        return {};
    }

    // Re-read the base journaling information (obtains first and last USN)
    Error refresh() noexcept {
        util::Guard autoClose{[&]() noexcept { close(); }};

        DWORD dwBytes{};
        USN_JOURNAL_DATA newJournalData{};

        if (!::DeviceIoControl(m_volume.get(), FSCTL_QUERY_USN_JOURNAL, NULL, 0,
                               &newJournalData, sizeof(newJournalData),
                               &dwBytes, NULL))
            return APERRT(::GetLastError(), "Failed to query journaling data",
                          m_rootPath);

        m_journalData = newJournalData;
        autoClose.cancel();

        if (!m_token) {
            // By default, always seek to the first record if no token present
            m_token.emplace();
            m_token->journalId = m_journalData.UsnJournalID;
            m_token->usnId = m_journalData.FirstUsn;
        }

        LOGT("Found journal, journal id:", newJournalData.UsnJournalID);
        return {};
    }

    Error primeBuffer(bool forceBufferReset = false) noexcept {
        if (forceBufferReset) m_buffer.reset();

        // Already primed? Don't prime a second time...
        if (m_buffer) return {};

        ASSERT(m_token);

        util::Guard autoClose{[&]() noexcept { close(); }};

        m_buffer.emplace();

        // Prepare the buffer to read from the token point forward
        m_buffer->readData.UsnJournalID = m_token->journalId;
        m_buffer->readData.StartUsn = m_token->usnId;

        if (!::DeviceIoControl(
                m_volume.get(), FSCTL_READ_USN_JOURNAL, &(m_buffer->readData),
                sizeof(m_buffer->readData), m_buffer->rawData.data(),
                _nc<DWORD>(m_buffer->rawData.max_size() *
                           sizeof(decltype(m_buffer->rawData)::value_type)),
                &(m_buffer->bytesRead), NULL))
            return APERRT(::GetLastError(),
                          "Failed to obtain journaling entries", m_rootPath);

        autoClose.cancel();

        if (m_buffer->bytesRead >= sizeof(UsnType)) {
            // Grab a pointer to the "next" USN from the buffer
            auto nextUsn = _reCast<UsnType *>(m_buffer->rawData.data());

            // Extract the next USN into our current token
            memcpy(&(m_token->usnId), nextUsn, sizeof(m_token->usnId));
            m_buffer->bytesRead -= sizeof(UsnType);

            // Windows will continue to return the "next" USN forever without
            // any data so this checks if reading the buffer is done or not
            if (m_buffer->bytesRead >= sizeof(USN_RECORD_COMMON_HEADER)) {
                LOGTO(UsnDetails,
                      "Found at least one record to consume, bytes read",
                      m_buffer->bytesRead);
                m_buffer->common = _reCast<USN_RECORD_COMMON_HEADER *>(
                    &(m_buffer->rawData.data()[sizeof(UsnType)]));
                return primeNextResult();
            }
            LOGT("Records exhausted");
        }

        // USN data is now empty
        m_buffer->common = {};
        m_buffer->bytesRead = {};

        LOGT("Journal exhausted");
        return {};
    }

    Error primeNextResult() noexcept {
        if (!m_buffer) return primeBuffer();

        // If the buffer has no more content to consume, reset the buffer to
        // cause the next USN buffer to be read
        if (m_buffer->bytesRead < sizeof(USN_RECORD_COMMON_HEADER)) {
            LOGT("Records exhausted, next USN:", m_token->usnId,
                 "bytes read:", m_buffer->bytesRead);
            return primeBuffer(true);
        }

        // Extract out of the buffer into the common header
        memcpy(&(m_buffer->extractedCommon), m_buffer->common,
               sizeof(m_buffer->extractedCommon));

        // Ensure the buffer actually contains the expected content amount
        if (m_buffer->bytesRead < m_buffer->extractedCommon.RecordLength) {
            auto ccode =
                APERRT(Ec::ResultBufferTooSmall,
                       "Buffer not as large as common header indicates should "
                       "be available:",
                       m_buffer->bytesRead,
                       "expecting:", m_buffer->extractedCommon.RecordLength);
            close();
            return ccode;
        }

        // Next chunk of data is now primed and ready to consume...
        LOGTO(UsnDetails, "Records ready, path:", m_rootPath,
              "next USN:", m_token->usnId, "bytes read:", m_buffer->bytesRead);
        return {};
    }

    void close() noexcept {
        if (m_volume) {
            m_volume.reset();
            LOGT("Journal closed");
        }
    }

    // Search the lookup table to map a windows reason the "best" fitting
    // normalized reason
    static Reason toNormalizedReason(ReasonType reason) noexcept {
        auto normalizedReason = Reason::Ignored;
        for (auto [foundReason, foundNormalizedReason] :
             WindowsToNormalizedReasonLut) {
            if ((foundReason & reason) == 0) continue;
            if (foundNormalizedReason > normalizedReason) continue;
            normalizedReason = foundNormalizedReason;
        }
        return normalizedReason;
    }

private:
    // https://docs.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/d643cdfa-5f4f-4737-a905-4098d4577593
    enum class Version : VersionType { Major2 = 2, Major3 = 3, Major4 = 4 };

    // If the token generation's algorithm need to change in the future,
    // this magic value must change to ensure that old tokens no longer
    // supported are discarded
    _const UsnType MagicToken = 0xBEEF;

    // Scan the lookup table to create a filter bitfield that Windows
    // can use to ignore changes a consumer would never care about
    _const ReasonType FilterReasons = UsnWalkerTypes::makeReasonFilter();

    wil::unique_hfile m_volume;
    file::Path m_rootPath;
    USN_JOURNAL_DATA m_journalData{};

    // A token to always point to the next USN data to read (if present)
    struct JournalToken {
        JournalIdType journalId{};
        UsnType usnId{};
    };
    Opt<JournalToken> m_token{};

    // A buffer to consume to read the USN records (if available)
    struct ParseBuffer {
        READ_USN_JOURNAL_DATA readData{};
        RawBufferArray rawData{};
        DWORD bytesRead{};
        USN_RECORD_COMMON_HEADER extractedCommon{};
        USN_RECORD_COMMON_HEADER *common{};

        ParseBuffer() noexcept {
            // magic numbers refering to USN_RECORD_V2 to USN_RECORD_V4
            readData.MinMajorVersion = EnumIndex(Version::Major2);
            readData.MaxMajorVersion = EnumIndex(Version::Major4);
            readData.ReasonMask = 0xFFFFFFFF ^ FilterReasons;
        }
    };
    Opt<ParseBuffer> m_buffer;
};

}  // namespace ap::plat
