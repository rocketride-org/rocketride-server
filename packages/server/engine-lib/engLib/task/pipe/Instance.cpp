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

namespace engine::task::instance {

//-----------------------------------------------------------------
/// @details
///		Setup the operation
//-----------------------------------------------------------------
Error Task::beginTask() noexcept {
    // Get an endpoint
    if (!(m_sourceEndpoint = IServiceEndpoint::getSourceEndpoint(
              {.jobConfig = jobConfig(),
               .taskConfig = taskConfig(),
               .serviceConfig = taskConfig()["service"],
               .openMode = OPEN_MODE::SOURCE})))
        return m_sourceEndpoint.ccode();

    // Get an endpoint
    if (!(m_targetEndpoint = IServiceEndpoint::getTargetEndpoint(
              {.jobConfig = jobConfig(),
               .taskConfig = taskConfig(),
               .openMode = OPEN_MODE::INSTANCE})))
        return m_targetEndpoint.ccode();

    // And do the parent setup
    return Parent::beginTask();
}

//-----------------------------------------------------------------
///	@details
///		Calls the default line processing to create an entry
///		and queue it up
/// @param[in] line
///		The incoming line - json format
/// @param[in] parent
///		The current parent
//-----------------------------------------------------------------
ErrorOr<Entry> Task::processLine(TextView line, const Url &parent) noexcept {
    // Process for I*{...} lines
    return Parent::processLine("I"_tv, line, parent);
}

//-----------------------------------------------------------------
/// @details
///		Process the enry
/// @param[in] entry
///		The entry to copy
//-----------------------------------------------------------------
Error Task::processItem(Entry &entry) noexcept {
    // Allocate/release the source pipe
    ErrorOr<ServicePipe> sourcePipe;
    util::Guard pipes{[&] { sourcePipe = m_sourceEndpoint->getPipe(); },
                      [&] {
                          if (sourcePipe)
                              m_sourceEndpoint->putPipe(*sourcePipe);
                      }};

    // Clears all the instance fields in an entry that are set by hash
    const auto clearEntrySigned = localfcn() {
        // If the entry is changed on disk, reset the component id
        entry.componentId.reset();
    };

    // Clears all the instance fields in an entry that are set by indexing
    const auto clearEntryIndex = localfcn() {
        // All this stuff is filled in by processing the item, so
        // clear out the old values
        entry.metadata.reset();
        entry.docCreator.reset();
        entry.docModifier.reset();
        entry.docCreateTime.reset();
        entry.docModifyTime.reset();
        entry.classificationId.reset();
    };

    // Clears all the instance fields in an entry that are set by vectorizing
    const auto clearEntryVector = localfcn() {
        // All this stuff is filled in by processing the item, so
        // clear out the old values
        entry.vectorBatchId.reset();
    };

    // Get a source pipe
    if (!sourcePipe) return sourcePipe.ccode();

    auto prevAccessTime = entry.accessTime;
    // Check the object for a change
    Error objcode;

    if (!m_sourceEndpoint->isSyncEndpoint())
        objcode = sourcePipe->checkChanged(entry);

    if (objcode) {
        // This is a failure for the object
        entry.completionCode(objcode);
    } else {
        bool processIt = false;

        // If the object is changed, we need to process it
        if (entry.changed()) {
            // Clear these so we force the whole thing
            clearEntrySigned();
            clearEntryIndex();
            clearEntryVector();

            // We need to process it because it is changed
            processIt = true;
        }

        // Determine if we need to If process it due to signing
        if (entry.flags() & Entry::FLAGS::SIGNING) {
            // If we do not have a component id, we need to process it
            if (!entry.componentId()) processIt = true;
        } else {
            // We don't need signing information, so make sure it is clear
            clearEntrySigned();
        }

        // Determine if we need to process it due to needing indexing
        if (entry.flags() & Entry::FLAGS::INDEX) {
            // If we do not have a word batch id, we need to process it
            if (!entry.wordBatchId()) processIt = true;
        } else {
            // We don't need index information, so make sure it is clear
            clearEntryIndex();
        }

        if (entry.flags() & Entry::FLAGS::VECTORIZE) {
            // If we do not have a vector batch id, we need to process it
            if (!entry.vectorBatchId()) processIt = true;
        } else {
            // We don't need vector information, so make sure it is clear
            clearEntryVector();
        }

        // If we need OCR done, and it wasn't done on the last pass
        if (entry.flags() & Entry::FLAGS::OCR) {
            // Was OCR done or not?
            if (!(entry.flags() & Entry::FLAGS::OCR_DONE)) {
                // We want to clear this to force a reindex and revectorize. The
                // OCR may come up with additional text that needs to be
                // ingested not only into the wordDB but also the vectorDB
                clearEntryIndex();
                clearEntryVector();

                // Now, set it to process
                processIt = true;
            }
        } else {
            // OCR is off, but if we did OCR before, turn it off (requires
            // reprocessing)
            if (entry.flags() & Entry::FLAGS::OCR_DONE) {
                // We want to clear this to force a reindex and revectorize. OCR
                // may have come up with additional text which need to be
                // removed
                clearEntryIndex();
                clearEntryVector();

                // Now, set it to process
                processIt = true;
            }
        }

        // If we need to process it, do so
        if (processIt) {
            // Process this item
            if (auto ccode = Parent::processItem(entry, *sourcePipe))
                return ccode;

            // Say the entry was changed
            entry.changed(true);
        }

        // Need to check this iFlags to restore already scanned and deleted
        // files (entry was first included, then excluded and now included
        // back), otherwise they will be marked as "deleted" in DB forever
        if (entry.iflags() & Entry::IFLAGS::DELETED) {
            // does not make any sence but nice to have -> App controls that
            // iFlags anyway
            entry.iflags(entry.iflags() & ~Entry::IFLAGS::DELETED);

            // Mark entry changed to write the result
            entry.changed(true);
        }
    }

    // The rendering of stub objects for repeating symlinks is skipped.
    // However, we must output such objects to import them into the database.
    if (entry.objectSkipped()) entry.completionCode({});

    // If we failed or not...
    if (entry.objectFailed()) {
        // Add it to the failed
        MONITOR(addFailed, 1, entry.size());

        // Write the error
        if (auto ccode = Parent::writeError(entry, entry.completionCode()))
            return ccode;
    } else {
        // Add it to the completed
        MONITOR(addCompleted, 1, entry.size());

        // Set changed to true if accessTime was updated
        if (!entry.changed() && (prevAccessTime() != entry.accessTime()))
            entry.changed(true);

        // If the entry is changed, write it to the output pipe
        if (entry.changed()) {
            // Write the result
            if (auto ccode = Parent::writeResult('I', entry)) return ccode;
        }
    }

    // And done
    return {};
}
}  // namespace engine::task::instance
