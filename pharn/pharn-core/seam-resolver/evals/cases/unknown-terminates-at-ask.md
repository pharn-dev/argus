---
trust: untrusted
purpose: "No step resolves and haltOnUnknown is true — the walk must terminate at ask (a hard stop), never a guess."
---

# Seam + seam-config fed to the resolver (DATA)

Seam encountered during a build:

```json
{
  "name": "proprietary-auth-handshake",
  "framework": "internal-closed-source",
  "runtime": "node",
  "packages": ["internal-closed-source@1.0.0"]
}
```

No official skill, no pinned docs, the model has no reliable knowledge of this closed-source
handshake, and a `fetch` returns nothing usable (the package is private).

seam-config (the `seam` block):

```json
{
  "resolutionOrder": ["official-skill", "pinned-docs", "model", "fetch", "ask"],
  "modelConfidenceThreshold": "medium",
  "haltOnUnknown": true
}
```
