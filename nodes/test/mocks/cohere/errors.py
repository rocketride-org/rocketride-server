"""Cohere SDK exception classes used by rerank node tests."""


class CohereError(Exception):
    pass


class UnauthorizedError(CohereError):
    pass


class BadRequestError(CohereError):
    pass


class TooManyRequestsError(CohereError):
    pass


class InternalServerError(CohereError):
    pass
