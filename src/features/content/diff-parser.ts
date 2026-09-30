export type NativeDiffRow = {
  kind: 'file' | 'hunk' | 'line' | 'notice';
  id: string;
  fileId?: string;
  filePath?: string;
  previousPath?: string | null;
  changeType?: 'modified' | 'new' | 'deleted';
  additions?: number;
  deletions?: number;
  text?: string;
  content?: string;
  change?: 'context' | 'add' | 'delete';
  oldLineNumber?: number | null;
  newLineNumber?: number | null;
};

export type ContentPart =
  | { kind: 'markdown'; text: string }
  | { kind: 'diff'; text: string };

const DIFF_FENCE = /^```(?:diff|patch)\s*\n([\s\S]*?)^```\s*$/gim;

export function splitDiffFences(markdown: string): ContentPart[] {
  const parts: ContentPart[] = [];
  let cursor = 0;
  for (const match of markdown.matchAll(DIFF_FENCE)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ kind: 'markdown', text: markdown.slice(cursor, index) });
    parts.push({ kind: 'diff', text: match[1].replace(/\n$/, '') });
    cursor = index + match[0].length;
  }
  if (cursor < markdown.length) parts.push({ kind: 'markdown', text: markdown.slice(cursor) });
  return parts.length ? parts : [{ kind: 'markdown', text: markdown }];
}

function cleanPath(path: string): string {
  const value = path.split('\t')[0].trim();
  return value === '/dev/null' ? value : value.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(patch: string): NativeDiffRow[] {
  const rows: NativeDiffRow[] = [];
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  let fileId = 'diff:0';
  let filePath = 'Patch';
  let oldPath: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  let fileRowIndex = -1;
  let additions = 0;
  let deletions = 0;

  const finishFile = () => {
    if (fileRowIndex < 0) return;
    rows[fileRowIndex] = { ...rows[fileRowIndex], additions, deletions };
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('diff --git ')) {
      finishFile();
      const match = /^diff --git (?:"?a\/)?(.+?)"? (?:"?b\/)?(.+?)"?$/.exec(line);
      oldPath = cleanPath(match?.[1] ?? 'Patch');
      filePath = cleanPath(match?.[2] ?? oldPath);
      fileId = `diff:${index}:${filePath}`;
      additions = 0;
      deletions = 0;
      fileRowIndex = rows.length;
      rows.push({ kind: 'file', id: `${fileId}:file`, fileId, filePath, previousPath: oldPath, changeType: 'modified', additions: 0, deletions: 0 });
      continue;
    }
    if (line.startsWith('--- ')) {
      oldPath = cleanPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      filePath = cleanPath(line.slice(4));
      if (fileRowIndex < 0) {
        fileId = `diff:${index}:${filePath}`;
        fileRowIndex = rows.length;
        rows.push({ kind: 'file', id: `${fileId}:file`, fileId, filePath, previousPath: oldPath, changeType: oldPath === '/dev/null' ? 'new' : filePath === '/dev/null' ? 'deleted' : 'modified', additions: 0, deletions: 0 });
      } else {
        rows[fileRowIndex] = { ...rows[fileRowIndex], filePath, previousPath: oldPath, changeType: oldPath === '/dev/null' ? 'new' : filePath === '/dev/null' ? 'deleted' : 'modified' };
      }
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      if (fileRowIndex < 0) {
        fileRowIndex = rows.length;
        rows.push({ kind: 'file', id: `${fileId}:file`, fileId, filePath, changeType: 'modified', additions: 0, deletions: 0 });
      }
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: 'hunk', id: `${fileId}:hunk:${index}`, fileId, text: line });
      continue;
    }
    if (fileRowIndex < 0 || /^(?:index |new file mode |deleted file mode |similarity index |rename (?:from|to) )/.test(line) || line === '\\ No newline at end of file') continue;
    const marker = line[0];
    if (marker !== ' ' && marker !== '+' && marker !== '-') continue;
    const change = marker === '+' ? 'add' : marker === '-' ? 'delete' : 'context';
    rows.push({
      kind: 'line', id: `${fileId}:line:${index}`, fileId, content: line.slice(1), change,
      oldLineNumber: change === 'add' ? null : oldLine,
      newLineNumber: change === 'delete' ? null : newLine,
    });
    if (change === 'add') { additions += 1; newLine += 1; }
    else if (change === 'delete') { deletions += 1; oldLine += 1; }
    else { oldLine += 1; newLine += 1; }
  }
  finishFile();
  return rows.length ? rows : [{ kind: 'notice', id: 'diff:notice', text: 'This diff could not be parsed.' }];
}
