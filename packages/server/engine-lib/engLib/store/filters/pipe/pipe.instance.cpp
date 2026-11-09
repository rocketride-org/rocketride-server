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

namespace engine::store::filter::pipe {
IFilterInstance::IFilterInstance(const FactoryArgs &args) noexcept
    : Parent(args),
      global(std::dynamic_pointer_cast<IFilterGlobal>(Parent::global)) {}

IFilterInstance::~IFilterInstance() noexcept {}

//-------------------------------------------------------------------------
/// @details
///		Emit one `>DBG` trace line for the current binding of this pipe.
///		Gated on the BINDING's trace level, so a NONE binding sharing the
///		engine with a FULL one emits nothing.
//-------------------------------------------------------------------------
void IFilterInstance::emitTrace(TextView kind, TextView componentId,
                                const json::Value &trace) noexcept {
    if (traceLevel < PIPELINE_TRACE_LEVEL::METADATA) return;
    if (!::engine::config::monitor()->isAppMonitor()) return;

    // A null payload renders as an empty object so the parser always
    // sees json
    Text payload = trace.isNull() ? Text("{}") : trace.stringify();

    // Format it - ints render as hex, fields are '*'-separated
    StackText msg;
    _tsbo(msg, {Format::HEX, {}, '*'}, kind, this->pipeId,
          this->endpoint->getPipeCount(), componentId, this->bindingId,
          this->rootBindingId, payload);

    ::engine::config::monitor()->other("DBG", msg);
}

//-------------------------------------------------------------------------
/// @details
///		Emit a trace line for a filter instance, named by its component id
//-------------------------------------------------------------------------
void IFilterInstance::emitTrace(TextView kind, IServiceFilterInstance *pInstance,
                                const json::Value &trace) noexcept {
    emitTrace(kind, pInstance->pipeType.id, trace);
}

//-------------------------------------------------------------------------
/// @details
///		This will track when an object is opened. It becomes available
///		via the entry member
///	@param[in]	entry
///		Reference to the object to open
//-------------------------------------------------------------------------
Error IFilterInstance::open(Entry &entry) noexcept {
    // Output
    LOGPIPE(entry.url());

    // If we already have an object open, error
    if (currentEntry)
        return APERR(Ec::InvalidCommand, "Object is already open on pipe",
                     pipeId);

    // Trace the object begin for this binding
    emitTrace("BEGIN", entry.url().fileName(), json::Value());

    if (m_openMode == OPEN_MODE::PIPELINE) {
        // Get our pipe id and call it
        if (auto ccode = global->beginObjectMetrics(pipeId, entry))
            return ccode;
    }

    // Call down, if it fails, clear it.
    if (auto ccode = Parent::open(entry)) return ccode;

    // Done - success
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		This function close the object if it is open.
//-------------------------------------------------------------------------
Error IFilterInstance::close() noexcept {
    // If we do not have an object open, error
    if (!currentEntry) return {};

    // Output
    LOGPIPE(currentEntry->url());

    // Get the name of the entry before it disappears
    auto name = currentEntry->url().fileName();

    // Call down
    Error ccode;

    // Closing the object
    ccode = Parent::closing();

    Entry *object = currentEntry;

    // Close the object
    ccode = Parent::close() || ccode;

    if (m_openMode == OPEN_MODE::PIPELINE) {
        // Get our pipe id and call it
        ccode = global->endObjectMetrics(pipeId, *object) || ccode;
    }

    // Trace the object end for this binding - the response rides along
    // from SUMMARY up
    json::Value trace;
    if (traceLevel >= PIPELINE_TRACE_LEVEL::SUMMARY && object->response)
        trace = object->response();
    emitTrace("END", name, trace);

    return ccode;
}
}  // namespace engine::store::filter::pipe
