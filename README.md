<p align="center">
  <img src="./images/header.jpeg" alt="RocketRide Header">
</p>

<p align="center">
  <a href="https://github.com/rocketride-org/rocketride-server/actions/workflows/ci.yml"><img src="https://github.com/rocketride-org/rocketride-server/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-18%2B-green.svg" alt="Node.js 18+"></a>
  <a href="https://discord.gg/9hr3tdZmEG"><img src="https://img.shields.io/badge/Discord-Join%20us-5865F2.svg" alt="Discord"></a>
</p>

# RocketRide: The IDE-Native Engine for High-Performance AI Agents & Local RAG

**Stop jumping to the browser to build AI workflows. Build, debug, and ship production-ready agentic pipelines directly in VS Code.**

RocketRide is a high-performance orchestration engine built on a **C++ core** with a **Python-extensible node system**. While tools like Langflow and Dify focus on low-code prototyping in the browser, RocketRide is built for **Senior Engineers** who need local execution, zero-latency RAG, and seamless integration with the tools they already use: **VS Code, Cursor, and Claude Desktop.**

---

## ⚡ Why RocketRide?

*   **🚀 C++ Performance:** Bypasses the Python Global Interpreter Lock (GIL). Uses zero-copy memory to pass multi-gigabyte data (video, audio, massive PDF sets) between nodes 100x faster than Python-based orchestrators.
*   **🛠️ IDE-Native Flow:** No context switching. A visual pipeline builder lives as a VS Code Webview, sitting directly next to your source code and git.
*   **🔌 MCP Native:** The easiest way to build, test, and export **Model Context Protocol (MCP)** tools. Turn any visual pipeline into a "skill" for Claude Desktop or Cursor with one click.
*   **🔓 Pure MIT License:** Build your commercial AI-as-a-Service without "multi-tenant" license traps or vendor lock-in.

---

## 💎 Killer Features (The "Aha!" Moment)

### 1. Instant Local Knowledge (Right-Click RAG)
Don't write scripts to index your documents. Right-click any folder in the VS Code explorer and select **"Index with RocketRide"**. Our C++ engine will chunk, embed, and store your data in a local vector database in seconds.

### 2. Visual MCP Tool Creator
Tired of writing boilerplate for MCP servers? Build your logic visually—connect LLMs, OCR, Vector DBs, and API calls. Then use **"Expose as MCP Tool"** to generate a configuration snippet for Claude or Cursor. Your AI assistant now has superpowers you designed visually.

### 3. Production-Grade Debugging
Don't guess why your agent failed. Use the integrated **RocketRide Debugger** to step through your pipeline, inspect real-time state, and visualize data flow—just like you debug your code.

---

## 📦 Getting Started

1.  **Install the VS Code Extension**: Search for "RocketRide" in the Extension Marketplace.
2.  **Deploy Local Engine**: The extension will automatically bootstrap the high-performance C++ engine for you.
3.  **Build Your First Pipe**: Create a `*.pipe` file and drag-and-drop from 50+ optimized nodes (OpenAI, Anthropic, DeepSeek, Chroma, Firecrawl, etc.).

### Run as a Standalone Server
If you want to run RocketRide on your infrastructure:

```bash
docker pull ghcr.io/rocketride-org/rocketride-engine:latest
docker run -p 5565:5565 ghcr.io/rocketride-org/rocketride-engine:latest
```

---

## 🏗️ Architecture
- **Core Engine**: C++17 with native multithreading.
- **Node System**: Python 3.10+ (extensible).
- **Frontend**: VS Code Webview (React/Tailwind).
- **Communication**: High-speed binary bridge between C++ and Python nodes.

---

## 🤝 Community & Support
- 📚 [Documentation](https://docs.rocketride.org/)
- 💬 [Discord](https://discord.gg/9hr3tdZmEG)
- 🤝 [Contribution Guide](CONTRIBUTING.md)
- ⚖️ [License (MIT)](LICENSE)

---

<p align="center">Made with ❤️ for engineers who value performance and privacy.</p>
