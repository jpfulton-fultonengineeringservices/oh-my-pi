/**
 * `@oh-my-pi/pi-tavily` — the one Tavily client in the ecosystem.
 *
 * Everything needed to talk to Tavily lives here: transport construction and
 * identity (`client.ts`), request bodies and response normalisation
 * (`wire.ts`), the seven verbs (`verbs.ts`), failure classification
 * (`errors.ts`), and the tool surface as plain data (`specs.ts`). Subpath
 * imports work too (`@oh-my-pi/pi-tavily/specs`), so a consumer that only
 * wants the field table does not pull in axios.
 */

export * from "./client";
export * from "./errors";
export * from "./specs";
export * from "./types";
export * from "./verbs";
export * from "./wire";
