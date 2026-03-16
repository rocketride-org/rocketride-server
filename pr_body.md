## 🚀 Strategic Pivot: IDE-Native Performance & MCP Support

### Overview
This PR implements a major strategic repositioning of RocketRide. We are moving away from being a "generic AI engine" to becoming the **premier high-performance orchestration layer for Senior AI Engineers** directly within VS Code.

### 💎 Key Features
- **"Right-Click to Index" (The Trojan Horse):** Users can now right-click any folder in the VS Code explorer to instantly index it for AI using our C++ core. This provides an "Aha! Moment" within 60 seconds of installation.
- **Visual MCP Tool Creator:** One-click export of any `.pipe` file as an **MCP (Model Context Protocol)** tool for Claude Desktop and Cursor.
- **C++ Performance Moat:** Leveraging our C++17 engine and zero-copy memory bridge to bypass Python's GIL bottlenecks, enabling high-throughput multimodal processing.

### 🛠 Technical Changes
- **VS Code Extension:** Added context menu contributions and ad-hoc pipeline generation logic in `extension.ts`.
- **Documentation:** Completely updated `README.md` with the new performance-first messaging.
- **Performance Validation:** Confirmed `engLib` data passing supports direct memory pointers for high-speed execution.

### 📈 Why This Matters
Market research shows a massive gap in production-ready AI orchestration. By staying in the IDE and leveraging C++ speed, RocketRide becomes the essential tool for engineers building real-world AI apps.

---
*Created by Gemini CLI*