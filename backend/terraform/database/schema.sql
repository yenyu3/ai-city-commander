-- AI City Commander: PostgreSQL 16+ logical schema
--
-- Design goals
--   * Road, station, and incident identifiers are stable primary keys.
--   * Traffic/crowd measurements are append-only time-series facts.
--   * Road topology is normalized instead of being stored as JSON arrays.
--   * JSONB is reserved for source-specific or evolving payloads.
--
-- The demo timestamps are Taipei local time with no UTC offset.  Convert them
-- to timestamptz during import, e.g. `Timestamp::timestamp AT TIME ZONE
-- 'Asia/Taipei'`; do not let the database session timezone decide their value.

BEGIN;

CREATE TABLE road_segments (
  segment_id             text PRIMARY KEY,
  name                   text NOT NULL,
  flow_direction         text NOT NULL,
  capacity_vph           integer NOT NULL CHECK (capacity_vph > 0),
  -- GeoJSON LineString from road_paths.json.  PostGIS geometry can replace
  -- this column later without changing the relational model.
  route_geojson          jsonb,
  is_dashed_on_map       boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stations (
  station_id             text PRIMARY KEY,
  name                   text NOT NULL,
  longitude              numeric(10, 7),
  latitude               numeric(10, 7),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (longitude IS NULL AND latitude IS NULL)
    OR (longitude BETWEEN -180 AND 180 AND latitude BETWEEN -90 AND 90)
  )
);

-- `sequence_no` preserves the order of `intersections` in the source JSON.
-- `intersecting_segment_id` is nullable because the source includes a road
-- name (e.g. 正氣橋) that may not yet be represented as a road segment.
CREATE TABLE road_segment_intersection_refs (
  segment_id             text NOT NULL REFERENCES road_segments(segment_id) ON DELETE CASCADE,
  sequence_no            smallint NOT NULL CHECK (sequence_no > 0),
  intersecting_road_name text NOT NULL,
  intersecting_segment_id text REFERENCES road_segments(segment_id) ON DELETE SET NULL,
  PRIMARY KEY (segment_id, sequence_no)
);

CREATE INDEX road_segment_intersection_target_idx
  ON road_segment_intersection_refs (intersecting_segment_id)
  WHERE intersecting_segment_id IS NOT NULL;

CREATE TABLE road_segment_alternatives (
  segment_id             text NOT NULL REFERENCES road_segments(segment_id) ON DELETE CASCADE,
  alternative_segment_id text NOT NULL REFERENCES road_segments(segment_id) ON DELETE RESTRICT,
  priority               smallint NOT NULL DEFAULT 1 CHECK (priority > 0),
  PRIMARY KEY (segment_id, alternative_segment_id),
  CHECK (segment_id <> alternative_segment_id)
);

CREATE TABLE road_segment_nearby_stations (
  segment_id             text NOT NULL REFERENCES road_segments(segment_id) ON DELETE CASCADE,
  station_id             text NOT NULL REFERENCES stations(station_id) ON DELETE RESTRICT,
  PRIMARY KEY (segment_id, station_id)
);

CREATE TABLE traffic_snapshots (
  observed_at            timestamptz NOT NULL,
  segment_id             text NOT NULL REFERENCES road_segments(segment_id) ON DELETE RESTRICT,
  avg_speed_kph          numeric(6, 2) NOT NULL CHECK (avg_speed_kph >= 0),
  vehicle_count          integer NOT NULL CHECK (vehicle_count >= 0),
  saturation_score       numeric(5, 4) NOT NULL CHECK (saturation_score >= 0),
  lane_status            text NOT NULL,
  ingested_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (observed_at, segment_id)
);

CREATE INDEX traffic_snapshots_segment_time_idx
  ON traffic_snapshots (segment_id, observed_at DESC);

