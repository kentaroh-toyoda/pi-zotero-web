import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type SearchParams,
	ZoteroError,
	createItems,
	deleteItem,
	downloadAttachmentFile,
	getChildren,
	getItem,
	itemTemplate,
	listTags,
	searchItems,
	setItemTags,
	updateItem,
	uploadAttachmentFile,
} from "../client.ts";
import { assertHeader, mockFetch, type FetchCall } from "./_mock.ts";

const CFG = { apiKey: "KEY123", userId: "42" };
const GROUP_CFG = { apiKey: "KEY123", userId: "42", groupId: "7" };

function json(status: number, body: object): { status: number; body: object } {
	return { status, body };
}

afterEach(() => {
	// mockFetch.restore() is called inside each test via the returned handle.
});

describe("client.searchItems", () => {
	it("builds the correct URL, query, and headers for a personal library", async () => {
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/items/top?") ? json(200, [{ key: "AAAA", version: 1, data: {} }]) : undefined,
		);
		const params: SearchParams = { q: "diffusion", qmode: "everything", limit: 10, top: true };
		const items = await searchItems(CFG, params);
		const call = handle.calls[0];
		assert.equal(items.length, 1);
		assert.match(call!.url, /\/users\/42\/items\/top\?/);
		assert.match(call!.url, /q=diffusion/);
		assert.match(call!.url, /qmode=everything/);
		assert.match(call!.url, /limit=10/);
		assert.match(call!.url, /format=json/);
		assertHeader(call, "Zotero-API-Key", "KEY123");
		assertHeader(call, "Zotero-API-Version", "3");
		handle.restore();
	});

	it("uses the collections path when collectionKey is set", async () => {
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/collections/COL1/items?") ? json(200, []) : undefined,
		);
		await searchItems(CFG, { q: "x", collectionKey: "COL1" });
		assert.match(handle.calls[0]!.url, /\/collections\/COL1\/items\?/);
		handle.restore();
	});

	it("uses the group prefix for a group library", async () => {
		const handle = mockFetch((c) => (c.url.includes("/groups/7/items?") ? json(200, []) : undefined));
		await searchItems(GROUP_CFG, { q: "x" });
		assert.match(handle.calls[0]!.url, /\/groups\/7\/items\?/);
		handle.restore();
	});

	it("throws ZoteroError on non-ok", async () => {
		const handle = mockFetch(() => ({ status: 403, body: "Forbidden" }));
		await assert.rejects(() => searchItems(CFG, { q: "x" }), (err: unknown) => {
			assert(err instanceof ZoteroError);
			assert.equal((err as ZoteroError).status, 403);
			return true;
		});
		handle.restore();
	});
});

describe("client.getItem / getChildren / itemTemplate", () => {
	it("getItem fetches a single item by key", async () => {
		const handle = mockFetch((c) =>
			c.url === "https://api.zotero.org/users/42/items/ABCD?format=json" ? json(200, { key: "ABCD", version: 5, data: {} }) : undefined,
		);
		const item = await getItem(CFG, "ABCD");
		assert.equal(item.key, "ABCD");
		handle.restore();
	});

	it("getChildren fetches children", async () => {
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/items/PARENT/children?format=json") ? json(200, [{ key: "C1", data: { itemType: "note" } }]) : undefined,
		);
		const kids = await getChildren(CFG, "PARENT");
		assert.equal(kids.length, 1);
		handle.restore();
	});

	it("itemTemplate builds the itemType query and linkMode", async () => {
		const handle = mockFetch((c) =>
			c.url.startsWith("https://api.zotero.org/items/new?") && c.url.includes("itemType=attachment") && c.url.includes("linkMode=imported_file")
				? json(200, { itemType: "attachment" })
				: undefined,
		);
		const t = await itemTemplate("attachment", "imported_file");
		assert.equal((t as { itemType: string }).itemType, "attachment");
		handle.restore();
	});
});

describe("client write operations", () => {
	it("createItems POSTs JSON with a Zotero-Write-Token", async () => {
		const handle = mockFetch((c) =>
			c.method === "POST" && c.url.endsWith("/users/42/items") ? json(200, [{ key: "NEW1", version: 1, data: {} }]) : undefined,
		);
		const created = await createItems(CFG, [{ itemType: "journalArticle", title: "T" }]);
		const call = handle.calls[0];
		assert.equal(created.length, 1);
		assert.equal(call!.headers["content-type"], "application/json");
		assert.ok(call!.headers["zotero-write-token"], "missing Zotero-Write-Token");
		assert.match(call!.body as string, /journalArticle/);
		handle.restore();
	});

	it("updateItem PATCHes with If-Unmodified-Since-Version", async () => {
		const handle = mockFetch((c) =>
			c.method === "PATCH" && c.url.endsWith("/users/42/items/K1") ? { status: 200, body: "" } : undefined,
		);
		await updateItem(CFG, "K1", 9, { title: "new" });
		const call = handle.calls[0];
		assert.equal(call!.headers["if-unmodified-since-version"], "9");
		assert.match(call!.body as string, /new/);
		handle.restore();
	});

	it("deleteItem DELETEs with If-Unmodified-Since-Version", async () => {
		const handle = mockFetch((c) =>
			c.method === "DELETE" && c.url.endsWith("/users/42/items/K2") ? { status: 200, body: "" } : undefined,
		);
		await deleteItem(CFG, "K2", 3);
		const call = handle.calls[0];
		assert.equal(call!.method, "DELETE");
		assert.equal(call!.headers["if-unmodified-since-version"], "3");
		handle.restore();
	});
});

