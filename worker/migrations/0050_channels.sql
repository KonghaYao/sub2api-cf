PRAGMA foreign_keys = ON;

-- Channels are a user-facing catalog boundary, not a provider credential or
-- routing cache. Keep their public metadata normalized so the available-
-- channels hot path can filter by group access without decoding JSON blobs.
CREATE TABLE channels (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 128),
  name TEXT NOT NULL COLLATE NOCASE
    CHECK (length(trim(name)) BETWEEN 1 AND 128),
  description TEXT NOT NULL DEFAULT ''
    CHECK (length(description) <= 4096),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  billing_model_source TEXT NOT NULL DEFAULT 'channel_mapped'
    CHECK (billing_model_source IN (
      'requested', 'upstream', 'channel_mapped', 'response_model'
    )),
  restrict_models INTEGER NOT NULL DEFAULT 0
    CHECK (restrict_models IN (0, 1)),
  features_config_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      length(features_config_json) BETWEEN 2 AND 65536
      AND CASE
        WHEN json_valid(features_config_json)
          THEN json_type(features_config_json) = 'object'
        ELSE 0
      END
    ),
  apply_pricing_to_account_stats INTEGER NOT NULL DEFAULT 0
    CHECK (apply_pricing_to_account_stats IN (0, 1)),
  control_version INTEGER NOT NULL DEFAULT 0
    CHECK (control_version BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL
    CHECK (
      updated_at_ms BETWEEN created_at_ms AND 9007199254740991
    )
) STRICT;

CREATE UNIQUE INDEX idx_channels_name
  ON channels(name COLLATE NOCASE);

CREATE INDEX idx_channels_available
  ON channels(status, name COLLATE NOCASE, id)
  WHERE status = 'active';

-- A group belongs to at most one display channel. This makes the public
-- projection deterministic and lets a group-scoped lookup find its channel
-- through a single indexed probe.
CREATE TABLE channel_groups (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (channel_id, group_id)
) STRICT;

CREATE UNIQUE INDEX idx_channel_groups_one_channel_per_group
  ON channel_groups(group_id);

CREATE INDEX idx_channel_groups_channel
  ON channel_groups(channel_id, group_id);

-- Nullable prices preserve the distinction between an explicit zero and a
-- missing display price. Monetary values are exact integers; floating-point
-- USD values are derived only at the HTTP boundary.
CREATE TABLE channel_model_pricing (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 128),
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  platform TEXT NOT NULL
    CHECK (length(trim(platform)) BETWEEN 1 AND 64),
  billing_mode TEXT NOT NULL DEFAULT 'token'
    CHECK (billing_mode IN ('token', 'per_request', 'image', 'video')),
  input_micros_per_million INTEGER
    CHECK (input_micros_per_million BETWEEN 0 AND 9007199254740991),
  output_micros_per_million INTEGER
    CHECK (output_micros_per_million BETWEEN 0 AND 9007199254740991),
  cache_write_micros_per_million INTEGER
    CHECK (cache_write_micros_per_million BETWEEN 0 AND 9007199254740991),
  cache_write_1h_micros_per_million INTEGER
    CHECK (cache_write_1h_micros_per_million BETWEEN 0 AND 9007199254740991),
  cache_read_micros_per_million INTEGER
    CHECK (cache_read_micros_per_million BETWEEN 0 AND 9007199254740991),
  image_input_micros_per_million INTEGER
    CHECK (image_input_micros_per_million BETWEEN 0 AND 9007199254740991),
  image_output_micros_per_million INTEGER
    CHECK (image_output_micros_per_million BETWEEN 0 AND 9007199254740991),
  per_request_micros INTEGER
    CHECK (per_request_micros BETWEEN 0 AND 9007199254740991),
  fast_multiplier_ppm INTEGER
    CHECK (fast_multiplier_ppm BETWEEN 0 AND 9007199254740991),
  flex_multiplier_ppm INTEGER
    CHECK (flex_multiplier_ppm BETWEEN 0 AND 9007199254740991),
  time_pricing_json TEXT
    CHECK (
      time_pricing_json IS NULL
      OR (
        length(time_pricing_json) BETWEEN 2 AND 65536
        AND CASE
          WHEN json_valid(time_pricing_json)
            THEN json_type(time_pricing_json) = 'object'
          ELSE 0
        END
      )
    ),
  control_version INTEGER NOT NULL DEFAULT 0
    CHECK (control_version BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL
    CHECK (
      updated_at_ms BETWEEN created_at_ms AND 9007199254740991
    )
) STRICT;

CREATE INDEX idx_channel_model_pricing_available
  ON channel_model_pricing(channel_id, platform, billing_mode, id);

