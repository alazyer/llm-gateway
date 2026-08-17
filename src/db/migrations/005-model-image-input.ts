import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./index.js";

/**
 * Migration 005: add `supports_image_input` capability flag to the `models`
 * table.
 *
 * Mirrors the existing `supports_tools` / `supports_streaming` boolean flags:
 * stored as an INTEGER (0/1). Defaults to 0 so all pre-existing models are
 * text-only until an operator opts a model into image input. Surfaced through
 * model discovery as `capabilities.input_modalities`.
 */
export const migration005ModelImageInput: Migration = {
  version: 5,
  name: "model_image_input",
  up(db: DatabaseSync): void {
    db.exec(
      "ALTER TABLE models ADD COLUMN supports_image_input INTEGER NOT NULL DEFAULT 0",
    );
  },
};
