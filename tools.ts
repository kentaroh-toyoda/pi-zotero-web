import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { ZOTERO_PROVIDER_ID } from "./provider.ts";
import {
	type ZoteroConfig,
	type ZoteroItem,
	deleteItem,
	downloadAttachmentFile,
	getChildren,
	getItem,
	itemTemplate,
	searchItems,
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
					if (!params.item || typeof params.item !== "object") {
						throw new Error("item (object or array of objects) is required for create.");
					}
					const items = Array.isArray(params.item) ? params.item : [params.item];
					const created = await createItems(cfg, items, signal);
					return textResult({ created: summarize(created) });
				}
				case "update": {
					if (!params.itemKey) throw new Error("itemKey is required for update.");
					if (params.version === undefined) throw new Error("version is required for update.");
					if (!params.item || typeof params.item !== "object") {
						throw new Error("item (patch object) is required for update.");
					}
					await updateItem(cfg, params.itemKey, params.version, params.item, signal);
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
}