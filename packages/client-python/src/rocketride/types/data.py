# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Data Processing Result Types for RocketRide Pipelines.

This module defines response structures returned from RocketRide pipeline data processing operations.
The types represent different response formats depending on the processing method, MIME type handling,
and pipeline configuration. Understanding these types is crucial for properly handling pipeline results.

Types Defined:
    PIPELINE_RESULT: Base response structure from all pipeline operations
    UPLOAD_RESULT: Complete file upload result with processing outcome

Response Structure Patterns:
    All pipeline operations return structured responses that include:
    - Basic identification (name, path, objectId)
    - Optional result_types dictionary that maps field names to data types
    - Dynamic fields whose names and types are defined by result_types

Dynamic Field Access Pattern:
    Pipeline results use a dynamic field pattern where the result_types dictionary
    defines what fields are available and their types. This allows pipelines to
    return arbitrary data structures based on configuration:

    result_types = {"text": "text", "answers": "answers", "metadata": "json"}
    result["text"]      # Contains List[str] - text content
    result["answers"]   # Contains List[str] - AI responses
    result["metadata"]  # Contains dict - JSON metadata

Usage:
    from rocketride.types import PIPELINE_RESULT, UPLOAD_RESULT

    # Handle pipeline result with dynamic fields
    result: PIPELINE_RESULT = await client.send(token, data, mime='text/plain')

    if result.get('result_types'):
        # Examine what fields are available
        for field_name, field_type in result['result_types'].items():
            field_data = result.get(field_name)
            if field_data:
                print(f"{field_name} ({field_type}): {field_data}")

    # Handle file upload results
    uploads: List[UPLOAD_RESULT] = await client.send_files(files, token)
    for upload in uploads:
        if upload['action'] == 'complete':
            processing_result = upload.get('result')
            # Process the result...
"""

from typing import TypedDict, Literal, Dict, Optional


class PIPELINE_RESULT(TypedDict, total=False):
    """
    Pipeline response structure with optional processing information.

    This is returned from all pipeline operations. When data is sent without
    MIME type specification, only basic fields are present. When MIME type
    is specified and processing occurs, additional result_types and dynamic
    fields are included.

    Processing Detection:
    - result_types present: Pipeline performed content extraction/processing
    - result_types absent: Basic response without content processing

    Dynamic Field Access:
    The result_types dictionary maps field names to data types. For each
    entry in result_types, a corresponding field exists in the response:

    Examples:
    - {"text": "text"} → response["text"] contains List[str]
    - {"my_text": "text", "my_answers": "answers"} → response["my_text"] and response["my_answers"]
    - {"answers": "answers"} → response["answers"] contains AI-generated chat responses
    - {"output": "text", "metadata": "json"} → multiple typed fields available

    Field Type Mappings:
    - "text": List[str] (array of text segments)
    - "answers": List[str] (AI-generated chat responses)
    - Other types: depends on pipeline configuration

    Usage Example:
    -------------
    result = await client.send(token, data, {}, 'text/plain')

    if result.get('result_types'):
        # Processing occurred - check available fields
        for field_name, field_type in result['result_types'].items():
            field_data = result.get(field_name)
            if field_type == 'text' and field_data:
                print(f"Text content: {field_data}")
            elif field_type == 'answers' and field_data:
                print(f"AI responses: {field_data}")
    else:
        # Basic response without processing
        print(f"Processed item: {result['name']}")
    """

    name: str  # REQUIRED - Unique identifier for this processing result (UUID format)
    path: str  # REQUIRED - File path context (typically empty for direct data sends)
    objectId: str  # REQUIRED - Unique object identifier for tracking processed items (UUID format)

    result_types: Optional[Dict[str, str]]  # Map of field names to their data type identifiers

    # Dynamic fields based on result_types mapping - accessed via dict key syntax
    # Common field names: "text", "output", "content", "data", "result", "answers"
    # Field types determined by result_types values


class UPLOAD_RESULT(TypedDict, total=False):
    """
    File upload result structure with processing outcome and metadata.

    This represents the complete result of a file upload operation, including
    upload statistics, processing results, and any error information.

    Upload Lifecycle:
    1. action='open': Upload initiated
    2. action='write': Data being transmitted
    3. action='close': Upload completed, processing starting
    4. action='complete': Upload and processing finished successfully
    5. action='error': Upload or processing failed

    Processing Results:
    When action='complete', the result field contains a PIPELINE_RESULT
    with the processed content. File uploads typically include MIME type
    information, so result.result_types should usually be present.

    Usage Example:
    -------------
    upload_results = await client.send_files([{'file': my_file}], token)

    for upload_result in upload_results:
        if upload_result['action'] == 'complete':
            processing_result = upload_result.get('result')
            if processing_result and processing_result.get('result_types'):
                # Access processed content
                if 'text' in processing_result['result_types']:
                    text_content = processing_result.get('text', [])
                    print(f"Extracted text: {text_content}")
        elif upload_result['action'] == 'error':
            print(f"Upload failed: {upload_result.get('error', 'Unknown error')}")
    """

    action: Literal['open', 'write', 'close', 'complete', 'error']  # REQUIRED - Upload completion status
    filepath: str  # REQUIRED - Original filename as provided during upload
    bytes_sent: int  # REQUIRED - Number of bytes successfully transmitted to the server
    file_size: int  # REQUIRED - Total size of the uploaded file in bytes
    upload_time: float  # REQUIRED - Time taken for the upload operation in seconds

    result: Optional[PIPELINE_RESULT]  # Processing result after successful upload (present when action='complete')
    error: Optional[str]  # Error message if upload or processing failed (present when action='error')
