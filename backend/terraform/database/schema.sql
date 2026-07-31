-- AI City Commander: PostgreSQL 16+ schema
--
-- RDS stores the operational source of truth: road/station reference data,
-- time-series snapshots, injected incidents, and decision job pointers.
-- Large AI outputs, reports, and public notices are stored in S3; their keys
-- are recorded in decision_jobs instead of duplicating their content here.

BEGIN;

CREATE TABLE road_segments (
  segment_id text PRIMARY KEY,
  name text NOT NULL,
  flow_direction text NOT NULL,
  capacity_vph integer NOT NULL CHECK (capacity_vph > 0),
  route_geojson jsonb,
  intersections jsonb NOT NULL DEFAULT '[]'::jsonb,
  alternative_segment_ids text[] NOT NULL DEFAULT '{}',
  nearby_station_ids text[] NOT NULL DEFAULT '{}',
  is_dashed_on_map boolean NOT NULL DEFAULT false
);

CREATE TABLE stations (
  station_id text PRIMARY KEY,
  name text NOT NULL,
  longitude numeric(10, 7),
  latitude numeric(10, 7)
);

CREATE TABLE traffic_snapshots (
  observed_at timestamptz NOT NULL,
  segment_id text NOT NULL REFERENCES road_segments(segment_id),
  avg_speed_kph numeric(6, 2) NOT NULL CHECK (avg_speed_kph >= 0),
  vehicle_count integer NOT NULL CHECK (vehicle_count >= 0),
  saturation_score numeric(5, 4) NOT NULL CHECK (saturation_score >= 0),
  lane_status text NOT NULL,
  PRIMARY KEY (observed_at, segment_id)
);

CREATE INDEX traffic_snapshots_segment_time_idx
  ON traffic_snapshots (segment_id, observed_at DESC);

CREATE TABLE crowd_snapshots (
  observed_at timestamptz NOT NULL,
  station_id text NOT NULL REFERENCES stations(station_id),
  user_count integer NOT NULL CHECK (user_count >= 0),
  stay_time_avg_minutes numeric(8, 2) NOT NULL,
  growth_rate numeric(8, 4) NOT NULL,
  roaming_user_pct numeric(5, 4) NOT NULL
    CHECK (roaming_user_pct BETWEEN 0 AND 1),
  PRIMARY KEY (observed_at, station_id)
);

CREATE INDEX crowd_snapshots_station_time_idx
  ON crowd_snapshots (station_id, observed_at DESC);

CREATE TABLE incidents (
  event_id text PRIMARY KEY,
  incident_type text NOT NULL,
  location text NOT NULL,
  affected_segment text NOT NULL,
  affected_road text,
  status text NOT NULL,
  severity text NOT NULL,
  description text NOT NULL,
  occurred_at timestamptz NOT NULL,
  source_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX incidents_occurred_at_idx
  ON incidents (occurred_at DESC);

CREATE TABLE decision_jobs (
  job_id text PRIMARY KEY,
  event_id text REFERENCES incidents(event_id) ON DELETE CASCADE,
  scenario_at timestamptz NOT NULL,
  location_id text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  decision_s3_key text,
  internal_report_s3_key text,
  public_notice_s3_key text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX decision_jobs_status_idx
  ON decision_jobs (status, created_at);

COMMIT;
