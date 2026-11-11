-- ============================================================================
-- Verification in one submission
-- Run after 001-015. Idempotent, safe to re-run.
-- ============================================================================
--
-- Proof of address and both sides of a government ID used to go in as separate
-- submissions, one at a time. With only one submission allowed under review per
-- person, the second document was refused as "already under review", and
-- approving any one document verified the whole account.
--
-- Now everything goes in together: one submission carries every file in
-- `files`, a reviewer looks at them side by side, and one approval verifies the
-- account. A new full submission replaces one still waiting (the old row is
-- marked superseded), so nobody is stuck behind a half-finished upload.
-- ============================================================================

alter table public.kyc_submissions
  add column if not exists files jsonb not null default '[]'::jsonb;

-- 'full' is a submission carrying every document in `files`.
alter table public.kyc_submissions
  drop constraint if exists kyc_submissions_kind_check;
alter table public.kyc_submissions
  add constraint kyc_submissions_kind_check
  check (kind in ('proof_of_address', 'government_id', 'full'));

-- 'superseded' is a submission replaced by a newer full one before review.
alter table public.kyc_submissions
  drop constraint if exists kyc_submissions_status_check;
alter table public.kyc_submissions
  add constraint kyc_submissions_status_check
  check (status in ('pending', 'approved', 'rejected', 'superseded'));
