-- ============================================================
-- Provider Tracking Migration
-- ============================================================
-- Adds a provider column to cost_tracking to distinguish between
-- AI providers: claude, openai, groq, elevenlabs, ultravox, fal, heygen
--
-- Run this AFTER migration-multiuser.sql
-- ============================================================

-- Add provider column
ALTER TABLE cost_tracking ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'claude';

-- Backfill existing rows (all existing data is from Claude)
UPDATE cost_tracking SET provider = 'claude' WHERE provider IS NULL;

-- Index for provider-based queries
CREATE INDEX IF NOT EXISTS idx_cost_tracking_provider ON cost_tracking(provider);
CREATE INDEX IF NOT EXISTS idx_cost_tracking_provider_created ON cost_tracking(provider, created_at DESC);
