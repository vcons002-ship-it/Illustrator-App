# vLLM setup — true parallel sub-agents on one GPU (e.g. a 5090)

This is the optional infrastructure that makes the assistant's **parallel sub-agents** (`spawn_agents`)
actually run **concurrently on a single GPU**, instead of taking turns.

## Why vLLM

The app is the *orchestrator*: it decides to split a job into independent subtasks and fires them at
once (capped by **Settings → Parallel sub-agents**). Whether those requests truly overlap on the GPU
is the **inference server's** job — via **continuous batching** (many requests share one set of model
weights) and a **KV cache** (each request keeps its attention state, so concurrent requests don't
recompute). **vLLM** does both, well. Ollama/LM Studio in their default single-stream mode just queue
requests (correct, but no speedup).

Recommended **two-tier** layout for a 32 GB card:
- **Main model** (your existing Settings → text provider): a strong reasoner — e.g. **Qwen3-30B-A3B**
  (MoE: 30B quality, ~3B active = fast, ~18 GB at Q4) or a 14B.
- **Worker model** (this vLLM server): a small fast model for the parallel simple subtasks — e.g.
  **Qwen3-4B** (~3 GB) — served with high concurrency.

Both fit in 32 GB with room for KV cache. Point the app's **Sub-agent "worker" model** setting at the
vLLM server and it routes sub-agents there automatically.

---

## 1. Prerequisites

- NVIDIA GPU + recent driver (CUDA 12.x). `nvidia-smi` should work.
- Python 3.10–3.12. **Linux/WSL2 is strongly recommended** — vLLM's native CUDA path is much smoother
  there than on bare Windows.
- ~10–20 GB free disk for model weights.

## 2. Install vLLM

```bash
python -m venv .vllm && source .vllm/bin/activate    # (Windows: use WSL2)
pip install --upgrade pip
pip install vllm
```

## 3. Serve a small, fast, tool-capable worker model

Qwen3-4B is a good default (strong tool-calling for its size). It exposes an **OpenAI-compatible** API
that this app speaks directly.

```bash
vllm serve Qwen/Qwen3-4B \
  --port 8000 \
  --max-model-len 8192 \                 # short contexts → more room for concurrent KV cache
  --gpu-memory-utilization 0.45 \        # leave VRAM for your MAIN model (raise if vLLM is alone)
  --max-num-seqs 8 \                     # how many requests batch together (≈ your concurrency)
  --enable-auto-tool-choice \            # tool-calling
  --tool-call-parser hermes              # parser for Qwen-style tool calls
```

Notes:
- `--gpu-memory-utilization` is the **key knob** for the two-tier layout: cap vLLM so your main model
  still fits. If vLLM is the *only* thing on the GPU, raise it toward `0.9`.
- `--max-num-seqs` is roughly "how many sub-agents run together" — match it to the app's **Parallel
  sub-agents** setting (start at 4–8).
- Short `--max-model-len` (e.g. 8192) keeps KV-cache-per-request small, so more run at once. Sub-agent
  tasks are short, so this is fine.

Quick smoke test:

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen3-4B","messages":[{"role":"user","content":"say hi"}]}'
```

## 4. Point the app at it

In the desktop app → **Settings**:
- **Sub-agent "worker" model (advanced)**
  - Endpoint: `http://localhost:8000/v1`
  - Model id: `Qwen/Qwen3-4B`  *(must match what `vllm serve` loaded)*
- **Parallel sub-agents**: set to match `--max-num-seqs` (e.g. 4–6).
- Leave your **main** text provider as your strong reasoner.

That's it — when the assistant fans work out, the subtasks now run **concurrently** on the worker
model via vLLM, while the main model handles synthesis. If the vLLM server is down, sub-agents fall
back to the main model automatically.

---

## Alternatives (lighter, less throughput)

- **llama.cpp server** with batching:
  ```bash
  llama-server -m qwen3-4b-q4_k_m.gguf --port 8000 --parallel 4 -c 8192 -ngl 99
  ```
  Endpoint: `http://localhost:8000/v1`. Decent concurrent decode; simpler than vLLM, lower throughput.
- **Ollama** with parallelism: set `OLLAMA_NUM_PARALLEL=4` before `ollama serve`, endpoint
  `http://localhost:11434/v1`, model id e.g. `qwen3:4b`. Easiest to run; batching is more limited.

## Tuning cheatsheet

| Want | Change |
|---|---|
| More parallel sub-agents | ↑ `--max-num-seqs` **and** the app's Parallel sub-agents setting |
| vLLM crowding out the main model | ↓ `--gpu-memory-utilization` |
| Out-of-memory under load | ↓ `--max-model-len` or `--max-num-seqs` (KV cache is the usual culprit) |
| Faster simple subtasks | use a smaller worker model (Qwen3-1.7B) |
| Better tool-calling reliability | use a slightly bigger worker (Qwen3-8B) or the main model |

## VRAM budget (32 GB, Q4, rough)

| Combo | Weights | Notes |
|---|---|---|
| Qwen3-30B-A3B (main) + Qwen3-4B (worker) | ~18 + ~3 GB | best quality; ~10 GB left for KV |
| Qwen3-14B (main) + Qwen3-4B (worker) | ~9 + ~3 GB | more headroom → higher worker concurrency |
| Worker-only, max throughput | Qwen3-4B (~3 GB) | the rest of VRAM = KV cache for many parallel seqs |
