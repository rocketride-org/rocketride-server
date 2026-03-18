# RocketRide Project Rules & Strategy (Gemini CLI)

## 🚀 Strategic Vision (The Pivot)
- **Identity:** High-performance, IDE-native AI orchestration for Senior Engineers.
- **Killer Features:** 
  - "Right-click to Index" (The Trojan Horse).
  - "Visual MCP Tool Creator" (The Standard).
- **Core Advantage:** C++17 performance, Zero-copy memory, GIL bypass.
- **Monetization:** "Density Arbitrage" (10x more users per GPU vs Python competitors).

## 🛠 Tech Stack Standards
- **C++:** C++17, focus on memory efficiency via `DataView`.
- **Python:** Python 3.10+, using `pydantic` for models, `eaas.py` for model serving.
- **VS Code:** Webview-based visual builder, custom DAP integration.
- **Communication:** Move towards Shared Memory (Apache Arrow) to kill JSON/WebSocket overhead.

## 📝 Coding Rules
- **Documentation:** Every function needs a docstring explaining "What" and "Why".
- **Performance:** Avoid unnecessary copies between language boundaries.
- **Safety:** No secrets in code. Check `.env` for keys.
- **Testing:** Always run `test/density_benchmark.py` before and after major performance changes.

## 🤖 Interaction Playbook (10x mode)
1. **Plan First:** Always use `enter_plan_mode` for tasks with >3 files.
2. **Review:** Delegate code review to the `generalist` sub-agent for critical C++ logic.
3. **Verify:** Run tests before declaring a task "Done".
4. **Context:** Read this file at the start of every session.

## 🔗 Useful Links
- Reddit Target: `r/LocalLLaMA`, `r/LLMDevs`, `r/Cursor`
- Protocol: Model Context Protocol (MCP)
