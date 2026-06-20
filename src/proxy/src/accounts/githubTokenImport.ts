import type { BatchResult, ImportGithubTokenRow } from '@ghcp/shared';
import { HttpApiError, newBatchId, nowIso } from '@ghcp/shared';
import { getSsoUser } from '../clients/ssoClient.js';
import { importGithubToken, toAccountDto } from '../db/accountsRepo.js';

interface ImportRow {
  line: number;
  name: string;
  githubToken: string;
}

interface ParseError {
  line: number;
  name: string;
  error: string;
}

export async function importGithubTokens(csvText: string): Promise<BatchResult<ImportGithubTokenRow>> {
  const startedAt = nowIso();
  const parsed = parseGithubTokenCsv(csvText);
  const rows: ImportGithubTokenRow[] = [];
  for (const row of parsed.rows) {
    rows.push(await importGithubTokenRow(row));
  }
  for (const error of parsed.errors) {
    rows.push({
      line: error.line,
      name: error.name,
      status: 'failed',
      detail: error.error,
    });
  }
  rows.sort((left, right) => left.line - right.line);
  const failed = rows.filter((row) => row.status === 'failed').length;
  return {
    batchId: newBatchId(),
    startedAt,
    finishedAt: nowIso(),
    summary: { total: rows.length, success: rows.length - failed, failed },
    rows,
  };
}

async function importGithubTokenRow(row: ImportRow): Promise<ImportGithubTokenRow> {
  try {
    const ssoUser = await getSsoUser(row.name);
    const account = importGithubToken({
      identity: row.name,
      ssoUser: ssoUser.ssoUser,
      ghLogin: ssoUser.ghLogin ?? row.name,
      ghToken: row.githubToken,
    });
    return {
      line: row.line,
      name: row.name,
      status: 'success',
      detail: ssoUser.ghLogin ? 'GitHub token imported and existing token was overwritten.' : 'GitHub token imported with name as GH login fallback; sync SSO to GH to confirm ghLogin.',
      account: toAccountDto(account),
    };
  } catch (err) {
    return {
      line: row.line,
      name: row.name,
      status: 'failed',
      detail: importErrorMessage(err, row.name),
    };
  }
}

function importErrorMessage(err: unknown, name: string): string {
  if (err instanceof HttpApiError && err.status === 404) return `SSO user "${name}" was not found. Create it manually in SSO Users before importing this token.`;
  return err instanceof Error ? err.message : String(err);
}

function parseGithubTokenCsv(text: string): { rows: ImportRow[]; errors: ParseError[] } {
  const rows: ImportRow[] = [];
  const errors: ParseError[] = [];
  const seen = new Set<string>();
  let headerChecked = false;
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    if (!rawLine.trim()) return;
    let values: string[];
    try {
      values = parseCsvLine(rawLine);
    } catch (err) {
      errors.push({ line, name: '', error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!headerChecked) {
      headerChecked = true;
      if (!isHeader(values)) {
        errors.push({ line, name: values[0]?.trim() ?? '', error: 'CSV header must be exactly: name,githubToken' });
        return;
      }
      return;
    }
    if (values.length !== 2) {
      errors.push({ line, name: values[0]?.trim() ?? '', error: 'Expected two columns: name,githubToken' });
      return;
    }
    const name = values[0]!.trim();
    const githubToken = values[1]!.trim();
    if (!name) {
      errors.push({ line, name, error: 'name is required.' });
      return;
    }
    if (!githubToken) {
      errors.push({ line, name, error: 'githubToken is required.' });
      return;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      errors.push({ line, name, error: `Duplicate name "${name}" in import CSV.` });
      return;
    }
    seen.add(key);
    rows.push({ line, name, githubToken });
  });
  if (!headerChecked) errors.push({ line: 1, name: '', error: 'CSV header is required: name,githubToken' });
  return { rows, errors };
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (quoted) throw new Error('Unclosed quoted value');
  values.push(current);
  return values;
}

function isHeader(values: string[]): boolean {
  return values.length === 2
    && values[0]!.trim() === 'name'
    && values[1]!.trim() === 'githubToken';
}