-- A price may cover concrete names or suffix-wildcard patterns. NOCASE on the
-- pattern makes duplicate model identities impossible within one price row.
CREATE TABLE channel_pricing_models (
  pricing_id TEXT NOT NULL
    REFERENCES channel_model_pricing(id) ON DELETE CASCADE,
  model_pattern TEXT NOT NULL COLLATE NOCASE
    CHECK (length(trim(model_pattern)) BETWEEN 1 AND 256),
  is_wildcard INTEGER NOT NULL DEFAULT 0
    CHECK (is_wildcard IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0
    CHECK (sort_order BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (pricing_id, model_pattern),
  CHECK (
    (is_wildcard = 0 AND instr(model_pattern, '*') = 0)
    OR (
      is_wildcard = 1
      AND substr(model_pattern, -1, 1) = '*'
      AND instr(substr(model_pattern, 1, length(model_pattern) - 1), '*') = 0
    )
  )
) STRICT;

CREATE INDEX idx_channel_pricing_models_read
  ON channel_pricing_models(pricing_id, is_wildcard, sort_order, model_pattern);

-- Token and per-request tiers stay ordered and exact. Multiplier fields are
-- PPM values so billing never depends on SQLite REAL arithmetic.
CREATE TABLE channel_pricing_intervals (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 128),
  pricing_id TEXT NOT NULL
    REFERENCES channel_model_pricing(id) ON DELETE CASCADE,
  min_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (min_tokens BETWEEN 0 AND 9007199254740991),
  max_tokens INTEGER
    CHECK (
      max_tokens IS NULL
      OR max_tokens BETWEEN min_tokens AND 9007199254740991
    ),
  tier_label TEXT NOT NULL DEFAULT ''
    CHECK (length(tier_label) <= 128),
  input_micros_per_million INTEGER
    CHECK (input_micros_per_million BETWEEN 0 AND 9007199254740991),
  output_micros_per_million INTEGER
    CHECK (output_micros_per_million BETWEEN 0 AND 9007199254740991),
  cache_write_micros_per_million INTEGER
    CHECK (cache_write_micros_per_million BETWEEN 0 AND 9007199254740991),
  cache_write_1h_micros_per_million INTEGER
    CHECK (cache_write_1h_micros_per_million BETWEEN 0 AND 9007199254740991),
  cache_read_micros_per_million INTEGER
    CHECK (cache_read_micros_per_million BETWEEN 0 AND 9007199254740991),
  input_multiplier_ppm INTEGER
    CHECK (input_multiplier_ppm BETWEEN 0 AND 9007199254740991),
  output_multiplier_ppm INTEGER
    CHECK (output_multiplier_ppm BETWEEN 0 AND 9007199254740991),
  cache_write_multiplier_ppm INTEGER
    CHECK (cache_write_multiplier_ppm BETWEEN 0 AND 9007199254740991),
  cache_read_multiplier_ppm INTEGER
    CHECK (cache_read_multiplier_ppm BETWEEN 0 AND 9007199254740991),
  per_request_micros INTEGER
    CHECK (per_request_micros BETWEEN 0 AND 9007199254740991),
  sort_order INTEGER NOT NULL DEFAULT 0
    CHECK (sort_order BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL
    CHECK (
      updated_at_ms BETWEEN created_at_ms AND 9007199254740991
    )
) STRICT;

CREATE INDEX idx_channel_pricing_intervals_read
  ON channel_pricing_intervals(pricing_id, sort_order, id);

-- Store model rewrites as rows rather than an opaque platform -> mapping JSON
-- object. Wildcard flags are redundant by design: CHECK constraints validate
-- the pattern once and let hot reads branch without reparsing it.
CREATE TABLE channel_model_mappings (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  platform TEXT NOT NULL
    CHECK (length(trim(platform)) BETWEEN 1 AND 64),
  source_pattern TEXT NOT NULL COLLATE NOCASE
    CHECK (length(trim(source_pattern)) BETWEEN 1 AND 256),
  target_pattern TEXT NOT NULL DEFAULT ''
    CHECK (length(target_pattern) <= 256),
  source_is_wildcard INTEGER NOT NULL DEFAULT 0
    CHECK (source_is_wildcard IN (0, 1)),
  target_is_wildcard INTEGER NOT NULL DEFAULT 0
    CHECK (target_is_wildcard IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0
    CHECK (sort_order BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (channel_id, platform, source_pattern),
  CHECK (
    (source_is_wildcard = 0 AND instr(source_pattern, '*') = 0)
    OR (
      source_is_wildcard = 1
      AND substr(source_pattern, -1, 1) = '*'
      AND instr(substr(source_pattern, 1, length(source_pattern) - 1), '*') = 0
    )
  ),
  CHECK (
    (target_pattern = '' AND target_is_wildcard = 0)
    OR (
      target_pattern <> ''
      AND (
        (target_is_wildcard = 0 AND instr(target_pattern, '*') = 0)
        OR (
          target_is_wildcard = 1
          AND substr(target_pattern, -1, 1) = '*'
          AND instr(substr(target_pattern, 1, length(target_pattern) - 1), '*') = 0
        )
      )
    )
  )
) STRICT;

CREATE INDEX idx_channel_model_mappings_read
  ON channel_model_mappings(
    channel_id, platform, source_is_wildcard, sort_order, source_pattern
  );

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (50, 'channels', CAST(unixepoch('subsec') * 1000 AS INTEGER));
