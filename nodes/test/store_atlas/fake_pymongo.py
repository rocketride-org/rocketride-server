# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""In-memory stand-in for the slice of pymongo the MongoDB Atlas store uses.

There is no pymongo mock under ``nodes/test/mocks`` (the Atlas node has no
services.json cases), so the Atlas explorer tests inject these objects into a
driver loaded against the real pymongo package (whose exceptions and
``SearchIndexModel`` the driver imports).

Supported: ``find`` with filters (equality, ``$in``/``$nin``/``$ne``/``$gt``/
``$gte``/``$lt``/``$lte``/``$regex``/``$exists``/``$and``/``$or``/``$text``),
projections, ``sort``/``skip``/``limit``; ``count_documents``; ``insert_many``;
``delete_many``; ``update_many`` with ``$set``; search-index listing and
creation; and ``aggregate`` with ``$match``, ``$vectorSearch``, ``$group``
(``$sum``, ``$min``, ``$max``, ``$first``, ``$firstN``, ``$push``),
``$sort``, ``$skip``, ``$limit``, ``$count``, ``$sample``, ``$project``,
``$set``/``$addFields``, ``$unwind`` and ``$replaceRoot`` over the expressions
``$field``, ``$$ROOT``, ``$cond``, ``$eq``, ``$rand`` and ``$meta``.
"""

from __future__ import annotations

import copy
import math
import random
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional, Sequence

_MISSING = object()


def get_path(document: Any, path: str, default: Any = None) -> Any:
    """Read a dotted path."""
    value = document
    for part in path.split('.'):
        if isinstance(value, dict) and part in value:
            value = value[part]
        else:
            return default
    return value


def set_path(document: Dict[str, Any], path: str, value: Any) -> None:
    """Write a dotted path."""
    parts = path.split('.')
    target = document
    for part in parts[:-1]:
        target = target.setdefault(part, {})
    target[parts[-1]] = value


def _sort_key(value: Any) -> tuple:
    """Order None/missing first, then numbers, then strings, then the rest."""
    if value is None or value is _MISSING:
        return (0, 0)
    if isinstance(value, bool):
        return (1, int(value))
    if isinstance(value, (int, float)):
        return (1, value)
    if isinstance(value, str):
        return (2, value)
    return (3, str(value))


def matches(document: Dict[str, Any], query: Optional[Dict[str, Any]]) -> bool:
    """Evaluate a MongoDB query document."""
    for key, condition in (query or {}).items():
        if key == '$and':
            if not all(matches(document, sub) for sub in condition):
                return False
            continue
        if key == '$or':
            if not any(matches(document, sub) for sub in condition):
                return False
            continue
        if key == '$text':
            needle = str(condition.get('$search', '')).lower()
            if needle not in str(document.get('content', '')).lower():
                return False
            continue
        value = get_path(document, key, _MISSING)
        if isinstance(condition, dict) and any(op.startswith('$') for op in condition):
            options = condition.get('$options', '')
            for op, expected in condition.items():
                if op == '$options':
                    continue
                present = value is not _MISSING
                actual = value if present else None
                if op == '$eq' and actual != expected:
                    return False
                if op == '$ne' and actual == expected:
                    return False
                if op == '$in' and actual not in expected:
                    return False
                if op == '$nin' and actual in expected:
                    return False
                if op in ('$gt', '$gte', '$lt', '$lte'):
                    if actual is None:
                        return False
                    if op == '$gt' and not actual > expected:
                        return False
                    if op == '$gte' and not actual >= expected:
                        return False
                    if op == '$lt' and not actual < expected:
                        return False
                    if op == '$lte' and not actual <= expected:
                        return False
                if op == '$regex':
                    flags = re.IGNORECASE if 'i' in options else 0
                    if actual is None or not re.search(expected, str(actual), flags):
                        return False
                if op == '$exists' and bool(expected) != present:
                    return False
        else:
            actual = None if value is _MISSING else value
            if actual != condition:
                return False
    return True


def evaluate(expression: Any, document: Dict[str, Any]) -> Any:
    """Evaluate an aggregation expression against a document."""
    if isinstance(expression, str):
        if expression == '$$ROOT':
            return document
        if expression.startswith('$'):
            return get_path(document, expression[1:])
        return expression
    if isinstance(expression, dict):
        if '$cond' in expression:
            condition, then, otherwise = expression['$cond']
            return evaluate(then, document) if evaluate(condition, document) else evaluate(otherwise, document)
        if '$eq' in expression:
            left, right = expression['$eq']
            return evaluate(left, document) == evaluate(right, document)
        if '$rand' in expression:
            return random.random()
        if '$meta' in expression:
            return document.get('__meta_' + expression['$meta'])
        return {key: evaluate(value, document) for key, value in expression.items()}
    if isinstance(expression, list):
        return [evaluate(item, document) for item in expression]
    return expression


def _accumulate(spec: Dict[str, Any], rows: List[Dict[str, Any]]) -> Any:
    operator, argument = next(iter(spec.items()))
    if operator == '$sum':
        return sum(evaluate(argument, row) or 0 for row in rows)
    if operator in ('$min', '$max'):
        values = [v for v in (evaluate(argument, row) for row in rows) if v is not None]
        if not values:
            return None
        ordered = sorted(values, key=_sort_key)
        return ordered[0] if operator == '$min' else ordered[-1]
    if operator == '$first':
        return evaluate(argument, rows[0]) if rows else None
    if operator == '$firstN':
        return [evaluate(argument['input'], row) for row in rows[: int(argument['n'])]]
    if operator == '$push':
        return [evaluate(argument, row) for row in rows]
    raise NotImplementedError(f'accumulator {operator}')


def _similarity(metric: str, a: Sequence[float], b: Sequence[float]) -> float:
    """Atlas Vector Search scores: cosine and dotProduct normalised to [0, 1]; euclidean 1 / (1 + d)."""
    if metric == 'euclidean':
        return 1.0 / (1.0 + math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b))))
    dot = sum(x * y for x, y in zip(a, b))
    if metric == 'dotProduct':
        return (1.0 + dot) / 2.0
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return (1.0 + (dot / (na * nb) if na and nb else 0.0)) / 2.0


def _project(document: Dict[str, Any], projection: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not projection:
        return copy.deepcopy(document)
    include = {k for k, v in projection.items() if v in (1, True)}
    exclude = {k for k, v in projection.items() if v in (0, False)}
    if include:
        out = {'_id': document.get('_id')} if '_id' not in exclude else {}
        for key in include:
            value = get_path(document, key, _MISSING)
            if value is not _MISSING:
                set_path(out, key, copy.deepcopy(value))
        return out
    out = copy.deepcopy(document)
    for key in exclude:
        parts = key.split('.')
        target = out
        for part in parts[:-1]:
            target = target.get(part, {})
        if isinstance(target, dict):
            target.pop(parts[-1], None)
    return out


@dataclass
class DeleteResult:
    """``pymongo.results.DeleteResult``."""

    deleted_count: int


@dataclass
class UpdateResult:
    """``pymongo.results.UpdateResult``."""

    matched_count: int
    modified_count: int


@dataclass
class InsertManyResult:
    """``pymongo.results.InsertManyResult``."""

    inserted_ids: List[Any] = field(default_factory=list)


class FakeCursor:
    """A cursor with sort/skip/limit chaining."""

    def __init__(self, rows: List[Dict[str, Any]]):
        self._rows = rows
        self._skip = 0
        self._limit = 0

    def sort(self, key: Any, direction: int = 1) -> 'FakeCursor':
        keys = key if isinstance(key, list) else [(key, direction)]
        for name, order in reversed(keys):
            self._rows.sort(key=lambda row: _sort_key(get_path(row, name)), reverse=order == -1)
        return self

    def skip(self, count: int) -> 'FakeCursor':
        self._skip = int(count or 0)
        return self

    def limit(self, count: int) -> 'FakeCursor':
        self._limit = int(count or 0)
        return self

    def __iter__(self) -> Iterator[Dict[str, Any]]:
        rows = self._rows[self._skip :]
        if self._limit:
            rows = rows[: self._limit]
        return iter(rows)


class FakeCollection:
    """One collection."""

    def __init__(self, name: str):
        self.name = name
        self.docs: List[Dict[str, Any]] = []
        self.indexes: List[Any] = []
        self.search_indexes: List[Dict[str, Any]] = []
        self.calls: List[tuple] = []

    # --- reads ---------------------------------------------------------

    def find(
        self, filter: Optional[Dict[str, Any]] = None, projection: Optional[Dict[str, Any]] = None, **kwargs: Any
    ) -> FakeCursor:
        self.calls.append(('find', filter))
        return FakeCursor([_project(doc, projection) for doc in self.docs if matches(doc, filter)])

    def count_documents(self, filter: Dict[str, Any], **kwargs: Any) -> int:
        self.calls.append(('count_documents', filter))
        return sum(1 for doc in self.docs if matches(doc, filter))

    def aggregate(self, pipeline: List[Dict[str, Any]], **kwargs: Any) -> Iterator[Dict[str, Any]]:
        self.calls.append(('aggregate', pipeline))
        rows = [copy.deepcopy(doc) for doc in self.docs]
        for stage in pipeline:
            ((name, spec),) = stage.items()
            if name == '$match':
                rows = [row for row in rows if matches(row, spec)]
            elif name == '$vectorSearch':
                index = next((i for i in self.search_indexes if i['name'] == spec['index']), None)
                if index is None or index.get('type') != 'vectorSearch':
                    from pymongo.errors import OperationFailure

                    raise OperationFailure('$vectorSearch needs a vectorSearch index', code=8)
                vector_field = next(f for f in index['latestDefinition']['fields'] if f['type'] == 'vector')
                rows = [row for row in rows if matches(row, spec.get('filter'))]
                for row in rows:
                    row['__meta_vectorSearchScore'] = _similarity(
                        vector_field['similarity'], spec['queryVector'], get_path(row, spec['path']) or []
                    )
                rows.sort(key=lambda row: -row['__meta_vectorSearchScore'])
                rows = rows[: int(spec['limit'])]
            elif name in ('$set', '$addFields'):
                for row in rows:
                    for key, expression in spec.items():
                        set_path(row, key, evaluate(expression, row))
            elif name == '$project':
                projected = []
                for row in rows:
                    out = {'_id': row.get('_id')} if spec.get('_id', 1) not in (0, False) else {}
                    for key, expression in spec.items():
                        if key == '_id' and expression in (0, False, 1, True):
                            continue
                        if expression in (1, True):
                            set_path(out, key, get_path(row, key))
                        elif expression not in (0, False):
                            set_path(out, key, evaluate(expression, row))
                    projected.append(out)
                rows = projected
            elif name == '$group':
                groups: Dict[Any, List[Dict[str, Any]]] = {}
                order: List[Any] = []
                for row in rows:
                    key = evaluate(spec['_id'], row)
                    marker = repr(key)
                    if marker not in groups:
                        groups[marker] = []
                        order.append((marker, key))
                    groups[marker].append(row)
                out_rows = []
                for marker, key in order:
                    out = {'_id': key}
                    for name_, accumulator in spec.items():
                        if name_ != '_id':
                            out[name_] = _accumulate(accumulator, groups[marker])
                    out_rows.append(out)
                rows = out_rows
            elif name == '$sort':
                for key, direction in reversed(list(spec.items())):
                    rows.sort(key=lambda row: _sort_key(get_path(row, key)), reverse=direction == -1)
            elif name == '$skip':
                rows = rows[int(spec) :]
            elif name == '$limit':
                rows = rows[: int(spec)]
            elif name == '$count':
                rows = [{spec: len(rows)}]
            elif name == '$sample':
                rows = random.sample(rows, min(int(spec['size']), len(rows)))
            elif name == '$unwind':
                path = spec if isinstance(spec, str) else spec['path']
                unwound = []
                for row in rows:
                    for item in get_path(row, path[1:]) or []:
                        clone = dict(row)
                        set_path(clone, path[1:], item)
                        unwound.append(clone)
                rows = unwound
            elif name == '$replaceRoot':
                rows = [evaluate(spec['newRoot'], row) for row in rows]
            else:
                raise NotImplementedError(f'stage {name}')
        return iter(rows)

    # --- writes --------------------------------------------------------

    def insert_many(self, documents: List[Dict[str, Any]], **kwargs: Any) -> InsertManyResult:
        for document in documents:
            for key, value in (document.get('meta') or {}).items():
                if hasattr(value, 'model_dump'):
                    raise TypeError(f'cannot encode object: {value!r}')
            self.docs.append(copy.deepcopy(document))
        return InsertManyResult(inserted_ids=[d.get('_id') for d in documents])

    def delete_many(self, filter: Dict[str, Any], **kwargs: Any) -> DeleteResult:
        before = len(self.docs)
        self.docs = [doc for doc in self.docs if not matches(doc, filter)]
        return DeleteResult(deleted_count=before - len(self.docs))

    def update_many(self, filter: Dict[str, Any], update: Dict[str, Any], **kwargs: Any) -> UpdateResult:
        # As MongoDB counts them: matched_count every document the filter takes,
        # modified_count only those whose stored values the update changed.
        matched = modified = 0
        for doc in self.docs:
            if matches(doc, filter):
                matched += 1
                before = copy.deepcopy(doc)
                for key, value in (update.get('$set') or {}).items():
                    set_path(doc, key, value)
                modified += int(doc != before)
        return UpdateResult(matched_count=matched, modified_count=modified)

    # --- indexes -------------------------------------------------------

    def create_index(self, keys: Any, **kwargs: Any) -> str:
        self.indexes.append((keys, kwargs))
        return str(keys)

    def list_search_indexes(self, *args: Any, **kwargs: Any) -> Iterator[Dict[str, Any]]:
        return iter([dict(index) for index in self.search_indexes])

    def create_search_index(self, model: Any) -> str:
        document = getattr(model, 'document', model)
        self.search_indexes.append(
            {
                'name': document['name'],
                'type': document.get('type', 'search'),
                'status': 'READY',
                'queryable': True,
                'latestDefinition': document['definition'],
            }
        )
        return document['name']


class FakeDatabase:
    """One database."""

    def __init__(self, name: str):
        self.name = name
        self.collections: Dict[str, FakeCollection] = {}
        self.created: List[str] = []

    def list_collection_names(self) -> List[str]:
        return list(self.created)

    def create_collection(self, name: str, **kwargs: Any) -> FakeCollection:
        if name not in self.created:
            self.created.append(name)
        return self[name]

    def __getitem__(self, name: str) -> FakeCollection:
        return self.collections.setdefault(name, FakeCollection(name))


class FakeMongoClient:
    """The client: databases by name."""

    def __init__(self, *args: Any, **kwargs: Any):
        self.databases: Dict[str, FakeDatabase] = {}

    def __getitem__(self, name: str) -> FakeDatabase:
        return self.databases.setdefault(name, FakeDatabase(name))

    def close(self) -> None:
        pass
