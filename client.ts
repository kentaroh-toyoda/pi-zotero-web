import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { ZOTERO_API_BASE } from "./provider.ts";

/** Resolved Zotero credentials used to authenticate Web API requests. */
export interface ZoteroConfig {
	apiKey: string;
	/** Numeric user id for the personal library, resolved from /keys/current during login. */
	userId: string;
	/** Optional group library id. When set, group libraries are used instead of the personal library. */
	groupId?: string;
}

export interface ZoteroItem {
	key: string;
	version: number;
	library?: unknown;
	data: Record<string, unknown> & { key?: string; version?: number; itemType?: string };
}

export class ZoteroError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: string,
	) {
		super(`${message} (${status}): ${body || ""}`.trim());
		this.name = "ZoteroError";
	}
}

function prefix(cfg: ZoteroConfig): string {
	return cfg.groupId ? `/groups/${cfg.groupId}` : `/users/${cfg.userId}`;
}

function baseHeaders(cfg: ZoteroConfig): Record<string, string> {
	return {
		"Zotero-API-Key": cfg.apiKey,
		"Zotero-API-Version": "3",
	};
}

async function zoteroFetch(
	cfg: ZoteroConfig,
	path: string,
	init: RequestInit & { signal?: AbortSignal } = {},
): Promise<Response> {
	const res = await fetch(`${ZOTERO_API_BASE}${path}`, {
		...init,
		headers: { ...baseHeaders(cfg), ...(init.headers ?? {}) },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new ZoteroError(`Zotero API request to ${path} failed`, res.status, body);
	}
	return res;
}

export interface SearchParams {
	q?: string;
	qmode?: "titleCreatorYear" | "everything";
	itemType?: string;
	collectionKey?: string;
	tag?: string;
	limit?: number;
	since?: number;
	/** Return only top-level items (excludes child notes/attachments). */
	top?: boolean;
}

function buildQuery(params: SearchParams): string {
	const q = new URLSearchParams();
	if (params.q) q.set("q", params.q);
	if (params.qmode) q.set("qmode", params.qmode);
	if (params.itemType) q.set("itemType", params.itemType);
	if (params.tag) q.set("tag", params.tag);
	if (params.limit !== undefined) q.set("limit", String(params.limit));
	if (params.since !== undefined) q.set("since", String(params.since));
	q.set("format", "json");
	return q.toString();
}

/** Search the library for items. Returns full item objects with key/version/data. */
export async function searchItems(
	cfg: ZoteroConfig,
	params: SearchParams,
	signal?: AbortSignal,
): Promise<ZoteroItem[]> {
	const base = prefix(cfg);
	const path = params.collectionKey
		? `${base}/collections/${params.collectionKey}/items`
		: params.top
			? `${base}/items/top`
			: `${base}/items`;
	const res = await zoteroFetch(cfg, `${path}?${buildQuery(params)}`, { signal });
	return (await res.json()) as ZoteroItem[];
}

/** Get a single item by key. */
export async function getItem(
	cfg: ZoteroConfig,
	itemKey: string,
	signal?: AbortSignal,
): Promise<ZoteroItem> {
	const res = await zoteroFetch(cfg, `${prefix(cfg)}/items/${itemKey}?format=json`, { signal });
	return (await res.json()) as ZoteroItem;
}

/** Child items (notes/attachments) of a parent item. */
export async function getChildren(
	cfg: ZoteroConfig,
	itemKey: string,
	signal?: AbortSignal,
): Promise<ZoteroItem[]> {
	const res = await zoteroFetch(cfg, `${prefix(cfg)}/items/${itemKey}/children?format=json`, {
		signal,
	});
	return (await res.json()) as ZoteroItem[];
}

/** Fetch an item template for a given itemType (helps build create/update payloads). */
export async function itemTemplate(
	itemType: string,
	linkMode?: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const q = new URLSearchParams({ itemType });
	if (linkMode) q.set("linkMode", linkMode);
	const res = await fetch(`${ZOTERO_API_BASE}/items/new?${q.toString()}`, { signal });
	if (!res.ok) throw new ZoteroError("Failed to fetch item template", res.status, await res.text());
	return (await res.json()) as Record<string, unknown>;
}

export interface ZoteroTag {
	tag: string;
	type?: number;
	/** Number of items using this tag (present in library-wide tag listings with the default format). */
	items?: number;
	meta?: number;
}

/** List all tags in the library, or tags on a specific item. */
export async function listTags(
	cfg: ZoteroConfig,
	opts: { itemKey?: string; limit?: number } = {},
	signal?: AbortSignal,
): Promise<ZoteroTag[]> {
	const q = new URLSearchParams({ format: "json" });
	if (opts.limit !== undefined) q.set("limit", String(opts.limit));
	const path = opts.itemKey
		? `${prefix(cfg)}/items/${opts.itemKey}/tags`
		: `${prefix(cfg)}/tags`;
	const res = await zoteroFetch(cfg, `${path}?${q.toString()}`, { signal });
	return (await res.json()) as ZoteroTag[];
}

/** Set (replace) the full tags array on an item. `version` is the current item version. */
export async function setItemTags(
	cfg: ZoteroConfig,
	itemKey: string,
	version: number,
	tags: Array<{ tag: string; type?: number }>,
	signal?: AbortSignal,
): Promise<void> {
	const normalized = tags.map((t) => ({ tag: t.tag, type: t.type ?? 0 }));
	await updateItem(cfg, itemKey, version, { tags: normalized }, signal);
}

// -----------------------------------------------------------------------------
// Collections
// -----------------------------------------------------------------------------

export interface ZoteroCollection {
	key: string;
	version: number;
	library?: unknown;
	meta?: Record<string, unknown>;
	data: Record<string, unknown> & {
		key?: string;
		version?: number;
		name?: string;
		parentCollection?: string | false;
};
}

/** List collections: top-level by default, subcollections of a parent when parentKey is given. */
export async function listCollections(
	cfg: ZoteroConfig,
	opts: { parentKey?: string; top?: boolean; limit?: number } = {},
	signal?: AbortSignal,
): Promise<ZoteroCollection[]> {
	const q = new URLSearchParams({ format: "json" });
	if (opts.limit !== undefined) q.set("limit", String(opts.limit));
	const path = opts.parentKey
		? `${prefix(cfg)}/collections/${opts.parentKey}/collections`
		: opts.top
			? `${prefix(cfg)}/collections/top`
			: `${prefix(cfg)}/collections`;
	const res = await zoteroFetch(cfg, `${path}?${q.toString()}`, { signal });
	return (await res.json()) as ZoteroCollection[];
}

/** Get a single collection by key. */
export async function getCollection(
	cfg: ZoteroConfig,
	collectionKey: string,
	signal?: AbortSignal,
): Promise<ZoteroCollection> {
	const res = await zoteroFetch(cfg, `${prefix(cfg)}/collections/${collectionKey}?format=json`, { signal });
	return (await res.json()) as ZoteroCollection;
}
/** List items in a collection. Pass `top: true` for top-level items only. */
export async function listCollectionItems(
	cfg: ZoteroConfig,
	collectionKey: string,
	opts: { top?: boolean; limit?: number; q?: string; qmode?: "titleCreatorYear" | "everything" } = {},
	signal?: AbortSignal,
): Promise<ZoteroItem[]> {
	const q = new URLSearchParams({ format: "json" });
	if (opts.limit !== undefined) q.set("limit", String(opts.limit));
	if (opts.q) q.set("q", opts.q);
	if (opts.qmode) q.set("qmode", opts.qmode);
	const sub = opts.top ? "/items/top" : "/items";
	const res = await zoteroFetch(cfg, `${prefix(cfg)}/collections/${collectionKey}${sub}?${q.toString()}`, {
		signal,
	});
	return (await res.json()) as ZoteroItem[];
}

/** Create one or more collections. Each needs at least { name, parentCollection? }. */
export async function createCollections(
	cfg: ZoteroConfig,
	collections: Array<{ name: string; parentCollection?: string | false }>,
	signal?: AbortSignal,
): Promise<ZoteroCollection[]> {
	const token = crypto.randomUUID().replace(/-/g, "");
	const res = await zoteroFetch(cfg, `${prefix(cfg)}/collections`, {
		method: "POST",
		signal,
		headers: { "Content-Type": "application/json", "Zotero-Write-Token": token },
		body: JSON.stringify(collections),
	});
	return parseWriteResponse<ZoteroCollection>((await res.json()) as ZoteroWriteResponse);
}

/** Patch a collection (e.g. rename). `version` is the current collection version. */
export async function updateCollection(
	cfg: ZoteroConfig,
	collectionKey: string,
	version: number,
	patch: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<void> {
	await zoteroFetch(cfg, `${prefix(cfg)}/collections/${collectionKey}`, {
		method: "PATCH",
		signal,
		headers: {
			"Content-Type": "application/json",
			"If-Unmodified-Since-Version": String(version),
		},
		body: JSON.stringify(patch),
	});
}

/** Delete a collection. `version` is the current collection version. */
export async function deleteCollection(
	cfg: ZoteroConfig,
	collectionKey: string,
	version: number,
	signal?: AbortSignal,
): Promise<void> {
	await zoteroFetch(cfg, `${prefix(cfg)}/collections/${collectionKey}`, {
		method: "DELETE",
		signal,
		headers: { "If-Unmodified-Since-Version": String(version) },
	});
}

/** Add items to a collection by patching each item's `collections` array. */
export async function addItemsToCollection(
	cfg: ZoteroConfig,
	collectionKey: string,
	items: Array<{ key: string; version: number; collections: string[] }>,
	signal?: AbortSignal,
): Promise<void> {
	await Promise.all(
		items.map((item) =>
			updateItem(
				cfg,
				item.key,
				item.version,
				{ collections: Array.from(new Set([...item.collections, collectionKey])) },
				signal,
			),
		),
	);
}

/** Remove a collection key from each item's `collections` array. */
export async function removeItemsFromCollection(
	cfg: ZoteroConfig,
	collectionKey: string,
	items: Array<{ key: string; version: number; collections: string[] }>,
	signal?: AbortSignal,
): Promise<void> {
	await Promise.all(
		items.map((item) =>
			updateItem(
				cfg,
				item.key,
				item.version,
				{ collections: item.collections.filter((c) => c !== collectionKey) },
				signal,
			),
		),
	);
}

// -----------------------------------------------------------------------------
// Export / bibliography
// -----------------------------------------------------------------------------

export type ExportFormat =
	| "bibtex"
	| "biblatex"
	| "csljson"
	| "ris"
	| "csv"
	| "mods"
	| "coins"
	| "bookmarks";

/**
 * Export items as a string in the given format. `itemKeys` selects specific
 * items; when omitted, exports the whole library (or a collection via `collectionKey`).
 */
export async function exportItems(
	cfg: ZoteroConfig,
	opts: {
		format: ExportFormat | "bib";
		itemKeys?: string[];
		collectionKey?: string;
		signal?: AbortSignal;
	},
): Promise<string> {
	const { format, itemKeys, collectionKey, signal } = opts;
	const q = new URLSearchParams();
	if (format === "bib") q.set("format", "bib");
	else q.set("format", format);
	if (itemKeys?.length) q.set("itemKey", itemKeys.join(","));

	const base = prefix(cfg);
	const path = collectionKey
		? `${base}/collections/${collectionKey}/items`
		: `${base}/items`;
	const res = await zoteroFetch(cfg, `${path}?${q.toString()}`, { signal });
	return res.text();
}

/** Minimal shape shared by saved items and collections. */
interface ZoteroObject {
	key: string;
	version: number;
	data: Record<string, unknown>;
}

/**
 * Response to a multi-object write (POST of a JSON array of objects).
 * The Zotero Web API answers 200 with this object — not an array:
 *   { successful: { "0": <saved object>, ... }, unchanged: { ... },
 *     failed: { "1": { key, code, message, ... } } }
 * (see https://www.zotero.org/support/dev/web_api/v3/write_requests).
 */
interface ZoteroWriteResponse {
	successful?: Record<string, ZoteroObject>;
	unchanged?: Record<string, unknown>;
	failed?: Record<string, { key?: string; code?: number; message?: string }>;
}

/**
 * Extract the created objects from a multi-object write response: `successful`
 * entries in submission order (keys are the numeric string indices of the
 * submitted array, sorted numerically to match the input order). Throws if any
 * individual write failed, so callers get a plain array of created objects.
 */
function parseWriteResponse<T extends ZoteroObject>(json: ZoteroWriteResponse): T[] {
	const failed = json.failed ?? {};
	const failedEntries = Object.entries(failed);
	if (failedEntries.length > 0) {
		const details = failedEntries
			.map(([i, e]) => `index ${i}: ${e?.code ?? "?"} ${e?.message ?? ""}`.trim())
			.join("; ");
		throw new Error(`Zotero create failed for ${failedEntries.length} object(s) — ${details}`);
	}
	const successful = json.successful ?? {};
	return Object.keys(successful)
		.sort((a, b) => Number(a) - Number(b))
		.map((i) => successful[i]! as T);
}

/** Create one or more items. Returns the created items with key/version. */
export async function createItems(
	cfg: ZoteroConfig,
	items: Record<string, unknown>[],
	signal?: AbortSignal,
): Promise<ZoteroItem[]> {
	const token = crypto.randomUUID().replace(/-/g, "");
	const res = await zoteroFetch(cfg, `${prefix(cfg)}/items`, {
		method: "POST",
		signal,
		headers: {
			"Content-Type": "application/json",
			"Zotero-Write-Token": token,
		},
		body: JSON.stringify(items),
	});
	return parseWriteResponse<ZoteroItem>((await res.json()) as ZoteroWriteResponse);
}

/** Patch an item's fields. `version` is the current item version (If-Unmodified-Since-Version). */
export async function updateItem(
	cfg: ZoteroConfig,
	itemKey: string,
	version: number,
	patch: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<void> {
	await zoteroFetch(cfg, `${prefix(cfg)}/items/${itemKey}`, {
		method: "PATCH",
		signal,
		headers: {
			"Content-Type": "application/json",
			"If-Unmodified-Since-Version": String(version),
		},
		body: JSON.stringify(patch),
	});
}

/** Delete an item. `version` is the current item version. */
export async function deleteItem(
	cfg: ZoteroConfig,
	itemKey: string,
	version: number,
	signal?: AbortSignal,
): Promise<void> {
	await zoteroFetch(cfg, `${prefix(cfg)}/items/${itemKey}`, {
		method: "DELETE",
		signal,
		headers: { "If-Unmodified-Since-Version": String(version) },
	});
}

interface UploadAuthorization {
	url: string;
	contentType: string;
	prefix: string;
	suffix: string;
	uploadKey: string;
	exists?: number;
	params?: Array<{ name: string; value: string }>;
}

/**
 * Upload a local file as a stored attachment (imported_file) under a parent item.
 * Implements the full Zotero Web API file upload flow:
 *   1. Create the attachment item.
 *   2. Get upload authorization (POST .../file).
 *   3. POST prefix+file+suffix to the returned S3 url.
 *   4. Register the upload.
 * Returns the created attachment item.
 */
export async function uploadAttachmentFile(
	cfg: ZoteroConfig,
	opts: { parentKey: string; filePath: string; title?: string; contentType?: string },
	signal?: AbortSignal,
): Promise<ZoteroItem> {
	const bytes = await readFile(opts.filePath);
	const filename = basename(opts.filePath);
	const md5 = createHash("md5").update(bytes).digest("hex");
	const contentType = opts.contentType ?? "application/pdf";

	// 1. Create the attachment item.
	const [created] = await createItems(
		cfg,
		[
			{
				itemType: "attachment",
				parentItem: opts.parentKey,
				linkMode: "imported_file",
				title: opts.title ?? filename,
				contentType,
				charset: "",
				tags: [],
				relations: {},
			},
		],
		signal,
	);
	const attachKey = created.key;

	// 2. Get upload authorization.
	const authBody = new URLSearchParams({
		md5,
		filename,
		filesize: String(bytes.length),
		mtime: String(Date.now()),
	});
	const authRes = await zoteroFetch(cfg, `${prefix(cfg)}/items/${attachKey}/file`, {
		method: "POST",
		signal,
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"If-None-Match": "*",
		},
		body: authBody.toString(),
	});
	const auth = (await authRes.json()) as UploadAuthorization;

	// File already exists server-side; no upload needed.
	if (auth.exists) {
		return created;
	}

	// 3. Upload prefix + file + suffix to S3.
	const body = Buffer.concat([
		Buffer.from(auth.prefix, "latin1"),
		typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes),
		Buffer.from(auth.suffix, "latin1"),
	]);
	const s3Res = await fetch(auth.url, {
		method: "POST",
		signal,
		headers: { "Content-Type": auth.contentType },
		body,
	});
	if (!s3Res.ok) {
		const s3body = await s3Res.text().catch(() => "");
		throw new ZoteroError("S3 file upload failed", s3Res.status, s3body);
	}

	// 4. Register the upload.
	await zoteroFetch(cfg, `${prefix(cfg)}/items/${attachKey}/file`, {
		method: "POST",
		signal,
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"If-None-Match": "*",
		},
		body: new URLSearchParams({ upload: auth.uploadKey }).toString(),
	});

	return created;
}