CREATE TABLE crowd_snapshots (
  observed_at            timestamptz NOT NULL,
  station_id             text NOT NULL REFERENCES stations(station_id) ON DELETE RESTRICT,
  user_count             integer NOT NULL CHECK (user_count >= 0),
  stay_time_avg_minutes  numeric(8, 2) NOT NULL CHECK (stay_time_avg_minutes >= 0),
  growth_rate            numeric(8, 4) NOT NULL,
  roaming_user_pct       numeric(5, 4) NOT NULL CHECK (roaming_user_pct BETWEEN 0 AND 1),
  ingested_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (observed_at, station_id)
);

CREATE INDEX crowd_snapshots_station_time_idx
  ON crowd_snapshots (station_id, observed_at DESC);

CREATE TABLE incidents (
  event_id               text PRIMARY KEY,
  incident_type          text NOT NULL,
  location_description   text NOT NULL,
  status                 text NOT NULL,
  severity               text NOT NULL,
  description            text NOT NULL,
  occurred_at            timestamptz NOT NULL,
  source_payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX incidents_occurred_at_idx ON incidents (occurred_at DESC);
CREATE INDEX incidents_status_severity_idx ON incidents (status, severity);

-- An event may affect both a station and one or more road segments.  This
-- replaces the polymorphic `affected_segment` field in live_incidents.json.
CREATE TABLE incident_road_impacts (
  event_id               text NOT NULL REFERENCES incidents(event_id) ON DELETE CASCADE,
  segment_id             text NOT NULL REFERENCES road_segments(segment_id) ON DELETE RESTRICT,
  impact_role            text NOT NULL DEFAULT 'primary',
  PRIMARY KEY (event_id, segment_id)
);

CREATE TABLE incident_station_impacts (
  event_id               text NOT NULL REFERENCES incidents(event_id) ON DELETE CASCADE,
  station_id             text NOT NULL REFERENCES stations(station_id) ON DELETE RESTRICT,
  impact_role            text NOT NULL DEFAULT 'primary',
  PRIMARY KEY (event_id, station_id)
);

-- Persisted output of the existing rule engine.  `reasoning_steps` and
-- `llm_text` are intentionally flexible/auditable, while the event relation
-- remains normalized.
CREATE TABLE response_alerts (
  alert_id               text PRIMARY KEY,
  event_id               text REFERENCES incidents(event_id) ON DELETE SET NULL,
  alert_kind             text NOT NULL,
  title                  text NOT NULL,
  rule_summary           text NOT NULL,
  llm_text               text,
  sop_section_id         text,
  estimated_delay_min    numeric(8, 2) CHECK (estimated_delay_min >= 0),
  reasoning_steps        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX response_alerts_event_time_idx
  ON response_alerts (event_id, created_at DESC);

CREATE TABLE sop_documents (
  sop_document_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_name          text NOT NULL,
  version                text NOT NULL DEFAULT '1',
  body                   text NOT NULL,
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_name, version)
);

CREATE TABLE sop_sections (
  sop_section_id         text PRIMARY KEY,
  sop_document_id        bigint NOT NULL REFERENCES sop_documents(sop_document_id) ON DELETE CASCADE,
  title                  text NOT NULL,
  body                   text NOT NULL,
  keywords               text[] NOT NULL DEFAULT '{}',
  display_order          integer NOT NULL CHECK (display_order > 0),
  UNIQUE (sop_document_id, display_order)
);

ALTER TABLE response_alerts
  ADD CONSTRAINT response_alerts_sop_section_fk
  FOREIGN KEY (sop_section_id) REFERENCES sop_sections(sop_section_id) ON DELETE SET NULL;

COMMIT;

-- Import mapping from the current files
--
-- city_traffic_flow.csv       -> traffic_snapshots
-- signaling_crowd_density.csv -> crowd_snapshots
-- road_network_geometry.json  -> road_segments,
--                                road_segment_intersection_refs,
--                                road_segment_alternatives,
--                                road_segment_nearby_stations
-- road_paths.json             -> road_segments.route_geojson / is_dashed_on_map
-- station_coords.json         -> stations
-- live_incidents.json         -> incidents + incident_*_impacts
-- emergency_traffic_sop.txt   -> sop_documents + sop_sections
