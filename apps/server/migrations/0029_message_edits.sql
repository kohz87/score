-- Edit and resend (PLAN 5.24): the corrected message points at the original, the original at the correction.
ALTER TABLE messages ADD COLUMN edited_by TEXT;
ALTER TABLE messages ADD COLUMN edits TEXT;
