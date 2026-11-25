-- Deduplicate any existing linked_addresses collisions before enforcing uniqueness
DELETE FROM linked_addresses
WHERE id NOT IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY address
             ORDER BY is_default DESC, created_at DESC, id DESC
           ) AS rn
    FROM linked_addresses
  )
  WHERE rn = 1
);

DROP INDEX IF EXISTS idx_linked_addresses_address;

CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_addresses_address
  ON linked_addresses(address);

CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_addresses_user_address
  ON linked_addresses(telegram_user_id, address);
