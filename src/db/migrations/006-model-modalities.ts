import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./index.js";

/**
 * Migration 006: replace the single `supports_image_input` boolean with
 * structured `input_modalities` / `output_modalities` columns.
 *
 * Both columns are TEXT, storing a comma-joined list of modality tokens
 * (e.g. `"text,image"`). They default to `"text"` so all pre-existing models
 * remain text-only until an operator opts a model into additional modalities.
 *
 * To preserve the behaviour introduced by migration 005, rows that had
 * `supports_image_input = 1` are backfilled to `input_modalities = 'text,image'`.
 *
 * `supports_image_input` is left in place (node:sqlite exposes no `ALTER TABLE
 * DROP COLUMN` at the version targeted here) but is no longer read by the type
 * layer — all consumers use `input_modalities` instead.
 *
 * Surfaced through model discovery as `capabilities.input_modalities` and
 * `capabilities.output_modalities`.
 */
export const migration006ModelModalities: Migration = {
  version: 6,
  name: "model_modalities",
  up(db: DatabaseSync): void {
    db.exec(
      "ALTER TABLE models ADD COLUMN input_modalities TEXT NOT NULL DEFAULT 'text'",
    );
    db.exec(
      "ALTER TABLE models ADD COLUMN output_modalities TEXT NOT NULL DEFAULT 'text'",
    );
    // Backfill from the legacy boolean so already-configured image models keep
    // advertising image input without operator action.
    db.exec(
      "UPDATE models SET input_modalities = 'text,image' WHERE supports_image_input = 1",
    );
  },
};