/**
 * Download an attachment's file bytes to a local path. Uses the ETag response
 * header as the attachment md5 (required for later If-Match modifications).
 */
export async function downloadAttachmentFile(
	cfg: ZoteroConfig,
	opts: { itemKey: string; outputPath: string },
	signal?: AbortSignal,
): Promise<{ path: string; md5?: string; bytes: number }> {
	const { writeFile } = await import("node:fs/promises");
	const res = await zoteroFetch(cfg, `${prefix(cfg)}/items/${opts.itemKey}/file`, { signal });
	const buf = Buffer.from(await res.arrayBuffer());
	await writeFile(opts.outputPath, buf);
	return { path: opts.outputPath, md5: res.headers.get("ETag") ?? undefined, bytes: buf.length };
}

// -----------------------------------------------------------------------------
// Schema (item types / fields / creator types)
// -----------------------------------------------------------------------------

export interface NameLocalized {
	field?: string;
	itemType?: string;
	creatorType?: string;
	localized: string;
}

/** GET /itemTypes — all item types with localized names. */
export async function listItemTypes(
	signal?: AbortSignal,
): Promise<Array<{ itemType: string; localized: string }>> {
	const res = await fetch(`${ZOTERO_API_BASE}/itemTypes`, { signal });
	if (!res.ok) throw new ZoteroError("Failed to list item types", res.status, await res.text());
	return (await res.json()) as Array<{ itemType: string; localized: string }>;
}

