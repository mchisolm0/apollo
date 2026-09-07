import { performance } from "node:perf_hooks";
import { marked } from "marked";
import { parser } from "markdown-to-jsx";

const markdown = Array.from({ length: 80 }, (_, index) => `## Heading ${index}

Paragraph with **bold**, [link](https://example.com/${index}), and ![image](https://example.com/${index}.png).

- item one
- item two

\`\`\`ts
const value = ${index};
\`\`\`

| a | b |
|---|---|
| ${index} | text |`).join("\n\n");

function measure(name, operation) {
  for (let index = 0; index < 10; index += 1) operation();
  const samples = [];
  for (let index = 0; index < 30; index += 1) {
    const start = performance.now();
    operation();
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  return {
    name,
    bytes: Buffer.byteLength(markdown),
    warmups: 10,
    iterations: 30,
    medianMs: Number(samples[15].toFixed(3)),
    p95Ms: Number(samples[28].toFixed(3)),
    minMs: Number(samples[0].toFixed(3)),
  };
}

console.log(JSON.stringify({
  runtime: process.version,
  corpus: "80 repeated mixed Markdown blocks: headings, prose, emphasis, links, images, lists, TypeScript fences and GFM tables",
  results: [
    measure("marked@18.0.11 lexer", () => marked.lexer(markdown)),
    measure("markdown-to-jsx@9.10.2 parser", () => parser(markdown)),
  ],
}, null, 2));
