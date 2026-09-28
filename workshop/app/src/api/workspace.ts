import { apiJsonOrNull } from "./request";

export async function getActiveWorkspace(): Promise<string | null> {
  const body = await apiJsonOrNull<{ cwd?: unknown }>("/api/workspace/active");
  return typeof body?.cwd === "string" ? body.cwd : null;
}