/** GET /itemFields — all item fields with localized names. */
export async function listItemFields(
	signal?: AbortSignal,
): Promise<Array<{ field: string; localized: string }>> {
	const res = await fetch(`${ZOTERO_API_BASE}/itemFields`, { signal });
	if (!res.ok) throw new ZoteroError("Failed to list item fields", res.status, await res.text());
	return (await res.json()) as Array<{ field: string; localized: string }>;
}

/** GET /itemTypeFields?itemType=... — valid fields for an item type. */
export async function listItemTypeFields(
	itemType: string,
	signal?: AbortSignal,
): Promise<Array<{ field: string; localized: string }>> {
	const q = new URLSearchParams({ itemType });
	const res = await fetch(`${ZOTERO_API_BASE}/itemTypeFields?${q.toString()}`, { signal });
	if (!res.ok) throw new ZoteroError("Failed to list fields for item type", res.status, await res.text());
	return (await res.json()) as Array<{ field: string; localized: string }>;
}

/** GET /itemTypeCreatorTypes?itemType=... — valid creator types for an item type. */
export async function listCreatorTypes(
	itemType: string,
	signal?: AbortSignal,
): Promise<Array<{ creatorType: string; localized: string }>> {
	const q = new URLSearchParams({ itemType });
	const res = await fetch(`${ZOTERO_API_BASE}/itemTypeCreatorTypes?${q.toString()}`, { signal });
	if (!res.ok) throw new ZoteroError("Failed to list creator types", res.status, await res.text());
	return (await res.json()) as Array<{ creatorType: string; localized: string }>;
}

