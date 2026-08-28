import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerZoteroTools } from "../tools.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mockFetch } from "./_mock.ts";

/** A minimal harness capturing the last registered tool so we can call execute(). */
function harness() {
	const tools = new Map<string, ReturnType<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>>>();
	const api = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerZoteroTools(api);

	function ctx(auth: unknown): ExtensionContext {
		return {
			modelRegistry: {
				getProviderAuth: async () => auth,
			},
		} as unknown as ExtensionContext;
	}
	return { tools, ctx };
}

const AUTH = { auth: { apiKey: "KEY" }, env: { ZOTERO_USER_ID: "42" } };
const NO_AUTH = undefined;

describe("tools.zotero_search", () => {
	it("resolves config and returns summarized items", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/items?")
				? { status: 200, body: [{ key: "K1", version: 1, data: { itemType: "journalArticle", title: "Paper", abstractNote: "abs" } }] }
				: undefined,
		);
		const res = await tools.get("zotero_search")!.execute("id", { q: "x" }, undefined, undefined, ctx(AUTH));
		const text = (res.content[0] as { text: string }).text;
		const parsed = JSON.parse(text);
		assert.equal(parsed.count, 1);
		assert.equal(parsed.items[0].title, "Paper");
		assert.equal(parsed.items[0].key, "K1");
		handle.restore();
	});

	it("throws a helpful error when no key is configured", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_search")!.execute("id", { q: "x" }, undefined, undefined, ctx(NO_AUTH)),
			/\/login zotero/,
		);
	});
});

describe("tools.zotero_item", () => {
	it("get returns the item", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.endsWith("/users/42/items/AB?format=json") ? { status: 200, body: { key: "AB", version: 3, data: {} } } : undefined,
		);
		const res = await tools.get("zotero_item")!.execute("id", { action: "get", itemKey: "AB" }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.key, "AB");
		handle.restore();
	});

	it("create posts the item object", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.method === "POST" && c.url.endsWith("/users/42/items") ? { status: 200, body: [{ key: "NEW", version: 1, data: {} }] } : undefined,
		);
		const res = await tools
			.get("zotero_item")!
			.execute("id", { action: "create", item: { itemType: "journalArticle", title: "T" } }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.created[0].key, "NEW");
		handle.restore();
	});

	it("update requires version", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_item")!.execute("id", { action: "update", itemKey: "K", item: { title: "n" } }, undefined, undefined, ctx(AUTH)),
			/version is required/,
		);
	});

	it("update patches with the given version", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.method === "PATCH" && c.url.endsWith("/users/42/items/K") ? { status: 200, body: "" } : undefined,
		);
		const res = await tools
			.get("zotero_item")!
			.execute("id", { action: "update", itemKey: "K", version: 7, item: { title: "n" } }, undefined, undefined, ctx(AUTH));
		assert.equal(handle.calls[0]!.headers["if-unmodified-since-version"], "7");
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.ok, true);
		handle.restore();
	});

	it("delete requires version", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_item")!.execute("id", { action: "delete", itemKey: "K" }, undefined, undefined, ctx(AUTH)),
			/version is required/,
		);
	});
});

describe("tools.zotero_template", () => {
	it("returns the template (no auth required)", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.startsWith("https://api.zotero.org/items/new?") ? { status: 200, body: { itemType: "note" } } : undefined,
		);
		const res = await tools.get("zotero_template")!.execute("id", { itemType: "note" }, undefined, undefined, ctx(NO_AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.itemType, "note");
		handle.restore();
	});
});

describe("tools.zotero_attachment", () => {
	it("list filters children to attachments", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/items/P/children?")
				? {
						status: 200,
						body: [
							{ key: "N1", data: { itemType: "note" } },
							{ key: "A1", data: { itemType: "attachment", title: "pdf" } },
						],
					}
				: undefined,
		);
		const res = await tools.get("zotero_attachment")!.execute("id", { action: "list", itemKey: "P" }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.count, 1);
		assert.equal(parsed.attachments[0].key, "A1");
		handle.restore();
	});

	it("download requires filePath", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_attachment")!.execute("id", { action: "download", itemKey: "A" }, undefined, undefined, ctx(AUTH)),
			/filePath/,
		);
	});

	it("delete requires version", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_attachment")!.execute("id", { action: "delete", itemKey: "A" }, undefined, undefined, ctx(AUTH)),
			/version is required/,
		);
	});
});