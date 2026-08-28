import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { ZOTERO_PROVIDER_ID } from "./provider.ts";
import {
	type ZoteroConfig,
	type ZoteroItem,
	addItemsToCollection,
	createCollections,
	deleteCollection,
	deleteItem,
	downloadAttachmentFile,
	exportItems,
	getChildren,
	getCollection,
	getFullText,
	getItem,
	itemTemplate,
	listCollectionItems,
	listCollections,
	listCreatorFields,
	listCreatorTypes,
	listItemFields,
	listItemTypeFields,
	listItemTypes,
	listTags,
	removeItemsFromCollection,
	searchItems,
	setFullText,
	setItemTags,
	updateCollection,
	updateItem,
	uploadAttachmentFile,
	createItems,
} from "./client.ts";

/** Resolve the stored Zotero credential into a config, or throw a helpful error. */
async function resolveConfig(ctx: ExtensionContext): Promise<ZoteroConfig> {
	const auth = await ctx.modelRegistry.getProviderAuth(ZOTERO_PROVIDER_ID);
	const apiKey = auth?.auth.apiKey;
	if (!apiKey) {
		throw new Error(
			"No Zotero API key configured. Run `/login zotero` to set one (it is stored in ~/.pi/agent/auth.json).",
		);
	}
	const userId = auth?.env?.ZOTERO_USER_ID;
	if (!userId) {
		throw new Error(
			"Zotero API key is stored but no user id was found. Re-run `/login zotero` to refresh it.",
		);
	}
	const cfg: ZoteroConfig = { apiKey, userId };
	// Group library override via provider-scoped env (set manually in auth.json if needed).
	const groupId = auth.env?.ZOTERO_GROUP_ID;
	if (typeof groupId === "string" && groupId) cfg.groupId = groupId;
	return cfg;
}

function summarize(items: ZoteroItem[]): unknown[] {
	// Keep tool output small: only metadata fields the LLM usually needs.
	return items.map((item) => ({
		key: item.key,
		version: item.version,
		itemType: item.data.itemType,
		title: item.data.title,
		creators: item.data.creators,
		abstractNote: item.data.abstractNote,
		date: item.data.date,
		DOI: item.data.DOI,
		url: item.data.url,
		tags: item.data.tags,
		collections: item.data.collections,
	}));
}

function textResult(obj: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], details: {} };
}

/**
 * Normalize the `item` argument for create/update.
 *
 * Some providers serialize an untyped (`Type.Any()`) object parameter as a
 * JSON string rather than a parsed object, and pi's TypeBox `Value.Convert`
 * leaves `Type.Any()` values untouched, so the string reaches `execute()` as-is.
 * Parse it back into an object here so the tool is robust to both shapes.
 */
function coerceItem(value: unknown): unknown {
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch {
			throw new Error(
				"item was passed as a string but is not valid JSON. Pass an object (or array of objects) for create/update.",
			);
		}
	}
	return value;
}

/** Normalize the add/remove item-membership params into the shape the client expects. */
function normalizeMembershipItems(
	params: { items?: Array<{ key: string; version: number; collections: string[] }>; itemKeys?: string[] },
): Array<{ key: string; version: number; collections: string[] }> {
	if (params.items?.length) return params.items;
	throw new Error(
		"items (array of { key, version, collections }) is required. Fetch each item's current version and collections via zotero_search or zotero_item get first.",
	);
}

