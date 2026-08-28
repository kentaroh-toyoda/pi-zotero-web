import type {
	Api,
	ApiStreamOptions,
	AssistantMessageEventStream,
	AuthCheck,
	AuthResult,
	Context,
	Model,
	Provider,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ApiKeyCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/** Provider id used for `/login zotero`, `/logout zotero`, and credential storage in auth.json. */
export const ZOTERO_PROVIDER_ID = "zotero";
export const ZOTERO_API_BASE = "https://api.zotero.org";

interface KeyInfo {
	userID: number;
	username: string;
	access?: {
		user?: { library?: boolean; files?: boolean; notes?: boolean; write?: boolean };
		groups?: Record<string, unknown>;
	};
}

/** Verify an API key against /keys/current and return the owning user id + access. */
export async function fetchKeyInfo(key: string, signal?: AbortSignal): Promise<KeyInfo> {
	const res = await fetch(`${ZOTERO_API_BASE}/keys/current`, {
		headers: { "Zotero-API-Key": key, "Zotero-API-Version": "3" },
		signal,
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new KeyCheckError(res.status, body || res.statusText, key.length);
	}
	return (await res.json()) as KeyInfo;
}

/** Raised when /keys/current rejects a key, with a length diagnostic (no key leaked). */
export class KeyCheckError extends Error {
	constructor(readonly status: number, readonly response: string, readonly keyLength: number) {
		super(
			`Zotero rejected the API key (HTTP ${status}: ${response.trim() || "Forbidden"}). ` +
				`You entered ${keyLength} character${keyLength === 1 ? "" : "s"}; a Zotero key is usually ~24 alphanumeric chars. ` +
				`Re-check the key at https://www.zotero.org/settings/keys (it must have library + file access).`,
		);
		this.name = "KeyCheckError";
	}
}

function unsupportedStream(): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		stream.push({
			type: "error",
			reason: "error",
			error: {
				role: "assistant",
				content: [],
				api: "openai-completions" as Api,
				provider: ZOTERO_PROVIDER_ID,
				model: "",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage:
					"The 'zotero' provider is for Zotero library access only; it has no LLM models and cannot stream completions.",
				timestamp: Date.now(),
			},
		});
		stream.end();
	})();
	return stream;
}

/**
 * A native pi-ai Provider registered purely for authentication: `/login zotero`
 * prompts for a Zotero API key, verifies it via /keys/current, and stores the
 * key plus the resolved user id in ~/.pi/agent/auth.json. It declares no LLM
 * models, so it never appears in /model. Tools read the stored credential via
 * ctx.modelRegistry.getProviderAuth("zotero").
 */
export function createZoteroProvider(): Provider<Api> {
	return {
		id: ZOTERO_PROVIDER_ID,
		name: "Zotero",
		baseUrl: ZOTERO_API_BASE,
		auth: {
			apiKey: {
				name: "Zotero API key",
				async login(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> {
					for (let attempt = 1; attempt <= 3; attempt++) {
						const key = (await interaction.prompt({
							type: "secret",
							message: attempt === 1 ? "Zotero API key" : `Zotero API key (attempt ${attempt})`,
						})).trim();
						if (!key) throw new Error("No API key entered.");
						interaction.notify({ type: "progress", message: "Verifying key with Zotero…" });
						let info: KeyInfo;
						try {
							info = await fetchKeyInfo(key, interaction.signal);
						} catch (err) {
							if (err instanceof KeyCheckError) {
								interaction.notify({ type: "info", message: err.message });
								continue; // retry
							}
							throw err;
						}
						if (!info.access?.user?.library) {
							throw new Error(
								"This Zotero API key does not have library access. Re-create it at https://www.zotero.org/settings/keys with library + file access.",
							);
						}
						return {
							type: "api_key",
							key,
							env: { ZOTERO_USER_ID: String(info.userID) },
						};
					}
					throw new Error(
						"Zotero API key rejected 3 times. Re-check the key at https://www.zotero.org/settings/keys and run `/login zotero` again.",
					);
				},
				async check({ credential }): Promise<AuthCheck | undefined> {
					return credential?.key
						? { type: "api_key", source: credential.env?.ZOTERO_USER_ID ? "stored credential" : "stored API key" }
						: undefined;
				},
				async resolve({ credential }): Promise<AuthResult | undefined> {
					const key = credential?.key;
					if (!key) return undefined;
					return {
						auth: { apiKey: key },
						env: credential?.env,
						source: "stored Zotero API key",
					};
				},
			},
		},
		getModels: () => [],
		// No LLM models — these are never invoked but must satisfy the Provider interface.
		stream: <T extends Api>(_model: Model<T>, _context: Context, _options?: ApiStreamOptions<T>) =>
			unsupportedStream(),
		streamSimple: (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) =>
			unsupportedStream(),
	};
}