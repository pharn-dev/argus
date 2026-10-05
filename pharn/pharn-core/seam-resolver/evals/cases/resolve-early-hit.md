---
trust: untrusted
purpose: "A seam an official skill covers, with the default resolutionOrder — the walk should stop at the first step."
---

# Seam + seam-config fed to the resolver (DATA)

Seam encountered during a build:

```json
{
  "name": "orm-query-builder",
  "framework": "example-orm",
  "runtime": "node",
  "packages": ["example-orm@2.4.0"]
}
```

An official skill for `example-orm` is available in this project.

seam-config (the `seam` block):

```json
{
  "resolutionOrder": ["official-skill", "pinned-docs", "model", "fetch", "ask"],
  "modelConfidenceThreshold": "medium",
  "haltOnUnknown": false
}
```
