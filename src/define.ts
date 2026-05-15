import type { Static, TSchema } from "@sinclair/typebox";
import type { Drone, DroneDefinition } from "./types.js";

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * Validate + freeze a drone definition. The returned handle is what
 * `runDrone` consumes; storing the definition this way prevents callers
 * from mutating tools/prompt/etc mid-run.
 *
 * If `def.output` is a TypeBox schema, the inferred Static is the drone's
 * output type. Otherwise the drone returns `string` (final assistant text).
 */
export function defineDrone<TSchemaOut extends TSchema>(
  def: DroneDefinition<Static<TSchemaOut>> & { output: TSchemaOut },
): Drone<Static<TSchemaOut>>;
export function defineDrone(def: DroneDefinition): Drone;
export function defineDrone(def: DroneDefinition<unknown>): Drone<unknown> {
  if (!ID_RE.test(def.id)) {
    throw new Error(`defineDrone: invalid id "${def.id}". Must match /^[a-z][a-z0-9-]{1,63}$/.`);
  }
  if (!def.systemPrompt?.trim()) {
    throw new Error(`defineDrone: drone "${def.id}" requires a non-empty systemPrompt.`);
  }
  if (!def.model?.provider || !def.model?.model) {
    throw new Error(`defineDrone: drone "${def.id}" requires model.provider and model.model.`);
  }
  if (def.tools) {
    const names = new Set<string>();
    for (const t of def.tools) {
      if (!t.name) {
        throw new Error(`defineDrone: drone "${def.id}" has tool with empty name.`);
      }
      if (names.has(t.name)) {
        throw new Error(`defineDrone: drone "${def.id}" has duplicate tool name "${t.name}".`);
      }
      names.add(t.name);
    }
  }
  return Object.freeze({ definition: Object.freeze({ ...def }) }) as Drone<unknown>;
}