/** GET /creatorFields — localized creator field names (firstName/lastName/name). */
export async function listCreatorFields(
	signal?: AbortSignal,
): Promise<Array<{ field: string; localized: string }>> {
	const res = await fetch(`${ZOTERO_API_BASE}/creatorFields`, { signal });
	if (!res.ok) throw new ZoteroError("Failed to list creator fields", res.status, await res.text());
	return (await res.json()) as Array<{ field: string; localized: string }>;
}

// -----------------------------------------------------------------------------
// Full-text content
// -----------------------------------------------------------------------------

export interface FullTextContent {
	content: string;
	indexedPages?: number;
	totalPages?: number;
	indexedChars?: number;
	totalChars?: number;
}

/** GET /items/<itemKey>/fulltext — retrieve extracted full-text content for an attachment. */
export async function getFullText(
	cfg: ZoteroConfig,
	itemKey: string,
	signal?: AbortSignal,
): Promise<FullTextContent> {
	const res = await zoteroFetch(cfg, `${prefix(cfg)}/items/${itemKey}/fulltext`, { signal });
	return (await res.json()) as FullTextContent;
}

/**
 * PUT /items/<itemKey>/fulltext — set extracted full-text content for an attachment.
 * Use indexedChars/totalChars for text documents, indexedPages/totalPages for PDFs.
 */
export async function setFullText(
	cfg: ZoteroConfig,
	itemKey: string,
	content: FullTextContent,
	signal?: AbortSignal,
): Promise<void> {
	await zoteroFetch(cfg, `${prefix(cfg)}/items/${itemKey}/fulltext`, {
		method: "PUT",
		signal,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(content),
	});
}