"""
Mock pgvector.psycopg2 module for testing.

This mock provides the register_vector function that enables
vector operations in psycopg2.
"""


def register_vector(connection):
    """Register vector type with the connection.
    
    In the real pgvector, this enables the vector data type
    for use with PostgreSQL. In our mock, it's a no-op since
    we handle vectors directly in the psycopg2 mock.
    """
    pass

