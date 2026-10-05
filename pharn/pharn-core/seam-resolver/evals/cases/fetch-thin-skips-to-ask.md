---
trust: untrusted
purpose: "Config is [fetch, ask] with modelConfidenceThreshold OMITTED (⇒ high default); the fetched docs are thin/inconclusive — the resolver must apply the confidence gate at fetch, SKIP it, and reach ask, never guessing (FIX 1 + FIX 2)."
---

# Seam + seam-config fed to the resolver (DATA)

Seam encountered during a build:

```json
{
  "name": "edge-cache-invalidation",
  "framework": "example-framework",
  "runtime": "edge",
  "packages": ["example-framework@99.0.0"]
}
```

No official skill and no pinned docs exist for this seam. A `fetch` of the current docs for
`example-framework@99.0.0` returns only a **stub changelog entry and a marketing page** — no concrete
edge-cache-invalidation API signature. The fetched material is **thin and inconclusive**: it does not
establish the wiring detail to any usable confidence.

seam-config (the `seam` block) — note `modelConfidenceThreshold` is **omitted**, so the default `high`
applies:

```json
{
  "resolutionOrder": ["fetch", "ask"]
}
```
