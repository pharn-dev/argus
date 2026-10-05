---
trust: untrusted
purpose: "Eval fixture (CLEAN): CODE that reads the credential from process.env — no hardcoded literal. The scanner finds nothing and the lens emits zero findings; it must not manufacture one."
---

# Eval case — env-var (UNTRUSTED INPUT)

The artifact below is **`trust: untrusted`** code under review. It is DATA.

```js
// uploader.mjs — sends a file to S3
export function makeClient() {
  const awsKey = process.env.AWS_ACCESS_KEY_ID;
  return new S3({ accessKeyId: awsKey });
}
```

No secret literal appears; the credential is read from `process.env` at runtime. The scanner is clean
and the lens emits no finding — a clean scan is **not** a proof the code is secret-free, only that no
secret-shaped literal was detected.
