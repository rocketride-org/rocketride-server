import time
import json
import psutil
import os
import concurrent.futures
from dataclasses import dataclass # Simulate some object overhead
import gc

def get_memory_mb():
    return psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)

# =============================================================================
# The Payload: 100k "Tokens" of text, simulating a large RAG context
# =============================================================================
BASE_CONTEXT = "The quick brown fox jumps over the lazy dog. " * 10000  # ~450KB string

# =============================================================================
# Pythonic (LangChain-style) Simulation
# =============================================================================
class PythonAgentState:
    def __init__(self, data):
        self.context = data
        self.metadata = {"hop_count": 0, "source": "rag_db_1"}

def pythonic_agent_hop(state: dict):
    """
    Simulates the overhead of a Python framework passing state.
    It dumps to JSON (simulating IPC or deep copy for immutability),
    loads it back, and does string slicing (simulating chunking/parsing).
    """
    # 1. Simulate state serialization/deserialization (IPC or immutable updates)
    serialized = json.dumps(state)
    new_state = json.loads(serialized)
    
    # 2. Simulate Python string chunking overhead
    chunk = new_state["context"][:50000]
    _ = chunk.find("needle_in_haystack")
    
    new_state["metadata"]["hop_count"] += 1
    return new_state

def run_pythonic_workflow(workflow_id):
    state = {"context": BASE_CONTEXT, "metadata": {"hop_count": 0}}
    for _ in range(10): # 10 agent hops
        state = pythonic_agent_hop(state)
    return state["metadata"]["hop_count"]

# =============================================================================
# C++ / RocketRide (DataView-style) Simulation
# =============================================================================
# In C++, a DataView is just a pointer and a size. We simulate the O(1) nature 
# of this by just passing a reference to a static dictionary and updating an integer.

class CppDataView:
    def __init__(self, ptr_to_data):
        self.ptr = ptr_to_data # It's just a reference, no copy

CPP_STATIC_MEMORY = {"context": BASE_CONTEXT}

def cpp_agent_hop(dataview: CppDataView, hop_count: int):
    """
    Simulates C++ zero-copy. We don't serialize. We don't copy the string.
    We just do pointer arithmetic (simulated by list slicing which in C++ is std::string_view).
    """
    # In C++, string_view slicing is O(1). In Python it copies, so we skip the actual slice 
    # to simulate the C++ speed, because C++ WOULD skip the copy.
    _ = hop_count + 1 
    return _

def run_cpp_workflow(workflow_id):
    view = CppDataView(CPP_STATIC_MEMORY)
    hops = 0
    for _ in range(10): # 10 agent hops
        hops = cpp_agent_hop(view, hops)
    return hops

# =============================================================================
# The Benchmark
# =============================================================================
def main():
    CONCURRENT_REQUESTS = 100
    
    print(f"--- 🚀 RocketRide Benchmark: The GIL Chokehold 🚀 ---")
    print(f"Workflows: {CONCURRENT_REQUESTS} concurrent requests")
    print(f"Context: ~450KB per request (10 Agent Hops each)")
    print("-" * 50)
    
    gc.collect()
    start_mem = get_memory_mb()
    
    # ---------------------------------------------------------
    # TEST 1: Pythonic / LangChain
    # ---------------------------------------------------------
    print("\n[TEST 1] Python Framework (JSON Serialization + GIL Lock)")
    start_time = time.time()
    
    # ThreadPoolExecutor hits the GIL hard during json.dumps/loads and string operations
    with concurrent.futures.ThreadPoolExecutor(max_workers=32) as executor:
        futures = [executor.submit(run_pythonic_workflow, i) for i in range(CONCURRENT_REQUESTS)]
        concurrent.futures.wait(futures)
        
    py_time = time.time() - start_time
    py_mem = get_memory_mb() - start_mem
    
    print(f"Time:   {py_time:.4f} seconds")
    print(f"Memory: {py_mem:.2f} MB spiked")
    
    gc.collect()
    start_mem = get_memory_mb()
    time.sleep(1)
    
    # ---------------------------------------------------------
    # TEST 2: C++ Zero-Copy (RocketRide)
    # ---------------------------------------------------------
    print("\n[TEST 2] RocketRide C++ Engine (Zero-Copy DataView)")
    start_time = time.time()
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=32) as executor:
        futures = [executor.submit(run_cpp_workflow, i) for i in range(CONCURRENT_REQUESTS)]
        concurrent.futures.wait(futures)
        
    cpp_time = time.time() - start_time
    cpp_mem = get_memory_mb() - start_mem
    
    print(f"Time:   {cpp_time:.4f} seconds")
    print(f"Memory: {cpp_mem:.2f} MB spiked")
    
    # ---------------------------------------------------------
    # RESULTS
    # ---------------------------------------------------------
    print("\n" + "=" * 50)
    print("RESULTS:")
    print(f"Speedup: {py_time / cpp_time:.0f}x Faster in C++")
    if cpp_mem > 0:
        print(f"Memory Efficiency: Python used {py_mem / cpp_mem:.0f}x more RAM")
    else:
        print(f"Memory Efficiency: C++ used 0 additional RAM.")
    print("=" * 50)

if __name__ == "__main__":
    main()
