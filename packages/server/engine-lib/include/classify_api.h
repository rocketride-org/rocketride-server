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

/**
 * @file classify_api.h
 * @brief Classification Engine C ABI Interface
 *
 * This header defines the stable C ABI between the server and classification DLL.
 * It is shared between:
 *   - packages/server/engine-lib/ (consumer)
 *   - engine-ads/packages/classify/ (provider, separate repo)
 *
 * Thread Safety:
 *   - ClassifyEngine: Single instance, initialize once from main thread
 *   - ClassifySession: One per thread, fully independent
 *   - All session functions are thread-safe when using separate sessions
 */

#ifndef CLASSIFY_API_H
#define CLASSIFY_API_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// =============================================================================
// Version and Constants
// =============================================================================

#define CLASSIFY_API_VERSION        5
#define CLASSIFY_API_EXPORT_NAME    "classify_get_api"

// =============================================================================
// Platform Macros
// =============================================================================

#ifdef _WIN32
    #ifdef CLASSIFY_DLL_EXPORT
        #define CLASSIFY_API __declspec(dllexport)
    #else
        #define CLASSIFY_API __declspec(dllimport)
    #endif
    #define CLASSIFY_CALL __cdecl
#else
    #ifdef CLASSIFY_DLL_EXPORT
        #define CLASSIFY_API __attribute__((visibility("default")))
    #else
        #define CLASSIFY_API
    #endif
    #define CLASSIFY_CALL
#endif

// =============================================================================
// Error Codes
// =============================================================================

typedef enum ClassifyResult {
    CLASSIFY_OK                     = 0,

    // Initialization errors
    CLASSIFY_ERR_NOT_INITIALIZED    = -1,
    CLASSIFY_ERR_ALREADY_INIT       = -2,
    CLASSIFY_ERR_INIT_FAILED        = -3,
    CLASSIFY_ERR_LICENSE            = -4,
    CLASSIFY_ERR_DLL_LOAD           = -5,

    // Parameter errors
    CLASSIFY_ERR_INVALID_PARAM      = -10,
    CLASSIFY_ERR_INVALID_CONFIG     = -11,
    CLASSIFY_ERR_INVALID_SESSION    = -12,

    // Runtime errors
    CLASSIFY_ERR_BUFFER_TOO_SMALL   = -20,
    CLASSIFY_ERR_INVALID_CONTENT    = -21,
    CLASSIFY_ERR_EVALUATION_FAILED  = -22,
    CLASSIFY_ERR_NO_DOCUMENT        = -23,

    // System errors
    CLASSIFY_ERR_OUT_OF_MEMORY      = -30,
    CLASSIFY_ERR_INTERNAL           = -99
} ClassifyResult;

// =============================================================================
// Opaque Handle Types
// =============================================================================

/**
 * @brief Opaque handle to classification engine (one per process)
 * @note NOT thread-safe during creation/destruction - call from single thread
 */
typedef struct ClassifyEngine* ClassifyEngineHandle;

/**
 * @brief Opaque handle to classification session (one per document/thread)
 * @note Thread-safe - each thread should have its own session
 */
typedef struct ClassifySession* ClassifySessionHandle;

// =============================================================================
// Logging
// =============================================================================

/**
 * @brief Logging callback function type
 * 
 * The host application provides this callback to receive log messages from the DLL.
 * The DLL uses ap::Lvl values for log levels (cast to int for C ABI compatibility).
 * 
 * @param level     Log level (ap::Lvl cast to int, e.g. Lvl::Classify, Lvl::Always)
 * @param message   Log message (UTF-8, null-terminated)
 * @param file      Source file name (may be NULL)
 * @param line      Source line number (0 if unknown)
 * @param func      Function name (may be NULL)
 * @param user_data User data pointer passed to set_logger
 * 
 * @note This callback may be called from multiple threads concurrently.
 * @note The callback should be thread-safe and return quickly.
 */
typedef void (CLASSIFY_CALL *ClassifyLogCallbackFn)(
    int                 level,
    const char*         message,
    const char*         file,
    int                 line,
    const char*         func,
    void*               user_data
);

// =============================================================================
// Configuration Flags
// =============================================================================

typedef enum ClassifyFlags {
    CLASSIFY_FLAG_NONE              = 0,
    CLASSIFY_FLAG_WANT_CONTEXT      = (1 << 0),  /**< Return surrounding text with matches */
    CLASSIFY_FLAG_WANT_TEXT         = (1 << 1),  /**< Return full marked-up document text */
    CLASSIFY_FLAG_WANT_POLICIES     = (1 << 2),  /**< Return policy metadata */
    CLASSIFY_FLAG_PIPELINE_MODE     = (1 << 3),  /**< Running in pipeline mode */
} ClassifyFlags;

