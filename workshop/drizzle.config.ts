import os from "os";
import path from "path";
import { defineConfig } from "drizzle-kit";

const dbPath =
  process.env.RAINDROP_WORKSHOP_DB_PATH ||
  path.join(os.homedir(), ".raindrop", "raindrop_workshop.db");

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: dbPath,
  },
});
