import assert from "node:assert/strict";
import test from "node:test";

import { pendingCodeHighlight } from "./pendingCodeHighlight.ts";

test("keeps completed colors and exact current text without retaining an edited tail", () => {
  const colored = [
    [{ content: "const n = 1;", color: "red", fontStyle: 0 }],
    [{ content: "partial", color: "blue", fontStyle: 0 }],
  ];
  const result = pendingCodeHighlight(
    "const n = 1;\npartial",
    "const n = 1;\nchanged\nnext",
    colored,
  );
  assert.ok(result);
  assert.equal(result[0], colored[0]);
  assert.equal(
    result.map((line) => line.map((token) => token.content).join("")).join("\n"),
    "const n = 1;\nchanged\nnext",
  );
  assert.ok(
    result
      .slice(1)
      .flat()
      .every((token) => token.color === null),
  );
  assert.equal(
    pendingCodeHighlight("const n = 1;\npartial", "const n = 2;\npartial", colored),
    null,
  );
  assert.equal(pendingCodeHighlight("partial", "other", colored), null);
});