export function registerZoteroTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "zotero_search",
		label: "Zotero Search",
		description:
			"Search the user's Zotero library for papers/items by keyword, title/author/year, or full text. Returns metadata (key, version, title, creators, abstract, DOI, tags, collections). Use qmode='everything' to also search inside PDFs/full text.",
		promptSnippet: "Search the Zotero library by keyword or full text.",
		parameters: Type.Object({
			q: Type.String({ description: "Search query." }),
			qmode: StringEnum(["titleCreatorYear", "everything"] as const, {
				description: "Search mode. 'everything' includes full-text content.",
			}),
			itemType: Type.Optional(Type.String({ description: "Restrict to an item type, e.g. journalArticle." })),
			collectionKey: Type.Optional(Type.String({ description: "Restrict to a collection key." })),
			tag: Type.Optional(Type.String({ description: "Restrict to a tag." })),
			limit: Type.Optional(Type.Number({ description: "Max items to return (default 25)." })),
			top: Type.Optional(Type.Boolean({ description: "Return only top-level items (excludes notes/attachments)." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			const items = await searchItems(
				cfg,
				{
					q: params.q,
					qmode: params.qmode,
					itemType: params.itemType,
					collectionKey: params.collectionKey,
					tag: params.tag,
					limit: params.limit ?? 25,
					top: params.top,
				},
				signal,
			);
			return textResult({ count: items.length, items: summarize(items) });
		},
	});

	pi.registerTool({
		name: "zotero_item",
		label: "Zotero Item CRUD",
		description:
			"Create, read, update, or delete a Zotero item (paper/note/etc.). " +
			"Actions: 'get' (fetch by key), 'create' (pass a full item object), 'update' (patch fields by key+version), 'delete' (by key+version). " +
			"Use zotero_template first to build a valid create/update payload.",
		promptSnippet: "Read, create, update, or delete a Zotero item.",
		parameters: Type.Object({
			action: StringEnum(["get", "create", "update", "delete"] as const, {
				description: "CRUD action to perform.",
			}),
			itemKey: Type.Optional(Type.String({ description: "Item key (required for get/update/delete)." })),
			version: Type.Optional(
				Type.Number({ description: "Current item version (required for update/delete; use the version returned by zotero_search/zotero_item get)." }),
			),
			item: Type.Optional(
				Type.Any({ description: "Full item object for create, or patch fields for update (e.g. {title, creators, abstractNote, tags})." }),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			switch (params.action) {
				case "get": {
					if (!params.itemKey) throw new Error("itemKey is required for get.");
					const item = await getItem(cfg, params.itemKey, signal);
					return textResult(item);
				}
				case "create": {
					const item = coerceItem(params.item);
					if (!item || typeof item !== "object") {
						throw new Error("item (object or array of objects) is required for create.");
					}
					const items = Array.isArray(item) ? item : [item];
					const created = await createItems(cfg, items as Record<string, unknown>[], signal);
					return textResult({ created: summarize(created) });
				}
				case "update": {
					if (!params.itemKey) throw new Error("itemKey is required for update.");
					if (params.version === undefined) throw new Error("version is required for update.");
					const item = coerceItem(params.item);
					if (!item || typeof item !== "object") {
						throw new Error("item (patch object) is required for update.");
					}
					await updateItem(cfg, params.itemKey, params.version, item as Record<string, unknown>, signal);
					return textResult({ updated: params.itemKey, ok: true });
				}
				case "delete": {
					if (!params.itemKey) throw new Error("itemKey is required for delete.");
					if (params.version === undefined) throw new Error("version is required for delete.");
					await deleteItem(cfg, params.itemKey, params.version, signal);
					return textResult({ deleted: params.itemKey, ok: true });
				}
				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	});

	pi.registerTool({
		name: "zotero_template",
		label: "Zotero Item Template",
		description:
			"Fetch a Zotero item template for a given itemType, to use as a base for zotero_item create/update payloads. Pass linkMode for attachment templates.",
		promptSnippet: "Get a Zotero item template to build create payloads.",
		parameters: Type.Object({
			itemType: Type.String({ description: "e.g. journalArticle, book, bookSection, attachment, note." }),
			linkMode: Type.Optional(
				Type.String({ description: "For itemType=attachment: imported_file, imported_url, linked_file, linked_url." }),
			),
		}),
		async execute(_id, params, signal) {
			const template = await itemTemplate(params.itemType, params.linkMode, signal);
			return textResult(template);
		},
	});

	pi.registerTool({
		name: "zotero_attachment",
		label: "Zotero PDF / Attachment",
		description:
			"Manage attachment files (PDFs) in the Zotero library. " +
			"Actions: 'list' (children of a parent item), 'upload' (upload a local file as a stored attachment under a parent item), " +
			"'download' (download an attachment's file to a local path), 'delete' (delete an attachment item; requires its version).",
		promptSnippet: "List, upload, download, or delete Zotero attachment files.",
		parameters: Type.Object({
			action: StringEnum(["list", "upload", "download", "delete"] as const, {
				description: "Attachment action to perform.",
			}),
			itemKey: Type.Optional(
				Type.String({ description: "Attachment key (download/delete) or parent item key (list/upload)." }),
			),
			parentKey: Type.Optional(Type.String({ description: "Parent item key for upload. (Alias for itemKey.)" })),
			version: Type.Optional(Type.Number({ description: "Current attachment version (required for delete)." })),
			filePath: Type.Optional(
				Type.String({ description: "Local file path to upload (upload) or write to (download)." }),
			),
			title: Type.Optional(Type.String({ description: "Optional attachment title for upload (defaults to filename)." })),
			contentType: Type.Optional(Type.String({ description: "Optional MIME type for upload (default application/pdf)." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			switch (params.action) {
				case "list": {
					const key = params.itemKey ?? params.parentKey;
					if (!key) throw new Error("itemKey (parent item key) is required for list.");
					const children = await getChildren(cfg, key, signal);
					const attachments = children.filter((c) => c.data.itemType === "attachment");
					return textResult({ count: attachments.length, attachments: summarize(attachments) });
				}
				case "upload": {
					const parentKey = params.parentKey ?? params.itemKey;
					if (!parentKey) throw new Error("parentKey (or itemKey) is required for upload.");
					if (!params.filePath) throw new Error("filePath is required for upload.");
					const created = await uploadAttachmentFile(
						cfg,
						{
							parentKey,
							filePath: params.filePath,
							title: params.title,
							contentType: params.contentType,
						},
						signal,
					);
					return textResult({ uploaded: created.key, attachment: summarize([created])[0] });
				}
				case "download": {
					if (!params.itemKey) throw new Error("itemKey (attachment key) is required for download.");
					if (!params.filePath) throw new Error("filePath (output path) is required for download.");
					const result = await downloadAttachmentFile(
						cfg,
						{ itemKey: params.itemKey, outputPath: params.filePath },
						signal,
					);
					return textResult(result);
				}
				case "delete": {
					if (!params.itemKey) throw new Error("itemKey (attachment key) is required for delete.");
					if (params.version === undefined) throw new Error("version is required for delete.");
					await deleteItem(cfg, params.itemKey, params.version, signal);
				return textResult({ deleted: params.itemKey, ok: true });
				}
				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	});

	pi.registerTool({
		name: "zotero_tags",
		label: "Zotero Tags",
		description:
			"Manage Zotero tags. Actions: 'list' (all tags in the library, or tags on one item when itemKey is given), " +
			"'get' (tags on a single item via its key), 'set' (replace an item's full tags array, requires the item version). " +
			"Each tag is { tag: string, type: 0|1 } where type 0=manual and 1=automatic. Use zotero_search with a tag param to filter by tag.",
		promptSnippet: "List or set Zotero tags on items.",
		parameters: Type.Object({
			action: StringEnum(["list", "get", "set"] as const, {
				description: "Tag action to perform.",
			}),
			itemKey: Type.Optional(
				Type.String({ description: "Item key. Required for 'get' and 'set'; for 'list' restricts to this item's tags (otherwise lists library tags)." }),
			),
			version: Type.Optional(
				Type.Number({ description: "Current item version (required for 'set'). Use the version returned by zotero_search/get." }),
			),
			tags: Type.Optional(
				Type.Array(
					Type.Object({
						tag: Type.String({ description: "Tag text." }),
						type: Type.Optional(Type.Number({ description: "0=manual (default), 1=automatic." })),
					}),
					{ description: "Full replacement tags array for 'set'. Replaces all existing tags on the item." },
				),
			),
			limit: Type.Optional(Type.Number({ description: "Max tags for 'list' (default 50)." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			switch (params.action) {
				case "list": {
					const tags = await listTags(cfg, { itemKey: params.itemKey, limit: params.limit ?? 50 }, signal);
					return textResult({ count: tags.length, tags });
				}
				case "get": {
					if (!params.itemKey) throw new Error("itemKey is required for get.");
					const tags = await listTags(cfg, { itemKey: params.itemKey }, signal);
					return textResult({ itemKey: params.itemKey, count: tags.length, tags });
				}
				case "set": {
					if (!params.itemKey) throw new Error("itemKey is required for set.");
					if (params.version === undefined) throw new Error("version is required for set.");
					if (!params.tags) throw new Error("tags array is required for set.");
					const normalized = params.tags.map((t) => ({
						tag: t.tag,
						type: t.type ?? 0,
					}));
					await setItemTags(cfg, params.itemKey, params.version, normalized, signal);
					return textResult({ itemKey: params.itemKey, set: normalized, ok: true });
				}
				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	});

	pi.registerTool({
		name: "zotero_collection",
		label: "Zotero Collections",
		description:
			"Manage Zotero collections (folders). Actions: " +
			"'list' (top-level collections, or subcollections of a parent via parentKey), " +
			"'get' (one collection by key), 'items' (items in a collection; top=true for top-level only), " +
			"'create' (one or more collections: { name, parentCollection? }), 'rename' (patch name via key+version), " +
			"'delete' (by key+version), 'add' (add items to a collection via itemKeys+items [{key,version,collections}]), " +
			"'remove' (remove items from a collection).",
		promptSnippet: "List, create, rename, delete Zotero collections and move items in/out.",
		parameters: Type.Object({
			action: StringEnum(["list", "get", "items", "create", "rename", "delete", "add", "remove"] as const, {
				description: "Collection action to perform.",
			}),
			collectionKey: Type.Optional(
				Type.String({ description: "Collection key. Required for get/items/rename/delete/add/remove; subcollections parent for list." }),
			),
			parentKey: Type.Optional(
				Type.String({ description: "For list: list subcollections of this parent collection." }),
			),
			top: Type.Optional(Type.Boolean({ description: "For list: only top-level collections. For items: only top-level items." })),
			name: Type.Optional(Type.String({ description: "For create/rename: the collection name." })),
			parentCollection: Type.Optional(
				Type.String({ description: "For create: parent collection key (omit/false for top-level)." }),
			),
			version: Type.Optional(
				Type.Number({ description: "Current collection version (required for rename/delete)." }),
			),
			itemKeys: Type.Optional(Type.Array(Type.String(), { description: "For add/remove: item keys to add/remove." })),
			items: Type.Optional(
				Type.Array(
					Type.Object({
						key: Type.String(),
						version: Type.Number(),
						collections: Type.Array(Type.String()),
					}),
					{ description: "For add/remove: full item objects with current collections arrays (required so the patch preserves existing memberships)." },
				),
			),
			limit: Type.Optional(Type.Number({ description: "Max results (default 50)." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			switch (params.action) {
				case "list": {
					const cols = await listCollections(
						cfg,
						{ parentKey: params.parentKey, top: params.top, limit: params.limit ?? 50 },
						signal,
					);
					return textResult({
						count: cols.length,
						collections: cols.map((c) => ({
							key: c.key,
							version: c.version,
							name: c.data.name,
							parentCollection: c.data.parentCollection,
						})),
					});
				}
				case "get": {
					if (!params.collectionKey) throw new Error("collectionKey is required for get.");
					return textResult(await getCollection(cfg, params.collectionKey, signal));
				}
				case "items": {
					if (!params.collectionKey) throw new Error("collectionKey is required for items.");
					const items = await listCollectionItems(
						cfg,
						params.collectionKey,
						{ top: params.top, limit: params.limit ?? 50 },
						signal,
					);
					return textResult({ count: items.length, items: summarize(items) });
				}
				case "create": {
					if (!params.name) throw new Error("name is required for create.");
					const toCreate = [{ name: params.name, parentCollection: params.parentCollection ?? false }];
					const created = await createCollections(cfg, toCreate, signal);
					return textResult({ created: created.map((c) => ({ key: c.key, version: c.version, name: c.data.name })) });
				}
				case "rename": {
					if (!params.collectionKey) throw new Error("collectionKey is required for rename.");
					if (params.version === undefined) throw new Error("version is required for rename.");
					if (!params.name) throw new Error("name is required for rename.");
					await updateCollection(cfg, params.collectionKey, params.version, { name: params.name }, signal);
					return textResult({ renamed: params.collectionKey, name: params.name, ok: true });
				}
				case "delete": {
					if (!params.collectionKey) throw new Error("collectionKey is required for delete.");
					if (params.version === undefined) throw new Error("version is required for delete.");
					await deleteCollection(cfg, params.collectionKey, params.version, signal);
					return textResult({ deleted: params.collectionKey, ok: true });
				}
				case "add": {
					if (!params.collectionKey) throw new Error("collectionKey is required for add.");
					const items = normalizeMembershipItems(params);
					await addItemsToCollection(cfg, params.collectionKey, items, signal);
					return textResult({ addedTo: params.collectionKey, count: items.length, ok: true });
				}
				case "remove": {
					if (!params.collectionKey) throw new Error("collectionKey is required for remove.");
					const items = normalizeMembershipItems(params);
					await removeItemsFromCollection(cfg, params.collectionKey, items, signal);
					return textResult({ removedFrom: params.collectionKey, count: items.length, ok: true });
				}
				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	});

	pi.registerTool({
		name: "zotero_export",
		label: "Zotero Export",
		description:
			"Export Zotero items as a bibliography string (BibTeX, BibLaTeX, CSL JSON, RIS, CSV, MODS, COinS, Netscape bookmarks, or a formatted bibliography). " +
			"Select items by itemKeys, or export an entire collection via collectionKey. With no itemKeys and no collectionKey, exports the whole library.",
		promptSnippet: "Export Zotero items as BibTeX/CSL-JSON/etc.",
		parameters: Type.Object({
			format: StringEnum(
				["bib", "bibtex", "biblatex", "csljson", "ris", "csv", "mods", "coins", "bookmarks"] as const,
				{ description: "Export format. 'bib' returns a formatted bibliography; the rest return structured data." },
			),
			itemKeys: Type.Optional(
				Type.Array(Type.String(), { description: "Specific item keys to export (recommended after a search)." }),
			),
			collectionKey: Type.Optional(
				Type.String({ description: "Export all items in this collection. Ignored when itemKeys is given." }),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			if (!params.itemKeys?.length && !params.collectionKey) {
				throw new Error(
					"Provide itemKeys (recommended) or collectionKey. Exporting the entire library can be very large and is discouraged.",
				);
			}
			const exported = await exportItems(
				cfg,
				{
					format: params.format,
					itemKeys: params.itemKeys,
					collectionKey: params.collectionKey,
					signal,
				},
				signal,
			);
			return textResult({ format: params.format, chars: exported.length, content: exported });
			},
	});

	pi.registerTool({
		name: "zotero_schema",
		label: "Zotero Schema",
		description:
			"Read-only access to Zotero's item-type schema so the agent can construct valid create/update payloads. " +
			"Actions: 'itemTypes' (all item types), 'itemFields' (all fields), 'itemTypeFields' (valid fields for one itemType — requires itemType), " +
			"'creatorTypes' (valid creator types for one itemType — requires itemType), 'creatorFields' (localized firstName/lastName/name). " +
			"No auth required (public endpoints). Use zotero_template for a ready-to-fill item, and this for discovering valid fields/creators for exotic types.",
		promptSnippet: "Look up valid Zotero item types, fields, and creator types.",
		parameters: Type.Object({
			action: StringEnum(["itemTypes", "itemFields", "itemTypeFields", "creatorTypes", "creatorFields"] as const, {
				description: "Schema query to perform.",
			}),
			itemType: Type.Optional(
				Type.String({ description: "Required for itemTypeFields and creatorTypes (e.g. journalArticle, book)." }),
			),
		}),
		async execute(_id, params, signal) {
			switch (params.action) {
				case "itemTypes":
					return textResult(await listItemTypes(signal));
				case "itemFields":
					return textResult(await listItemFields(signal));
				case "itemTypeFields": {
					if (!params.itemType) throw new Error("itemType is required for itemTypeFields.");
					return textResult(await listItemTypeFields(params.itemType, signal));
				}
				case "creatorTypes": {
					if (!params.itemType) throw new Error("itemType is required for creatorTypes.");
					return textResult(await listCreatorTypes(params.itemType, signal));
				}
				case "creatorFields":
					return textResult(await listCreatorFields(signal));
				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	});

	pi.registerTool({
		name: "zotero_fulltext",
		label: "Zotero Full Text",
		description:
			"Get or set extracted full-text content for a Zotero attachment (enables qmode='everything' search without the desktop client). " +
			"Actions: 'get' (retrieve extracted text for an attachment by key), 'set' (store extracted text for an attachment — use indexedChars/totalChars for text docs, indexedPages/totalPages for PDFs).",
		promptSnippet: "Read or write Zotero attachment full-text content.",
		parameters: Type.Object({
			action: StringEnum(["get", "set"] as const, { description: "Full-text action to perform." }),
			itemKey: Type.String({ description: "Attachment item key." }),
			content: Type.Optional(Type.String({ description: "Extracted text to store (required for 'set')." })),
			indexedChars: Type.Optional(Type.Number({ description: "Indexed character count (text docs)." })),
			totalChars: Type.Optional(Type.Number({ description: "Total character count (text docs)." })),
			indexedPages: Type.Optional(Type.Number({ description: "Indexed page count (PDFs)." })),
			totalPages: Type.Optional(Type.Number({ description: "Total page count (PDFs)." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			switch (params.action) {
				case "get": {
					const ft = await getFullText(cfg, params.itemKey, signal);
					return textResult({ itemKey: params.itemKey, ...ft });
				}
				case "set": {
					if (!params.content) throw new Error("content is required for set.");
					const payload = {
						content: params.content,
						...(params.indexedChars !== undefined ? { indexedChars: params.indexedChars } : {}),
						...(params.totalChars !== undefined ? { totalChars: params.totalChars } : {}),
						...(params.indexedPages !== undefined ? { indexedPages: params.indexedPages } : {}),
						...(params.totalPages !== undefined ? { totalPages: params.totalPages } : {}),
					};
					await setFullText(cfg, params.itemKey, payload, signal);
					return textResult({ itemKey: params.itemKey, set: true, ok: true });
				}
				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	});
}