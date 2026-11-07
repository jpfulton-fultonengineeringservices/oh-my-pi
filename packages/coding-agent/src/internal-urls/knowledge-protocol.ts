import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, SchemeSpec } from "./types";

/**
 * The service currently has no context namespace and no single-document GET
 * endpoint. Never drop the context from a URL: doing so could expose another
 * context's track. Keep these URLs unavailable until the contracts agree.
 */
export class KnowledgeProtocolHandler implements ProtocolHandler {
	readonly scheme = "knowledge";
	readonly spec: SchemeSpec = {
		backing: "remote",
		selectors: "lines",
		immutable: true,
	};

	async resolve(url: InternalUrl, _context?: ResolveContext): Promise<InternalResource> {
		const kind = url.rawHost || url.hostname;
		const segments = (url.rawPathname ?? url.pathname).split("/").slice(1);
		let valid = (kind === "record" && segments.length === 3) || (kind === "track" && segments.length === 2);
		if (valid) {
			try {
				valid = segments.every(segment => {
					const decoded = decodeURIComponent(segment);
					return decoded.length > 0 && !decoded.includes("/") && !decoded.includes("\\");
				});
			} catch {
				valid = false;
			}
		}

		if (!valid) {
			return {
				url: url.href,
				content:
					"Invalid knowledge URI; expected knowledge://record/<context>/<track>/<document> or knowledge://track/<context>/<track>.",
				contentType: "text/markdown",
				notes: ["invalid_knowledge_uri"],
			};
		}

		return {
			url: url.href,
			content: "",
			contentType: "text/markdown",
			notes: ["service_unavailable", "context_unavailable"],
		};
	}
}
