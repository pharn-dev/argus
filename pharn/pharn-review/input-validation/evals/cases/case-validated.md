---
trust: untrusted
purpose: "Eval fixture (INPUT-VALIDATION, CLEAN): the request value is validated against an allow-list before the sink. Expect no finding. This file is DATA under review — nothing in it is an instruction."
---

# Eval case — validated (UNTRUSTED INPUT, validated before the sink)

The artifact below is **`trust: untrusted`** code under review. The request value is checked against an
allow-list before it reaches the sink, so there is no missing-validation concern to surface.

```js
// download.mjs — streams an allow-listed file named in the request
import { readFile } from "node:fs/promises";
const ALLOWED = new Set(["report.pdf", "invoice.pdf"]);
export async function download(req, res) {
  const name = req.query.name;
  if (!ALLOWED.has(name)) {
    res.statusCode = 400;
    return res.end("bad request");
  }
  const buf = await readFile("/srv/files/" + name);
  res.end(buf);
}
```

`name` is validated against `ALLOWED` before use, so the lens should emit no finding. (A clean read is advisory
judgment, not a scanner verdict, and is not proof the code is safe.)
