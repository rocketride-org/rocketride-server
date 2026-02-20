"""
Mock pgvector extension for testing.

This mock provides the register_vector function that enables
vector operations in psycopg2.
"""


def register_vector(connection):
    """Register vector type with the connection.
    
    In the real pgvector, this enables the vector data type
    for use with PostgreSQL. In our mock, it's a no-op since
    we handle vectors directly.
    """
    pass


# Submodule for psycopg2 integration
class psycopg2:
    """Mock psycopg2 integration."""
    
    @staticmethod
    def register_vector(connection):
        """Register vector type with connection."""
        pass

