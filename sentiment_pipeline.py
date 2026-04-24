import asyncio
import os
from dotenv import load_dotenv
from rocketride import RocketRideClient

load_dotenv()

sample_text = "I love this product! It works amazing."

async def run_pipeline():
    async with RocketRideClient(
        uri=os.getenv("ROCKETRIDE_URI"),
        api_key=os.getenv("ROCKETRIDE_APIKEY")
    ) as client:

        print("Connected to RocketRide")

        result = await client.use(filepath="sentiment.pipe")
        token = result["token"]

        response = await client.send(token, sample_text)

        print("\n=== OUTPUT ===")
        print(response)

asyncio.run(run_pipeline())