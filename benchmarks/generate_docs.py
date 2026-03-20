"""Generate synthetic test documents for benchmark."""

import os
import random
import time

TOPICS = [
    "artificial intelligence",
    "machine learning",
    "neural networks",
    "deep learning",
    "natural language processing",
    "computer vision",
    "reinforcement learning",
    "transformer models",
    "attention mechanism",
    "convolutional networks",
    "recurrent networks",
    "generative models",
    "transfer learning",
    "few-shot learning",
    "zero-shot learning",
    "federated learning",
    "graph neural networks",
    "diffusion models",
    "large language models",
    "retrieval augmented generation",
]

TEMPLATES = [
    "This document discusses {topic} and its applications in modern technology. "
    "The field of {topic} has seen remarkable growth in recent years, with new "
    "breakthroughs emerging regularly. Researchers have found that {topic} can be "
    "applied to solve complex problems in healthcare, finance, and engineering. "
    "One key challenge in {topic} is scaling the algorithms to handle large datasets "
    "efficiently. Recent papers published in top conferences like NeurIPS and ICML "
    "have proposed novel approaches to {topic} that achieve state-of-the-art results "
    "on standard benchmarks. The practical implications of {topic} extend beyond "
    "academic research into real-world production systems.",
    "A comprehensive overview of {topic} reveals several important trends. First, "
    "the computational requirements for {topic} continue to grow exponentially. "
    "Second, the democratization of {topic} tools has made it accessible to a wider "
    "audience. Third, ethical considerations surrounding {topic} are becoming "
    "increasingly important. Industry leaders are investing heavily in {topic} "
    "infrastructure, with major cloud providers offering specialized hardware and "
    "software solutions. The integration of {topic} into existing workflows remains "
    "a significant engineering challenge that requires careful planning and execution.",
    "Recent advances in {topic} have transformed how organizations approach data "
    "processing and analysis. The convergence of {topic} with edge computing enables "
    "real-time inference on resource-constrained devices. Benchmark results show that "
    "the latest {topic} models outperform previous generations by significant margins. "
    "However, the energy consumption associated with training {topic} models raises "
    "sustainability concerns. Researchers are exploring techniques like pruning, "
    "quantization, and knowledge distillation to make {topic} more efficient. "
    "Open-source communities have played a crucial role in advancing {topic} research.",
]


def generate_documents(output_dir: str, count: int) -> None:
    os.makedirs(output_dir, exist_ok=True)
    random.seed(42)

    start = time.perf_counter()
    for i in range(count):
        topic = random.choice(TOPICS)
        template = random.choice(TEMPLATES)
        content = template.format(topic=topic)
        # Add some variation: repeat 2-5 times to get ~1-3KB per doc
        repeats = random.randint(2, 5)
        full_content = f"Document {i + 1}: {topic.title()}\n\n"
        full_content += "\n\n".join([content] * repeats)

        filepath = os.path.join(output_dir, f"doc_{i:05d}.txt")
        with open(filepath, "w") as f:
            f.write(full_content)

    elapsed = time.perf_counter() - start
    total_size = sum(
        os.path.getsize(os.path.join(output_dir, f)) for f in os.listdir(output_dir)
    )
    print(f"Generated {count} documents in {elapsed:.2f}s")
    print(f"Total size: {total_size / 1024 / 1024:.1f} MB")
    print(f"Avg size: {total_size / count / 1024:.1f} KB")


if __name__ == "__main__":
    for n in [1000, 5000, 10000]:
        d = f"/tmp/bench_docs_{n}"
        generate_documents(d, n)
        print()
