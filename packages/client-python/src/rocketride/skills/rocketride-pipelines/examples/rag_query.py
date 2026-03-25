"""
RAG Query Pipeline — chat → embedding → qdrant → LLM → response

Searches a Qdrant vector DB for relevant documents and uses them
as context for LLM answers. Pair with an ingestion pipeline that
writes to the same collection.
"""

import asyncio
import os
from rocketride import RocketRideClient
from rocketride.schema import Question


def create_pipeline(collection: str = 'my_documents'):
    """Create a RAG query pipeline with embedding + qdrant + LLM."""
    return {
        'project_id': 'rag-query',
        'source': 'chat_1',
        'components': [
            {
                'id': 'chat_1',
                'provider': 'chat',
                'config': {},
            },
            {
                'id': 'embedding_openai_1',
                'provider': 'embedding_openai',
                'config': {
                    'profile': 'text-embedding-3-small',
                    'text-embedding-3-small': {
                        'apikey': os.environ.get('ROCKETRIDE_APIKEY_OPENAI', ''),
                    },
                },
                'input': [{'lane': 'questions', 'from': 'chat_1'}],
            },
            {
                'id': 'qdrant_1',
                'provider': 'qdrant',
                'config': {
                    'profile': 'local',
                    'local': {
                        'host': 'localhost',
                        'port': 6333,
                        'collection': collection,
                    },
                },
                'input': [{'lane': 'questions', 'from': 'embedding_openai_1'}],
            },
            {
                'id': 'llm_openai_1',
                'provider': 'llm_openai',
                'config': {
                    'profile': 'openai-5-2',
                    'openai-5-2': {
                        'apikey': os.environ.get('ROCKETRIDE_APIKEY_OPENAI', ''),
                    },
                },
                'input': [{'lane': 'questions', 'from': 'qdrant_1'}],
            },
            {
                'id': 'response_answers_1',
                'provider': 'response_answers',
                'config': {'laneName': 'answers'},
                'input': [{'lane': 'answers', 'from': 'llm_openai_1'}],
            },
        ],
    }


async def main():
    """Run the RAG query pipeline."""
    async with RocketRideClient(
        uri=os.environ.get('ROCKETRIDE_URI', 'http://localhost:5565'),
        auth=os.environ.get('ROCKETRIDE_APIKEY', ''),
    ) as client:
        pipeline = create_pipeline()
        result = await client.use(pipeline=pipeline, ttl=3600, use_existing=True)
        token = result['token']
        print(f'Pipeline started: {token}')

        try:
            question = Question()
            question.addQuestion('What are the key findings?')
            response = await client.chat(token=token, question=question)
            answers = response.get('answers', [])
            print(f'Answer: {answers[0] if answers else "No answer"}')
        finally:
            await client.terminate(token)


if __name__ == '__main__':
    asyncio.run(main())