// =============================================================================
// API Function Types
// =============================================================================

/**
 * @brief Create and initialize classification engine
 *
 * @param[in]  config_json   JSON configuration string (UTF-8, null-terminated)
 * @param[in]  flags         Combination of ClassifyFlags
 * @param[in]  exec_dir      Host application's execution directory (UTF-8, null-terminated)
 *                           Used to locate classify DLL and resources. Required.
 * @param[in]  cache_path    Path for temporary/cache files (UTF-8, null-terminated)
 *                           Used for overflow buffers when processing large documents. Required.
 * @param[out] out_engine    Receives engine handle on success
 * @return CLASSIFY_OK on success, error code otherwise
 *
 * @note Call once per process. NOT thread-safe during initialization.
 * @note On error, call get_last_error() for detailed message.
 */
typedef ClassifyResult (CLASSIFY_CALL *ClassifyEngineCreateFn)(
    const char*             config_json,
    uint32_t                flags,
    const char*             exec_dir,
    const char*             cache_path,
    ClassifyEngineHandle*   out_engine
);

/**
 * @brief Destroy classification engine and release resources
 *
 * @param[in] engine    Engine handle from engine_create
 * @return CLASSIFY_OK on success
 *
 * @note All sessions must be destroyed before calling this.
 */
typedef ClassifyResult (CLASSIFY_CALL *ClassifyEngineDestroyFn)(
    ClassifyEngineHandle    engine
);

/**
 * @brief Create a new classification session
 *
 * @param[in]  engine       Engine handle
 * @param[out] out_session  Receives session handle on success
 * @return CLASSIFY_OK on success
 *
 * @note Thread-safe. Each thread should create its own session.
 */
typedef ClassifyResult (CLASSIFY_CALL *ClassifySessionCreateFn)(
    ClassifyEngineHandle    engine,
    ClassifySessionHandle*  out_session
);

/**
 * @brief Destroy a classification session
 *
 * @param[in] session   Session handle
 * @return CLASSIFY_OK on success
 */
typedef ClassifyResult (CLASSIFY_CALL *ClassifySessionDestroyFn)(
    ClassifySessionHandle   session
);

/**
 * @brief Begin classification of a new document
 *
 * @param[in] session       Session handle
 * @param[in] metadata_json Optional document metadata (UTF-8 JSON, may be NULL)
 * @return CLASSIFY_OK on success
 *
 * @note Must call before push_data. Resets any previous document state.
 */
typedef ClassifyResult (CLASSIFY_CALL *ClassifySessionBeginFn)(
    ClassifySessionHandle   session,
    const char*             metadata_json
);

/**
 * @brief Push text data for classification
 *
 * @param[in] session       Session handle
 * @param[in] text_utf8     UTF-8 encoded text (null-terminated)
 * @param[in] text_len      Length in bytes (excluding null terminator)
 * @return CLASSIFY_OK on success
 *
 * @note Can be called multiple times to stream document content.
 * @note Text should be NFKC normalized by caller for best results.
 */
typedef ClassifyResult (CLASSIFY_CALL *ClassifySessionPushDataFn)(
    ClassifySessionHandle   session,
    const char*             text_utf8,
    size_t                  text_len
);

/**
 * @brief Evaluate accumulated text and get classification results
 *
 * @param[in]     session     Session handle
 * @param[out]    result_json Buffer to receive JSON results (UTF-8)
 * @param[in,out] result_len  In: buffer size, Out: actual/required size
 * @return CLASSIFY_OK on success
 *         CLASSIFY_ERR_BUFFER_TOO_SMALL if buffer too small (result_len updated)
 *
 * @note If buffer too small, resize to *result_len and retry.
 */
typedef ClassifyResult (CLASSIFY_CALL *ClassifySessionEvaluateFn)(
    ClassifySessionHandle   session,
    char*                   result_json,
    size_t*                 result_len
);

/**
 * @brief End classification of current document
 *
 * @param[in] session   Session handle
 * @return CLASSIFY_OK on success
 *
 * @note Session can be reused for next document after this call.
 */
typedef ClassifyResult (CLASSIFY_CALL *ClassifySessionEndFn)(
    ClassifySessionHandle   session
);

/**
 * @brief Get loaded policies as JSON
 *
 * @param[in]     engine      Engine handle
 * @param[out]    json_buf    Buffer to receive JSON
 * @param[in,out] json_len    In: buffer size, Out: actual/required size
 * @return CLASSIFY_OK on success, CLASSIFY_ERR_BUFFER_TOO_SMALL if too small
 */
typedef ClassifyResult (CLASSIFY_CALL *ClassifyGetPoliciesFn)(
    ClassifyEngineHandle    engine,
    char*                   json_buf,
    size_t*                 json_len
);

