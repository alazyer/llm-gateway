import type { Migration } from "./index.js";

import { migration001Initial } from "./001-initial.js";

/**
 * Ordered list of all known migrations.
 * Add new migrations here as they are created.
 */
export const allMigrations: Migration[] = [migration001Initial];
