-- Passkeys (5.28): WebAuthn credentials that sign a browser in without a pairing link.
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,            -- credential id, base64url
  rp_id TEXT NOT NULL,            -- the domain it was registered for (never an IP address)
  public_key BLOB NOT NULL,       -- COSE public key
  counter INTEGER NOT NULL,       -- last signature counter seen
  transports TEXT NOT NULL,       -- JSON array
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  flagged_at INTEGER              -- set when a sign-count regression suggests a cloned authenticator
);
