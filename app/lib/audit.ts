import { supabase } from '../supabase'

export async function logAudit({
  action,
  table_name,
  record_id,
  old_values,
  new_values,
  notes
}: {
  action: string
  table_name: string
  record_id?: string
  old_values?: object
  new_values?: object
  notes?: string
}) {
  try {
    const { data: { user } } = await supabase.auth.getUser()
    // B155.2 F4 — audit_logs WITH CHECK enforces self-attribution
    // (lower(user_email) = lower(auth.jwt() ->> 'email')). A NULL or
    // 'unknown' user_email would fail the CHECK and silently drop
    // under the fire-and-forget try/catch. Skip the insert entirely
    // if there's no authenticated session — writing 'unknown' was
    // never a useful audit record.
    if (!user?.email) return
    await supabase.from('audit_logs').insert([{
      user_email: user.email,
      action,
      table_name,
      record_id: record_id || null,
      old_values: old_values || null,
      new_values: new_values || null,
      notes: notes || null,
      created_at: new Date().toISOString()
    }])
  } catch (e) {
    // fire and forget - never block main action
    console.error('Audit log failed:', e)
  }
}
