# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

import re
from typing import Any, Dict, List, Optional


class ExpectationError(Exception):
    """Raised when an expectation fails."""

    def __init__(self, message: str, path: str = '', expected: Any = None, actual: Any = None):
        self.path = path
        self.expected = expected
        self.actual = actual
        super().__init__(message)


# Lane-specific content paths
# Maps lane names to the path where the primary "content" lives
# These shortcuts let you write {"contains": "hello"} instead of {"property": {"path": "...", "contains": "hello"}}
#
# Based on result_types format where:
#   - "text" type → List[str] (array of strings)
#   - "answers" type → List[str] (array of answer strings)
#   - "questions" type → List[Question] (Question objects with nested questions array)
#   - "documents" type → List[Doc] (Doc objects with page_content)
#
LANE_CONTENT_PATHS = {
    'text': '[0]',  # Text output: List[str] - array of strings
    'questions': '[0].questions[0].text',  # Questions output: List[Question] - Question has questions[].text
    'answers': '[0]',  # Answers output: List[str] - array of answer strings
    'documents': '[0].page_content',  # Documents output: List[Doc] - Doc has page_content
    'table': '[0]',  # Table output: array of table data
    'image': '[0]',  # Image output: array of image data
    'audio': '[0]',  # Audio output: array of audio data
    'video': '[0]',  # Video output: array of video data
    'classifications': '[0]',  # Classifications output
    'tags': '[0]',  # Tags output
}

# Matchers that should apply to lane content (not the raw array)
CONTENT_MATCHERS = {'equals', 'contains', 'matches', 'beginsWith', 'endsWith'}


