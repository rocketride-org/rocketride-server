import requests
import time
import concurrent.futures

BASE_URL = "http://localhost"

def setup_dify():
    """Initializes the Dify admin account to get an auth token."""
    url = f"{BASE_URL}/console/api/setup"
    payload = {
        "email": "admin@rocketride.org",
        "name": "Admin",
        "password": "Password123!"
    }
    try:
        response = requests.post(url, json=payload, timeout=5)
        if response.status_code in [200, 201]:
            print("Successfully initialized Dify admin account.")
            return login_dify()
        elif response.status_code == 403:
            # Already initialized, try to login
            return login_dify()
        else:
            print(f"Setup failed: {response.status_code} - {response.text}")
            return None
    except Exception as e:
        print(f"Error connecting to Dify: {e}")
        return None

def login_dify():
    """Logs in to get the auth token if already setup."""
    url = f"{BASE_URL}/console/api/login"
    payload = {
        "email": "admin@rocketride.org",
        "password": "Password123!"
    }
    response = requests.post(url, json=payload, timeout=5)
    if response.status_code == 200:
        print("Successfully logged into Dify.")
        return response.json().get("data", {}).get("access_token")
    print(f"Login failed: {response.status_code} - {response.text}")
    return None

def benchmark_dify_api(token, num_requests=100):
    """
    Spams a simple authenticated API endpoint on Dify to measure 
    the raw HTTP + Flask + Postgres latency before it even touches an LLM or Celery worker.
    """
    url = f"{BASE_URL}/console/api/workspaces/current"
    headers = {"Authorization": f"Bearer {token}"}
    
    print(f"\n--- 🚀 RUNNING DIFY API BENCHMARK ({num_requests} concurrent requests) ---")
    start_time = time.time()
    
    successes = 0
    failures = 0
    
    def make_request():
        nonlocal successes, failures
        try:
            res = requests.get(url, headers=headers, timeout=10)
            if res.status_code == 200:
                successes += 1
            else:
                failures += 1
        except:
            failures += 1

    with concurrent.futures.ThreadPoolExecutor(max_workers=64) as executor:
        futures = [executor.submit(make_request) for _ in range(num_requests)]
        concurrent.futures.wait(futures)
        
    total_time = time.time() - start_time
    print(f"Total Time: {total_time:.2f}s")
    print(f"Successful Requests: {successes}")
    print(f"Failed Requests: {failures}")
    print(f"Average Latency (just for HTTP/DB lookup): {(total_time/num_requests)*1000:.2f}ms per request")
    print("-" * 60)

if __name__ == "__main__":
    token = setup_dify()
    if token:
        benchmark_dify_api(token, num_requests=500)
    else:
        print("Could not obtain auth token. Dify might still be booting up.")
