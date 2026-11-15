/**
 * Environment isolation for tests that read `process.env`.
 *
 * Tavily's key and identity defaults come from the environment, so a test that
 * asserts "no key" has to be sure the machine running it does not have one.
 * Deleting outright rather than setting `""` matters: an empty variable is a
 * different case from an absent one, and the resolver treats them differently.
 */

export type EnvOverrides = Readonly<Record<string, string | undefined>>;

/** Run `run` with `vars` applied to `process.env`, restoring the exact prior state after. */
export async function withEnv<T>(vars: EnvOverrides, run: () => Promise<T> | T): Promise<T> {
	const previous = new Map<string, string | undefined>();
	for (const key of Object.keys(vars)) previous.set(key, process.env[key]);

	for (const [key, value] of Object.entries(vars)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}

	try {
		return await run();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/** The environment a keyless client sees: no key, no project, no org, no proxy. */
export const KEYLESS_ENV: EnvOverrides = {
	TAVILY_API_KEY: undefined,
	TAVILY_PROJECT: undefined,
	TAVILY_ORG_ID: undefined,
	TAVILY_HTTP_PROXY: undefined,
	TAVILY_HTTPS_PROXY: undefined,
};
