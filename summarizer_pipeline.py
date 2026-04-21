import asyncio
import os
from dotenv import load_dotenv
from rocketride import RocketRideClient

load_dotenv()

sample_data = """
NOAA Weather Report - Station ID: 42501
Date: 2024-11-15
Temperature: 94F
Humidity: 78%
Wind Speed: 12mph NE
Anomaly: +8F above seasonal average
"""

async def summarize_weather(data: str):
    async with RocketRideClient(
        uri=os.getenv("ROCKETRIDE_URI"),
        api_key=os.getenv("ROCKETRIDE_APIKEY")
    ) as client:
        print("Connecting...")
        result = await client.use(filepath="summarizer.pipe")
        token = result["token"]
        response = await client.send(token, data)
        print("\n--- SUMMARY ---")
        print(response)

asyncio.run(summarize_weather(sample_data))