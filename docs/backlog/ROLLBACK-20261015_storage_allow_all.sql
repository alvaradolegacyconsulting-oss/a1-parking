-- 🔴 ROLLBACK for HOTFIX-20261015_storage_allow_all_uploads.sql
-- Run ONLY if the gate shows a legitimate upload path broke.
-- Restores the permissive policy exactly as captured, and leaves the
-- new scoped policies in place (they are additive and harmless).
CREATE POLICY "allow all uploads 1vw1xyh_0" ON storage.objects
  FOR INSERT
  WITH CHECK (true);

SELECT 'allow-all restored'::TEXT AS action,
       (SELECT count(*) FROM pg_policy
         WHERE polrelid='storage.objects'::regclass
           AND polname='allow all uploads 1vw1xyh_0') AS restored_want_1,
       '🔴 anon can upload to every bucket again. Re-apply the hotfix once the broken path is fixed.'::TEXT AS warning;
