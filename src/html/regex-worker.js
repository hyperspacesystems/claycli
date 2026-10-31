import { parentPort, workerData } from 'node:worker_threads';

const { html, source, max } = workerData;
const pattern = new RegExp(source, 'g');
let count = 0;
const ranges = [];
for (;;) {
  const match = pattern.exec(html);
  if (!match) break;
  count += 1;
  if (ranges.length < max) ranges.push({ start: match.index, end: match.index + match[0].length });
  if (match[0].length === 0) {
    pattern.lastIndex = match.index + 1;
    if (pattern.lastIndex > html.length) break;
  }
}
parentPort.postMessage({ count, ranges });
