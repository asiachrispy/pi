# pi-memory

Project-local, branch-aware memory for Pi with human-memory-inspired forgetting.

## Features

- **~130 tokens/round** — compact index injection, 97% less than full-context
- **Project-level persistence** — survives new sessions via `.pi/memory.jsonl`
- **Branch isolation** — each fork has independent memory
- **Forgetting curve** — 21 days no access → dormant → forgotten
- **Spaced repetition** — each access resets the forgetting clock
- **Memory consolidation** — importance 4-5 resists forgetting (60 days)
- **5 tools** — `memory_set`, `memory_get`, `memory_search`, `memory_list`, `memory_delete`
- **4 commands** — `/memory list`, `/memory list --all`, `/memory delete`, `/memory clean`
- **Zero external deps** — Node.js built-ins only

## Install

```bash
pi install git:github.com/asiachrispy/pi@memory-v1.0.0
```

## Usage

```
User: "Remember: our staging API is https://staging-api.example.com"
Agent: [calls memory_set("staging_api", "...", "fact")]

User: "What's our staging URL?"
Agent: [calls memory_get("staging_api")] → "https://staging-api.example.com"

/memory list       # active + dormant
/memory list --all # all (including forgotten)
/memory clean      # remove stale
```
