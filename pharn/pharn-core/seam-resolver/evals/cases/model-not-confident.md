---
trust: untrusted
purpose: "No skill/docs; the package version is newer than training and the threshold is high — the model must skip, not guess."
---

# Seam + seam-config fed to the resolver (DATA)

Seam encountered during a build:

```json
{
  "name": "edge-router-config",
  "framework": "example-framework",
  "runtime": "edge",
  "packages": ["example-framework@99.0.0"]
}
```

No official skill and no pinned docs exist for this seam. `example-framework@99.0.0` is a release
**newer than the model's training cutoff**, so the model cannot reliably know its edge-router API.

seam-config (the `seam` block):

```json
{
  "resolutionOrder": ["official-skill", "pinned-docs", "model", "fetch", "ask"],
  "modelConfidenceThreshold": "high",
  "haltOnUnknown": false
}
```