describe("client file upload", () => {
	it("runs the full 4-step upload flow", async () => {
		const dir = await mkdtemp(join(tmpdir(), "zotero-"));
		const filePath = join(dir, "paper.pdf");
		const content = Buffer.from("%PDF-1.4 fake pdf bytes");
		await writeFile(filePath, content);

		const calls: FetchCall[] = [];
		const handle = mockFetch((c) => {
			calls.push(c);
			// 1. create attachment item
			if (c.method === "POST" && c.url.endsWith("/users/42/items")) {
				return json(200, [{ key: "ATT1", version: 1, data: { itemType: "attachment" } }]);
			}
			// 2. upload authorization
			if (c.method === "POST" && c.url.endsWith("/users/42/items/ATT1/file") && (c.body as string).startsWith("md5=") && !(c.body as string).startsWith("upload=")) {
				return json(200, {
					url: "https://s3.example.com/upload",
					contentType: "multipart/form-data; boundary=xyz",
					prefix: "--xyz\r\nContent-Disposition: form-data; name=\"key\"\r\n\r\nVALUE\r\n--xyz\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\n",
					suffix: "\r\n--xyz--\r\n",
					uploadKey: "UPLOADKEY",
				});
			}
			// 3. S3 upload
			if (c.method === "POST" && c.url === "https://s3.example.com/upload") {
				return { status: 201, body: "" };
			}
			// 4. register upload
			if (c.method === "POST" && c.url.endsWith("/users/42/items/ATT1/file") && (c.body as string) === "upload=UPLOADKEY") {
				return { status: 200, body: "" };
			}
			return undefined;
		});

		const created = await uploadAttachmentFile(CFG, { parentKey: "PARENT", filePath, title: "paper.pdf" });

		assert.equal(created.key, "ATT1");
		// 1 zotero create + 2 zotero file POSTs + 1 S3 POST = 4 calls
		assert.equal(calls.length, 4, `expected 4 calls, got ${calls.length}`);
		// upload-auth and register must both carry If-None-Match: *
		const authCall = calls[1];
		const registerCall = calls[3];
		assert.equal(authCall.headers["if-none-match"], "*");
		assert.equal(authCall.headers["content-type"], "application/x-www-form-urlencoded");
		assert.equal(registerCall.headers["if-none-match"], "*");
		assert.equal(registerCall.body, "upload=UPLOADKEY");
		// S3 body = prefix + file + suffix concatenated
		const s3Call = calls[2];
		const s3Buf = s3Call.body as Buffer;
		const prefix = "--xyz\r\nContent-Disposition: form-data; name=\"key\"\r\n\r\nVALUE\r\n--xyz\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\n";
		const suffix = "\r\n--xyz--\r\n";
		assert.equal(s3Buf.toString("latin1"), prefix + content.toString("latin1") + suffix);

		handle.restore();
		await rm(dir, { recursive: true, force: true });
	});

	it("short-circuits when the server reports the file already exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "zotero-"));
		const filePath = join(dir, "paper.pdf");
		await writeFile(filePath, Buffer.from("bytes"));

		const calls: FetchCall[] = [];
		const handle = mockFetch((c) => {
			calls.push(c);
			if (c.method === "POST" && c.url.endsWith("/users/42/items")) {
				return json(200, [{ key: "ATT1", version: 1, data: {} }]);
			}
			if (c.method === "POST" && c.url.endsWith("/users/42/items/ATT1/file")) {
				return json(200, { exists: 1 });
			}
			return undefined;
		});

		await uploadAttachmentFile(CFG, { parentKey: "PARENT", filePath });
		// Only create + auth calls; no S3 POST, no register.
		assert.equal(calls.length, 2);
		handle.restore();
		await rm(dir, { recursive: true, force: true });
	});
});

describe("client file download", () => {
	it("writes the file to disk and returns the ETag", async () => {
		const dir = await mkdtemp(join(tmpdir(), "zotero-"));
		const outPath = join(dir, "out.pdf");
		const handle = mockFetch((c) =>
			c.url.endsWith("/users/42/items/ATT2/file")
				? { status: 200, body: Buffer.from("PDFBYTES"), headers: { ETag: '"abc123"' } }
				: undefined,
		);
		const result = await downloadAttachmentFile(CFG, { itemKey: "ATT2", outputPath: outPath });
		assert.equal(result.bytes, 8);
		assert.equal(result.md5, '"abc123"');
		assert.equal(await readFile(outPath, "utf8"), "PDFBYTES");
		handle.restore();
		await rm(dir, { recursive: true, force: true });
	});
});

describe("client tags", () => {
	it("listTags lists library tags by default", async () => {
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/tags?") ? { status: 200, body: [{ tag: "to-read", type: 0, items: 3 }] } : undefined,
		);
		const tags = await listTags(CFG, { limit: 50 });
		assert.equal(tags.length, 1);
		assert.equal(tags[0].tag, "to-read");
		handle.restore();
	});

	it("listTags targets an item's tags when itemKey is given", async () => {
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/items/K1/tags?") ? { status: 200, body: [{ tag: "ML", type: 1 }] } : undefined,
		);
		const tags = await listTags(CFG, { itemKey: "K1" });
		assert.equal(tags[0].tag, "ML");
		handle.restore();
	});

	it("setItemTags PATCHes the item with the normalized tags array", async () => {
		const handle = mockFetch((c) =>
			c.method === "PATCH" && c.url.endsWith("/users/42/items/K1") ? { status: 200, body: "" } : undefined,
		);
		await setItemTags(
			CFG,
			"K1",
			9,
			[{ tag: "a", type: 0 }, { tag: "b" }],
		);
		const call = handle.calls[0];
		assert.equal(call!.headers["if-unmodified-since-version"], "9");
		const body = JSON.parse(call!.body as string);
		assert.deepEqual(body.tags, [{ tag: "a", type: 0 }, { tag: "b", type: 0 }]);
		handle.restore();
	});
});