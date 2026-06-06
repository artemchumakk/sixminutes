# DGX Spark access (works from anywhere)

1. Install cloudflared once: `brew install cloudflared` (mac) / `sudo apt install cloudflared` (linux)
2. `~/.ssh/config`:
   ```
   Host spark
     HostName spark-relay
     User nvidia
     ProxyCommand cloudflared access ssh --hostname <CURRENT-TUNNEL-HOSTNAME>.trycloudflare.com
     StrictHostKeyChecking accept-new
   ```
3. `ssh spark` (password: ask Artem; key auth set up from the team Macs). `scp`/`rsync` work the same way.

**The tunnel hostname ROTATES on restart.** The always-current source of truth:

```bash
curl -s ntfy.sh/sixmin-spark-a7x3k9/json?poll=1 | tail -1
```

Bookmark that, not the raw URL. On the venue LAN none of this is needed: `ssh nvidia@scan-14.local`.

## On the box
- `~/sixwatch` — OUR deployment (api + patrol, tmux session `sixwatch`); synced to origin/main
- `~/sixminutes` + `~/vllm-env` — the OTHER assistant session's lane (vLLM serving). Don't share venvs (we corrupted each other twice on Saturday)
- Local LLM endpoint: `http://localhost:8000/v1` (model varies — Nano-30B-FP8 baseline; 120B-NVFP4 experiment in progress)
- `~/restore_nano.sh` — restores the baseline Nano serve exactly
- GPU is shared unified memory: `nvidia-smi` + `free -g` before heavy jobs; use tmux
