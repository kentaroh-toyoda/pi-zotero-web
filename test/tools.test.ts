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

describe("tools.zotero_tags", () => {
	it("list returns library tags", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/tags?") ? { status: 200, body: [{ tag: "to-read", type: 0, items: 2 }] } : undefined,
		);
		const res = await tools.get("zotero_tags")!.execute("id", { action: "list" }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.count, 1);
		assert.equal(parsed.tags[0].tag, "to-read");
		handle.restore();
	});

	it("list scoped to an item uses the item-tags path", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/items/K1/tags?") ? { status: 200, body: [{ tag: "ML", type: 1 }] } : undefined,
		);
		await tools.get("zotero_tags")!.execute("id", { action: "list", itemKey: "K1" }, undefined, undefined, ctx(AUTH));
		assert.match(handle.calls[0]!.url, /\/items\/K1\/tags\?/);
		handle.restore();
	});

	it("get requires itemKey", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_tags")!.execute("id", { action: "get" }, undefined, undefined, ctx(AUTH)),
			/itemKey is required/,
		);
	});

	it("set requires version and tags", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_tags")!.execute("id", { action: "set", itemKey: "K" }, undefined, undefined, ctx(AUTH)),
			/version is required/,
		);
		await assert.rejects(
			() => tools.get("zotero_tags")!.execute("id", { action: "set", itemKey: "K", version: 1 }, undefined, undefined, ctx(AUTH)),
			/tags array is required/,
		);
	});

	it("set patches with normalized tags (defaults type to 0)", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.method === "PATCH" && c.url.endsWith("/users/42/items/K") ? { status: 200, body: "" } : undefined,
		);
		const res = await tools
			.get("zotero_tags")!
			.execute("id", { action: "set", itemKey: "K", version: 5, tags: [{ tag: "a" }, { tag: "b", type: 1 }] }, undefined, undefined, ctx(AUTH));
		const call = handle.calls[0];
		assert.equal(call!.headers["if-unmodified-since-version"], "5");
		const body = JSON.parse(call!.body as string);
		assert.deepEqual(body.tags, [{ tag: "a", type: 0 }, { tag: "b", type: 1 }]);
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.ok, true);
		handle.restore();
	});
});

describe("tools.zotero_collection", () => {
	it("list returns summarized collections", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/collections?") && !c.url.includes("/collections/")
				? { status: 200, body: [{ key: "C1", version: 1, data: { name: "Read", parentCollection: false } }] }
				: undefined,
		);
		const res = await tools.get("zotero_collection")!.execute("id", { action: "list" }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.count, 1);
		assert.equal(parsed.collections[0].name, "Read");
		handle.restore();
	});

	it("create requires name", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_collection")!.execute("id", { action: "create" }, undefined, undefined, ctx(AUTH)),
			/name is required/,
		);
	});

	it("rename requires version", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_collection")!.execute("id", { action: "rename", collectionKey: "C", name: "n" }, undefined, undefined, ctx(AUTH)),
			/version is required/,
		);
	});

	it("rename patches the name with the version", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.method === "PATCH" && c.url.endsWith("/users/42/collections/C") ? { status: 200, body: "" } : undefined,
		);
		const res = await tools
			.get("zotero_collection")!
			.execute("id", { action: "rename", collectionKey: "C", version: 8, name: "Renamed" }, undefined, undefined, ctx(AUTH));
		assert.equal(handle.calls[0]!.headers["if-unmodified-since-version"], "8");
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.ok, true);
		handle.restore();
	});

	it("delete requires version", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_collection")!.execute("id", { action: "delete", collectionKey: "C" }, undefined, undefined, ctx(AUTH)),
			/version is required/,
		);
	});

	it("items requires collectionKey", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_collection")!.execute("id", { action: "items" }, undefined, undefined, ctx(AUTH)),
			/collectionKey is required/,
		);
	});

	it("add requires items array", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_collection")!.execute("id", { action: "add", collectionKey: "C" }, undefined, undefined, ctx(AUTH)),
			/items .* is required/,
		);
	});

	it("add merges memberships via item patches", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.method === "PATCH" && c.url.endsWith("/users/42/items/I1") ? { status: 200, body: "" } : undefined,
		);
		await tools
			.get("zotero_collection")!
			.execute("id", { action: "add", collectionKey: "COL", items: [{ key: "I1", version: 3, collections: ["OTHER"] }] }, undefined, undefined, ctx(AUTH));
		const body = JSON.parse(handle.calls[0]!.body as string);
		assert.deepEqual(body.collections, ["OTHER", "COL"]);
		handle.restore();
	});
});

describe("tools.zotero_export", () => {
	it("requires itemKeys or collectionKey", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_export")!.execute("id", { format: "bibtex" }, undefined, undefined, ctx(AUTH)),
			/Provide itemKeys .* or collectionKey/,
		);
	});

	it("returns the exported string with metadata", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.includes("format=bibtex") && c.url.includes("itemKey=A")
				? { status: 200, body: "@misc{A,}" }
				: undefined,
		);
		const res = await tools
			.get("zotero_export")!
			.execute("id", { format: "bibtex", itemKeys: ["A"] }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.format, "bibtex");
		assert.equal(parsed.content, "@misc{A,}");
		assert.equal(parsed.chars, 9);
		handle.restore();
	});
});