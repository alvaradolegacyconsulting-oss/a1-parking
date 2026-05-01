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
    await supabase.from('audit_logs').insert([{
      user_email: user?.email || 'unknown',
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
