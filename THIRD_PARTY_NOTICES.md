# Third-party notices

DevOS is proprietary (see `LICENSE`). It includes code adapted from the third-party projects below,
used under their licences. Each adapted file carries a header naming its source file and commit.

## ruflo

- **Project:** ruflo (formerly claude-flow), https://github.com/ruvnet/ruflo
- **Commit:** a3d45e64b9ce66d3a172c8051e8b20561321eb64 (v3.70.0)
- **Licence:** MIT (repository `LICENSE` at that commit; the `v3/@claude-flow/security` package declares no other licence). Re-checked 6 Nov 2026 for DEVOS-57.
- **Adapted into** `packages/policy/src/` (M1.7, ADR-0006):
  - `canonical.ts` ← `v3/@claude-flow/security/src/policy/canonical.ts`
  - `envelope.ts` ← `v3/@claude-flow/security/src/policy/envelope.ts`
  - `evaluator.ts` ← `v3/@claude-flow/security/src/policy/evaluator.ts`
  - `engine.ts`, `receipts.ts` ← `v3/@claude-flow/security/src/policy/engine.ts`
- **Not used:** `product-plane.ts`, MetaHarness, federation and CLI code.

```
MIT License

Copyright (c) 2024-2026 ruvnet

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
