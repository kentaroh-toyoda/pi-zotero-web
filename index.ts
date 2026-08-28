import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ZOTERO_PROVIDER_ID, createZoteroProvider } from "./provider.ts";
import { registerZoteroTools } from "./tools.ts";

/**
 * Zotero integration for pi via the Zotero Web API.
 *
 * - Registers a `zotero` auth provider so `/login zotero` stores a Zotero
 *   API key (and resolved user id) in ~/.pi/agent/auth.json. The provider
 *   declares no LLM models, so it never shows up in /model.
 * - Registers tools for library search, item CRUD, item templates, and
 *   PDF/attachment upload/download/delete.
 *
 * First run: `/login zotero` and paste a key created at
 * https://www.zotero.org/settings/keys (with library + file access).
 */
export default function zoteroExtension(pi: ExtensionAPI): void {
	pi.registerProvider(createZoteroProvider());

	pi.on("session_start", async (_event, ctx) => {
		const status = ctx.modelRegistry.getProviderAuthStatus(ZOTERO_PROVIDER_ID);
		if (status.configured) {
			ctx.ui.notify("Zotero: API key configured.", "info");
		}
	});

	registerZoteroTools(pi);
}