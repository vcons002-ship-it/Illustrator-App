# Built-in text model (bundled with the desktop app)

This folder holds the small local text model the desktop app ships and launches
on first use (the "Built-in model" Text option). It is wired up by:

- **`llm-setup.bat`** (repo root) — downloads the two files below into this folder
  before a packaged build, so they get bundled into the installer.
- **`tauri.conf.json`** — `bundle.resources` maps this folder to `llm/` inside the
  app, so the files ship with the installer.
- **`src-tauri/src/main.rs`** — `ensure_llm` resolves `llama-server.exe` +
  the `.gguf` from the bundled resource dir (or `~/VisualReader/llm`), launches the
  server on `127.0.0.1:11435`, and points the renderer's local-server provider at it.

## Files this folder needs (NOT committed — see `.gitignore`)

| File | What | Where it comes from |
|---|---|---|
| `llama-server.exe` (+ its `*.dll`s) | The llama.cpp OpenAI-compatible server (Windows) | A `llama.cpp` release zip (`llama-*-bin-win-*-x64.zip`) |
| `Llama-3.2-3B-Instruct-Q4_K_M.gguf` | The ~3B Q4 model weights (~2 GB) | `bartowski/Llama-3.2-3B-Instruct-GGUF` on Hugging Face |

Run **`llm-setup.bat`** to fetch both. The model id and filename are mirrored in
`packages/core/src/providers/catalog.ts` (`BUNDLED_LLM`) and the Rust consts in
`main.rs` — keep them in sync if you swap the model.

> The Llama 3.2 weights are redistributed under the **Llama 3.2 Community License**
> (include the license + a "Built with Llama" notice when you distribute a build).
> Swap to a more permissively-licensed GGUF (e.g. an MIT-licensed small model) by
> changing the constants above and the URLs in `llm-setup.bat`.