/**
 * @brief Get loaded rules as JSON
 */
typedef ClassifyResult (CLASSIFY_CALL *ClassifyGetRulesFn)(
    ClassifyEngineHandle    engine,
    char*                   json_buf,
    size_t*                 json_len
);

/**
 * @brief Validate a PCRE regex pattern
 *
 * @param[in]     engine      Engine handle
 * @param[in]     regex_utf8  Regex pattern (UTF-8, null-terminated)
 * @return CLASSIFY_OK if valid, CLASSIFY_ERR_INVALID_PARAM if invalid
 *
 * @note On error, call get_last_error() to retrieve the validation error message.
 */
typedef ClassifyResult (CLASSIFY_CALL *ClassifyValidateRegexFn)(
    ClassifyEngineHandle    engine,
    const char*             regex_utf8
);

/**
 * @brief Get last error message for current thread
 *
 * @return NULL if no error, or pointer to error message (UTF-8, null-terminated)
 *
 * @note Thread-local - returns error from last failed call on this thread.
 * @note The returned pointer is valid until the next operation on this thread.
 * @note Use session_get_last_error for session-level errors (preferred).
 */
typedef const char* (CLASSIFY_CALL *ClassifyGetLastErrorFn)(void);

/**
 * @brief Get last error message for a session
 *
 * @param[in] session   Session handle
 * @return NULL if no error, or pointer to error message (UTF-8, null-terminated)
 *
 * @note The returned pointer is valid until the next session operation.
 * @note Session-level error - more reliable than thread-local in complex threading scenarios.
 */
typedef const char* (CLASSIFY_CALL *ClassifySessionGetLastErrorFn)(
    ClassifySessionHandle   session
);

/**
 * @brief Check if engine wants context returned with matches
 *
 * @param[in] engine    Engine handle
 * @return 1 if context requested, 0 otherwise
 */
typedef int (CLASSIFY_CALL *ClassifyWantsContextFn)(
    ClassifyEngineHandle    engine
);

/**
 * @brief Set the logging callback for the DLL
 *
 * @param[in] callback    Logging callback function (may be NULL to disable)
 * @param[in] user_data   User data passed to callback
 * @return CLASSIFY_OK (always succeeds)
 *
 * @note Should be called before engine_create for full logging coverage.
 * @note The callback is stored globally and used for all subsequent log calls.
 * @note Pass NULL callback to disable logging (default state).
 * @note Log filtering should be done in the callback based on level.
 */
typedef ClassifyResult (CLASSIFY_CALL *ClassifySetLoggerFn)(
    ClassifyLogCallbackFn   callback,
    void*                   user_data
);

// =============================================================================
// API Table Structure
// =============================================================================

/**
 * @brief API function table returned by classify_get_api()
 *
 * All function pointers must be non-null for a valid API.
 * Version must match CLASSIFY_API_VERSION.
 */
typedef struct ClassifyApi {
    uint32_t                    version;            /**< Must be CLASSIFY_API_VERSION */
    uint32_t                    struct_size;        /**< sizeof(ClassifyApi) */

    // Engine lifecycle
    ClassifyEngineCreateFn      engine_create;
    ClassifyEngineDestroyFn     engine_destroy;

    // Session lifecycle
    ClassifySessionCreateFn     session_create;
    ClassifySessionDestroyFn    session_destroy;

    // Document processing
    ClassifySessionBeginFn      session_begin;
    ClassifySessionPushDataFn   session_push_data;
    ClassifySessionEvaluateFn   session_evaluate;
    ClassifySessionEndFn        session_end;

    // Queries
    ClassifyGetPoliciesFn       get_policies;
    ClassifyGetRulesFn          get_rules;
    ClassifyValidateRegexFn     validate_regex;
    ClassifyWantsContextFn      wants_context;

    // Error handling
    ClassifyGetLastErrorFn      get_last_error;             /**< Thread-local error (deprecated) */
    ClassifySessionGetLastErrorFn session_get_last_error;   /**< Session-level error (preferred) */

    // Logging
    ClassifySetLoggerFn         set_logger;         /**< Set logging callback (call before engine_create) */

} ClassifyApi;

// =============================================================================
// API Entry Point
// =============================================================================

/**
 * @brief Get the API function table
 *
 * @return Pointer to static API table (valid for lifetime of DLL)
 *
 * This is the ONLY exported function from the DLL.
 */
typedef const ClassifyApi* (CLASSIFY_CALL *ClassifyGetApiFn)(void);

// Actual export declaration
CLASSIFY_API const ClassifyApi* CLASSIFY_CALL classify_get_api(void);

#ifdef __cplusplus
}
#endif

#endif // CLASSIFY_API_H