class ExpectationValidator:
    """
    Validates test results against expected conditions.

    Supports matchers:
        - equals: exact match (lane-aware: checks content)
        - contains: substring match (lane-aware: checks content)
        - matches: regex pattern (lane-aware: checks content)
        - beginsWith: string prefix match (lane-aware: checks content)
        - endsWith: string suffix match (lane-aware: checks content)
        - notEmpty: has content
        - minLength: minimum length
        - maxLength: maximum length
        - greaterThan: numeric comparison
        - lessThan: numeric comparison
        - hasProperty: property exists
        - type: type check
        - property: check nested path - can be object or array of objects
        - each: all items match
        - any: at least one matches
        - noError: just check no error occurred

    Lane-aware shortcuts:
        When using content matchers (equals, contains, matches, beginsWith, endsWith)
        on a lane, the validator automatically navigates to the content location.
        E.g., for 'text' lane, {"contains": "hello"} checks [0].

        Content matchers can be combined with 'property' - content matchers check
        the lane content path while 'property' checks explicit paths on the raw result.

    Property matcher:
        Can be a single object or array of objects for multiple property checks:

        Single: {"property": {"path": "[0].score", "greaterThan": 0.5}}

        Multiple: {"property": [
            {"path": "[0].score", "greaterThan": 0.5},
            {"path": "[0].metadata.objectId", "equals": "test-doc-1"}
        ]}
    """

    def __init__(self, results: Dict[str, Any]):
        """
        Initialize validator with test results.

        Args:
            results: Dict mapping output lane names to their results
        """
        self.results = results

    def validate(self, expectations: Optional[Dict[str, Any]]) -> List[ExpectationError]:
        """
        Validate results against expectations.

        Args:
            expectations: Dict mapping lane names to their expectations,
                         or None for no validation (sink test)

        Returns:
            List of ExpectationError for any failures
        """
        if expectations is None:
            return []  # No expectations = pass (sink test)

        errors = []

        for lane, expect in expectations.items():
            result = self.results.get(lane)
            lane_errors = self._validate_lane(lane, result, expect)
            errors.extend(lane_errors)

        return errors

    def _validate_lane(self, lane: str, result: Any, expect: Dict[str, Any]) -> List[ExpectationError]:
        """
        Validate a lane result with lane-aware shortcuts.

        For content matchers (equals, contains, matches) on known lanes,
        automatically navigates to the lane's content path.

        Content matchers and 'property' can be used together - content matchers
        check the lane content path while 'property' checks explicit paths.
        """
        errors = []

        if expect is None:
            return errors

        # Check which matchers are used
        has_content_matcher = any(m in expect for m in CONTENT_MATCHERS)

        # For content matchers on known lanes, use lane shortcut
        if has_content_matcher and lane in LANE_CONTENT_PATHS:
            content_path = LANE_CONTENT_PATHS[lane]

            # Extract content matchers vs other matchers
            content_expect = {k: v for k, v in expect.items() if k in CONTENT_MATCHERS}
            other_expect = {k: v for k, v in expect.items() if k not in CONTENT_MATCHERS}

            # Lane has no content (None or missing) — avoid subscript errors
            if result is None:
                errors.append(
                    ExpectationError(
                        f"Lane ${lane} has no content (result is None); cannot validate '{content_path}'",
                        f'${lane}',
                        content_path,
                        result,
                    )
                )
                return errors

            # Get content value using lane shortcut path
            try:
                content_value = self._get_property(result, content_path)
            except (KeyError, IndexError, TypeError) as e:
                errors.append(
                    ExpectationError(
                        f"Could not access lane content at '{content_path}': {e}", f'${lane}', content_path, result
                    )
                )
                return errors

            # Apply content matchers to the content value (lane-aware)
            content_errors = self._validate_value(content_value, content_expect, f'${lane}.{content_path}')
            errors.extend(content_errors)

            # Apply other matchers (like 'property', 'notEmpty', etc.) to the raw result
            if other_expect:
                other_errors = self._validate_value(result, other_expect, f'${lane}')
                errors.extend(other_errors)

            return errors

        # No shortcut - validate directly
        return self._validate_value(result, expect, f'${lane}')

    def _validate_value(self, value: Any, expect: Dict[str, Any], path: str) -> List[ExpectationError]:
        """Validate a single value against expectations."""
        errors = []

        if expect is None:
            return errors

        # Handle simple matchers
        if 'equals' in expect:
            if value != expect['equals']:
                errors.append(
                    ExpectationError(
                        f"Expected equals '{expect['equals']}' but got '{value}'", path, expect['equals'], value
                    )
                )

        if 'contains' in expect:
            expected = expect['contains']
            if isinstance(value, str):
                if expected not in value:
                    errors.append(ExpectationError(f"Expected string to contain '{expected}'", path, expected, value))
            elif isinstance(value, (list, tuple)):
                if expected not in value:
                    errors.append(ExpectationError(f"Expected array to contain '{expected}'", path, expected, value))
            else:
                # Try to find in string representation
                if expected not in str(value):
                    errors.append(ExpectationError(f"Expected value to contain '{expected}'", path, expected, value))

        if 'matches' in expect:
            pattern = expect['matches']
            if not isinstance(value, str) or not re.search(pattern, value):
                errors.append(ExpectationError(f"Expected to match pattern '{pattern}'", path, pattern, value))

        if 'beginsWith' in expect:
            prefix = expect['beginsWith']
            if not isinstance(value, str) or not value.startswith(prefix):
                errors.append(ExpectationError(f"Expected to begin with '{prefix}'", path, prefix, value))

        if 'endsWith' in expect:
            suffix = expect['endsWith']
            if not isinstance(value, str) or not value.endswith(suffix):
                errors.append(ExpectationError(f"Expected to end with '{suffix}'", path, suffix, value))

        if 'notEmpty' in expect and expect['notEmpty']:
            if value is None or value == '' or value == [] or value == {}:
                errors.append(ExpectationError('Expected value to not be empty', path, 'not empty', value))

        if 'minLength' in expect:
            min_len = expect['minLength']
            actual_len = len(value) if hasattr(value, '__len__') else 0
            if actual_len < min_len:
                errors.append(
                    ExpectationError(
                        f'Expected minimum length {min_len} but got {actual_len}', path, min_len, actual_len
                    )
                )

        if 'maxLength' in expect:
            max_len = expect['maxLength']
            actual_len = len(value) if hasattr(value, '__len__') else 0
            if actual_len > max_len:
                errors.append(
                    ExpectationError(
                        f'Expected maximum length {max_len} but got {actual_len}', path, max_len, actual_len
                    )
                )

        if 'greaterThan' in expect:
            threshold = expect['greaterThan']
            if not isinstance(value, (int, float)) or value <= threshold:
                errors.append(ExpectationError(f'Expected value > {threshold}', path, f'> {threshold}', value))

        if 'lessThan' in expect:
            threshold = expect['lessThan']
            if not isinstance(value, (int, float)) or value >= threshold:
                errors.append(ExpectationError(f'Expected value < {threshold}', path, f'< {threshold}', value))

        if 'hasProperty' in expect:
            prop_name = expect['hasProperty']
            if not self._has_property(value, prop_name):
                errors.append(ExpectationError(f"Expected property '{prop_name}' to exist", path, prop_name, value))

        if 'type' in expect:
            expected_type = expect['type']
            actual_type = self._get_type_name(value)
            if actual_type != expected_type:
                errors.append(
                    ExpectationError(
                        f"Expected type '{expected_type}' but got '{actual_type}'", path, expected_type, actual_type
                    )
                )

        if 'property' in expect:
            prop_expect = expect['property']

            # Support both single object and array of objects
            if isinstance(prop_expect, list):
                # Array of property checks
                for prop_check in prop_expect:
                    prop_errors = self._validate_property(value, prop_check, path)
                    errors.extend(prop_errors)
            else:
                # Single property check
                prop_errors = self._validate_property(value, prop_expect, path)
                errors.extend(prop_errors)

        if 'each' in expect:
            if isinstance(value, (list, tuple)):
                for i, item in enumerate(value):
                    item_errors = self._validate_value(item, expect['each'], f'{path}[{i}]')
                    errors.extend(item_errors)
            else:
                errors.append(
                    ExpectationError("Expected an array for 'each' matcher", path, 'array', type(value).__name__)
                )

        if 'any' in expect:
            if isinstance(value, (list, tuple)):
                any_passed = False
                for item in value:
                    item_errors = self._validate_value(item, expect['any'], path)
                    if not item_errors:
                        any_passed = True
                        break
                if not any_passed:
                    errors.append(
                        ExpectationError(
                            "Expected at least one item to match 'any' condition", path, expect['any'], value
                        )
                    )
            else:
                errors.append(
                    ExpectationError("Expected an array for 'any' matcher", path, 'array', type(value).__name__)
                )

        if 'noError' in expect and expect['noError']:
            # Just check that there's no error - value exists
            pass  # If we got here, there was no error

        return errors

    def _validate_property(self, value: Any, prop_expect: Dict[str, Any], path: str) -> List[ExpectationError]:
        """
        Validate a single property check.

        Args:
            value: The value to check the property on
            prop_expect: Property expectation with 'path' and matchers
            path: Current path for error reporting

        Returns:
            List of ExpectationError for any failures
        """
        errors = []
        prop_path = prop_expect.get('path', '')

        try:
            prop_value = self._get_property(value, prop_path)
        except (KeyError, IndexError, TypeError) as e:
            errors.append(
                ExpectationError(
                    f"Could not access property at '{prop_path}': {e}", f'{path}.{prop_path}', prop_path, value
                )
            )
            return errors

        # Validate the nested property with remaining expectations
        nested_expect = {k: v for k, v in prop_expect.items() if k != 'path'}
        if nested_expect:
            nested_errors = self._validate_value(prop_value, nested_expect, f'{path}.{prop_path}')
            errors.extend(nested_errors)

        return errors

    def _has_property(self, obj: Any, path: str) -> bool:
        """Check if a property path exists on an object."""
        try:
            self._get_property(obj, path)
            return True
        except (KeyError, IndexError, TypeError, AttributeError):
            return False

    def _get_property(self, obj: Any, path: str) -> Any:
        """Get a property from an object by path (e.g., 'filter.objectIds[0]')."""
        if not path:
            return obj

        current = obj
        # Split on . and [ for path navigation
        parts = re.split(r'\.|\[', path)

        for part in parts:
            if not part:
                continue
            if current is None:
                raise TypeError('Cannot access path: value is None')

            # Handle array index
            if part.endswith(']'):
                part = part[:-1]
                try:
                    index = int(part)
                    current = current[index]
                    continue
                except ValueError:
                    pass

            # Handle dict/object property
            if isinstance(current, dict):
                current = current[part]
            elif hasattr(current, part):
                current = getattr(current, part)
            else:
                raise KeyError(f"Property '{part}' not found")

        return current

    def _get_type_name(self, value: Any) -> str:
        """Get a simple type name for a value."""
        if value is None:
            return 'null'
        elif isinstance(value, bool):
            return 'boolean'
        elif isinstance(value, int):
            return 'integer'
        elif isinstance(value, float):
            return 'number'
        elif isinstance(value, str):
            return 'string'
        elif isinstance(value, (list, tuple)):
            return 'array'
        elif isinstance(value, dict):
            return 'object'
        else:
            return type(value).__name__
