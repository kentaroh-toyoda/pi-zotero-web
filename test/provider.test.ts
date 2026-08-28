import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ZOTERO_PROVIDER_ID, createZoteroProvider, fetchKeyInfo } from "../provider.ts";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { mockFetch } from "./_mock.ts";

describe("provider.fetchKeyInfo", () => {
	it("returns the parsed key info on 200", async () => {
		const handle = mockFetch((c) =>
			c.url === "https://api.zotero.org/keys/current"
				? { status: 200, body: { userID: 42, username: "me", access: { user: { library: true } } } }
				: undefined,
		);
		const info = await fetchKeyInfo("KEY");
		assert.equal(info.userID, 42);
		assert.equal(info.username, "me");
		handle.restore();
	});

	it("throws KeyCheckError on non-ok", async () => {
		const handle = mockFetch(() => ({ status: 401, body: "Unauthorized" }));
		await assert.rejects(() => fetchKeyInfo("KEY"), (err: unknown) => {
			assert.match((err as Error).message, /rejected the API key/);
			return true;
		});
		handle.restore();
	});
});

function fakeInteraction(key: string): ProviderAuthInteraction {
	return {
		signal: new AbortController().signal,
		async prompt() {
			return key;
		},
		notify() {},
	};
}

describe("provider.login flow", () => {
	it("verifies the key and stores key + ZOTERO_USER_ID", async () => {
		const handle = mockFetch((c) =>
			c.url === "https://api.zotero.org/keys/current"
				? { status: 200, body: { userID: 42, username: "me", access: { user: { library: true, files: true, write: true } } } }
				: undefined,
		);
		const provider = createZoteroProvider();
		const cred = await provider.auth.apiKey!.login!(fakeInteraction("MYKEY"));
		assert.equal(cred.type, "api_key");
		assert.equal((cred as { key?: string }).key, "MYKEY");
		assert.equal((cred as { env?: Record<string, string> }).env?.ZOTERO_USER_ID, "42");
		handle.restore();
	});

	it("rejects a key without library access", async () => {
		const handle = mockFetch((c) =>
			c.url === "https://api.zotero.org/keys/current"
				? { status: 200, body: { userID: 42, username: "me", access: { user: { library: false } } } }
				: undefined,
		);
		const provider = createZoteroProvider();
		await assert.rejects(() => provider.auth.apiKey!.login!(fakeInteraction("MYKEY")), /library access/);
		handle.restore();
	});

	it("throws when no key is entered", async () => {
		const provider = createZoteroProvider();
		await assert.rejects(() => provider.auth.apiKey!.login!(fakeInteraction("   ")), /No API key/);
	});

	it("retries the key prompt on a 403, then gives up after 3 attempts", async () => {
		let prompts = 0;
		const interaction: ProviderAuthInteraction = {
			signal: new AbortController().signal,
			async prompt() {
				prompts++;
				return "BADKEY";
			},
			notify() {},
		};
		const handle = mockFetch(() => ({ status: 403, body: "Invalid key" }));
		const provider = createZoteroProvider();
		await assert.rejects(() => provider.auth.apiKey!.login!(interaction), /rejected 3 times/);
		assert.equal(prompts, 3, "should have prompted 3 times before giving up");
		handle.restore();
	});

	it("succeeds on a later attempt after initial 403s", async () => {
		let prompts = 0;
		let authCalls = 0;
		const interaction: ProviderAuthInteraction = {
			signal: new AbortController().signal,
			async prompt() {
				prompts++;
				return prompts === 1 ? "BADKEY" : "GOODKEY";
			},
			notify() {},
		};
		const handle = mockFetch(() => {
			authCalls++;
			return authCalls === 1
				? { status: 403, body: "Invalid key" }
				: { status: 200, body: { userID: 42, username: "me", access: { user: { library: true } } } };
		});
		const provider = createZoteroProvider();
		const cred = await provider.auth.apiKey!.login!(interaction);
		assert.equal((cred as { key?: string }).key, "GOODKEY");
		assert.equal(prompts, 2);
		handle.restore();
	});
});

describe("provider.check / resolve", () => {
	it("check reports configured when a key is present", async () => {
		const provider = createZoteroProvider();
		const result = await provider.auth.apiKey!.check!({
			ctx: { env: async () => undefined, fileExists: async () => false },
			credential: { type: "api_key", key: "K", env: { ZOTERO_USER_ID: "42" } },
			signal: new AbortController().signal,
		});
		assert.equal(result?.type, "api_key");
		assert.equal(result?.source, "stored credential");
	});

	it("check returns undefined when no credential", async () => {
		const provider = createZoteroProvider();
		const result = await provider.auth.apiKey!.check!({
			ctx: { env: async () => undefined, fileExists: async () => false },
			credential: undefined,
			signal: new AbortController().signal,
		});
		assert.equal(result, undefined);
	});

	it("resolve returns the apiKey + env", async () => {
		const provider = createZoteroProvider();
		const result = await provider.auth.apiKey!.resolve({
			ctx: { env: async () => undefined, fileExists: async () => false },
			credential: { type: "api_key", key: "K", env: { ZOTERO_USER_ID: "42" } },
			signal: new AbortController().signal,
		});
		assert.equal(result?.auth.apiKey, "K");
		assert.equal(result?.env?.ZOTERO_USER_ID, "42");
		assert.equal(result?.source, "stored Zotero API key");
	});

	it("resolve returns undefined when no key", async () => {
		const provider = createZoteroProvider();
		const result = await provider.auth.apiKey!.resolve({
			ctx: { env: async () => undefined, fileExists: async () => false },
			credential: undefined,
			signal: new AbortController().signal,
		});
		assert.equal(result, undefined);
	});
});

describe("provider shape", () => {
	it("declares no LLM models and is the zotero provider", () => {
		const provider = createZoteroProvider();
		assert.equal(provider.id, ZOTERO_PROVIDER_ID);
		assert.equal(provider.name, "Zotero");
		assert.deepEqual(provider.getModels(), []);
	});
});