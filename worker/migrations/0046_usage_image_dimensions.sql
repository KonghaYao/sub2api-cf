PRAGMA foreign_keys = ON;

-- Retain the image billing evidence needed by the legacy usage-log contract.
-- The compact JSON breakdown is bounded and validated again at queue ingress.
ALTER TABLE usage_projection ADD COLUMN image_count INTEGER NOT NULL DEFAULT 0
  CHECK (image_count >= 0 AND image_count <= 100);
ALTER TABLE usage_projection ADD COLUMN image_size TEXT
  CHECK (image_size IS NULL OR image_size IN ('1K', '2K', '4K', 'mixed'));
ALTER TABLE usage_projection ADD COLUMN image_input_size TEXT
  CHECK (image_input_size IS NULL OR length(image_input_size) <= 32);
ALTER TABLE usage_projection ADD COLUMN image_output_size TEXT
  CHECK (image_output_size IS NULL OR length(image_output_size) <= 32);
ALTER TABLE usage_projection ADD COLUMN image_size_source TEXT
  CHECK (image_size_source IS NULL OR image_size_source IN ('output', 'input', 'default', 'legacy'));
ALTER TABLE usage_projection ADD COLUMN image_size_breakdown TEXT
  CHECK (image_size_breakdown IS NULL OR (length(image_size_breakdown) <= 256 AND json_valid(image_size_breakdown)));

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (46, 'usage_image_dimensions', CAST(unixepoch('subsec') * 1000 AS INTEGER));
