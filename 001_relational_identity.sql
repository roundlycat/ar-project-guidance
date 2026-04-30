-- =============================================================================
-- SENSOR ECOLOGY: INTERPRETATION PROVENANCE LAYER
-- =============================================================================

CREATE TABLE IF NOT EXISTS interpretation_source (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_name VARCHAR(128) NOT NULL,
    source_type VARCHAR(64) CHECK (source_type IN ('human', 'llm', 'cv', 'script')),
    version VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS narrative_episode (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    episode_title VARCHAR(255) NOT NULL,
    context TEXT,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS sensor_interpretation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID REFERENCES interpretation_source(id),
    episode_id UUID REFERENCES narrative_episode(id),
    sensor_id VARCHAR(128) NOT NULL,
    raw_value JSONB,
    interpreted_meaning TEXT,
    experiential_note TEXT,
    embodied_remainder TEXT,
    superseded_by UUID REFERENCES sensor_interpretation(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Ensure interpretation layer is append-only to preserve stratigraphy
CREATE OR REPLACE RULE no_update_interpretation AS
    ON UPDATE TO sensor_interpretation
    DO INSTEAD NOTHING;

CREATE OR REPLACE RULE no_delete_interpretation AS
    ON DELETE TO sensor_interpretation
    DO INSTEAD NOTHING;
