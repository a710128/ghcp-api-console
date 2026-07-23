/**
 * PostgreSQL implementation of the SSO budget cache repository.
 * Removes raw_json; only stores fields consumed by DTOs.
 */
import type { AiCreditsPeriodUsageDto } from '@ghcp/shared';
import { getGeneralPool } from './pool.js';

export interface AiCreditsUsageCacheRecord extends AiCreditsPeriodUsageDto {
  // rawJson removed per plan spec
}

interface BudgetCacheRow {
  period_key: string;
  year: number;
  month: number;
  quantity: number;
  unit_type: string | null;
  fetched_at: Date;
}

function mapRow(row: BudgetCacheRow): AiCreditsUsageCacheRecord {
  return {
    year: row.year,
    month: row.month,
    quantity: row.quantity,
    unitType: row.unit_type ?? undefined,
    fetchedAt: row.fetched_at.toISOString(),
  };
}

function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export async function getAiCreditsUsagePeriod(year: number, month: number): Promise<AiCreditsUsageCacheRecord | undefined> {
  const pool = getGeneralPool();
  const res = await pool.query<BudgetCacheRow>('SELECT * FROM sso.budget_cache WHERE period_key = $1', [periodKey(year, month)]);
  return res.rows[0] ? mapRow(res.rows[0]) : undefined;
}

export async function saveAiCreditsUsagePeriod(input: AiCreditsUsageCacheRecord): Promise<AiCreditsUsageCacheRecord> {
  const pool = getGeneralPool();
  await pool.query(
    `INSERT INTO sso.budget_cache (period_key, year, month, quantity, unit_type, fetched_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT(period_key) DO UPDATE SET
       year = EXCLUDED.year,
       month = EXCLUDED.month,
       quantity = EXCLUDED.quantity,
       unit_type = EXCLUDED.unit_type,
       fetched_at = now()`,
    [periodKey(input.year, input.month), input.year, input.month, input.quantity, input.unitType ?? null],
  );
  return input;
}

export async function countAssignedCopilotSeats(): Promise<number> {
  const pool = getGeneralPool();
  const res = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM sso.users WHERE copilot_seat_status = 'assigned'`);
  return parseInt(res.rows[0]!.count, 10);
}

/**
 * TTL cleanup: delete budget periods older than previous UTC month.
 */
export async function cleanupOldBudgetPeriods(): Promise<number> {
  const pool = getGeneralPool();
  const now = new Date();
  const prevMonth = now.getMonth() === 0 ? 12 : now.getMonth();
  const prevYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const cutoff = periodKey(prevYear, prevMonth);
  const res = await pool.query(`DELETE FROM sso.budget_cache WHERE period_key < $1`, [cutoff]);
  return res.rowCount ?? 0;
}
