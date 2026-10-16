import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BatchForNotify } from './import-batch-notify'

// 🔴 RE-READ, NEVER REUSE THE PRE-ACTION SNAPSHOT. loaded_at, status
// and approved_at are written by the RPC the route just called. A mail
// built from the row as the request first saw it would describe the
// batch as it was BEFORE the thing it is announcing happened — a load
// notification with loaded_at empty, or a rejection quoting the old
// status. One function, so all three routes read it the same way.
export async function batchForNotify(
  db: SupabaseClient,
  batchId: number,
): Promise<BatchForNotify | null> {
  const { data, error } = await db.from('import_batches')
    .select('id, company_id, property_id, source_filename, attested_by_user_id, ' +
            'attested_name, attested_title, attested_at, approved_by, approved_at, loaded_at')
    .eq('id', batchId).maybeSingle()
  if (error || !data) {
    console.error(`[import-batch-notify] could not re-read batch ${batchId}:`, error?.message ?? 'no row')
    return null
  }
  const row = data as unknown as Record<string, unknown>
  const co = await db.from('companies').select('name').eq('id', row.company_id as number).maybeSingle()
  const pr = await db.from('properties').select('name').eq('id', row.property_id as number).maybeSingle()
  // 🔴 A missing name is named as missing, not blanked. "Batch #57
  // loaded:  / " reads as a rendering bug; "company 90" reads as the
  // fact that the lookup missed, which is what it is.
  return {
    ...row,
    company_name: String(co.data?.name ?? `company ${row.company_id}`),
    property_name: String(pr.data?.name ?? `property ${row.property_id}`),
  } as BatchForNotify
}
