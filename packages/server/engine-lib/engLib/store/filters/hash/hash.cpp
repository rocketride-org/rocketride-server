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
//	Hash filter
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::hash {
//-------------------------------------------------------------------------
/// @details
/// 	Clears the previous hash if set.
///	@param[in]	object
///		The object information about the object being opened
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::open(Entry &object) noexcept {
    LOGPIPE();

    // Say we are not finalized - it's not ready yet
    m_isFinalized = false;

    // Create a new hashing context
    m_context = ap::crypto::Sha512();
    return Parent::open(object);
}

//-------------------------------------------------------------------------
/// @details
/// 	Gets the previous computed hash by using IOCTRL structure pointer.
///	@param[in]	pCommand
///		The returned structure with a computed hash.
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::ioControl(IOCTRL *pCommand) noexcept {
    LOGPIPE();

    // return if Signing is off
    if (!(currentEntry->flags() & Entry::FLAGS::SIGNING)) return {};

    // Based on the request being issued
    switch (pCommand->ioctrl) {
        case IOCTRL_ID::HASH: {
            if (!m_isFinalized)
                return APERR(Ec::InvalidCommand,
                             "The hash has not yet been finalized");

            // This is for us, return the hash
            auto ioctrlHash = _cast<IOCTRL_HASH *>(pCommand);
            ioctrlHash->m_hash = _ts(m_hash);
            return {};
        }

        default:
            // Nope, send it on down
            return Parent::ioControl(pCommand);
    }
}

//-------------------------------------------------------------------------
/// @details
/// 	Compares the current hash with the hash in the tag.
///     Returns error if they are different.
///	@param[in]	pTag
///		The tag the hash of which should be compared.
///	@returns
///		Error if different hashes
//-------------------------------------------------------------------------
Error IFilterInstance::isEqualTagHash(const TAG_HASH *pTag) noexcept {
    if (!m_isFinalized)
        return APERR(Ec::InvalidCommand, "The hash has not yet been finalized");

    bool same = std::memcmp(pTag->data.data, _cast<uint8_t *>(m_hash),
                            m_hash.DigestLen) == 0;
    if (!same) return APERR(Ec::Bug, "Hash is different to the provided one.");
    return {};
}

//-------------------------------------------------------------------------
/// @details
/// 	Write out the saved hash as a TAG_HASH.
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::writeHashTag() noexcept {
    if (!m_isFinalized)
        return APERR(Ec::InvalidCommand, "The hash has not yet been finalized");

    // Get the internal tag buffer
    TAG *pTagBuffer;
    if (auto ccode = getTagBuffer(&pTagBuffer)) return ccode;

    // Build the hash tag
    auto pHashTag = TAG_HASH::build(pTagBuffer);

    std::memcpy(pHashTag->data.data, _cast<uint8_t *>(m_hash),
                m_hash.DigestLen);
    pHashTag->setHashSize(_cast<Dword>(m_hash.DigestLen));
    if (auto ccode = Parent::writeTag(pHashTag)) return ccode;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///     Computes the hash of the data tag
///	@param[in]	pData
///		The tag from which the hash should be computed
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::computeHash(
    const TAG_OBJECT_STREAM_DATA *pData) noexcept {
    // Update the hash
    m_context.update(InputData{(Byte *)pData->data.data, pData->size});
    return {};
}

//-------------------------------------------------------------------------
/// @details
/// 	Hash input tag with data and write into a new tag
///	@param[in]	pTag
///		The tag to write
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterInstance::writeTag(const TAG *pTag) noexcept {
    LOGPIPE();

    // return if Signing is off
    if (!(currentEntry->flags() & Entry::FLAGS::SIGNING)) return {};

    Error ccode;
    // Based on the tag type...
    switch (pTag->tagId) {
        case TAG_HASH::ID: {
            // We received the hash from the source, just make sure
            // it matches what we computed. We do not want to send
            // it down again since we will write what we computed
            // out during the close method, which would result in
            // a double hash tag being written
            return isEqualTagHash(_cast<const TAG_HASH *>(pTag));
        }

        case TAG_OBJECT_END::ID: {
            // Make sure we have not received duplicate object ends
            if (m_isFinalized)
                return APERR(Ec::InvalidCommand, "Hash is already finalized");

            // We need to write this first, so that the hash is the LAST
            // thing we write. If we wrote the hash tag first, then the
            // above line would not have a finalized hash yet
            if (ccode = Parent::writeTag(pTag)) return ccode;

            // Finalize the hash
            m_hash = m_context.finalize();
            m_isFinalized = true;

            // Save the hash
            currentEntry->componentId(m_hash);

            // Write the hash out as the final tag
            LOGT("Hashed with tag: {}", m_hash);
            return writeHashTag();
        }

        case TAG_OBJECT_STREAM_DATA::ID: {
            // If tag is not instance data, rather global data, update
            // the hash
            if (!(pTag->attributes & TAG_ATTRIBUTES::INSTANCE_DATA)) {
                const auto pData = (TAG_OBJECT_STREAM_DATA *)pTag;
                if (ccode = computeHash(pData)) return ccode;
            }

            // Write the tag
            return Parent::writeTag(pTag);
        }

        default: {
            // Write the tag
            return Parent::writeTag(pTag);
        }
    }
}

}  // namespace engine::store::filter::hash
