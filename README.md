# pi-zotero-web

Zotero integration for [pi](https://pi.dev) via the Zotero Web API.

- **CRUD on paper metadata + PDFs** — create, read, update, delete items and attachments; upload/download PDF files (full 4-step Zotero file upload flow).
- **Library search** — keyword, title/author/year, and full-text (`qmode=everything`) search.
- **Tags & collections** — manage tags, list/create/rename/delete collections, and move items in/out of collections.
- **Citation export** — export items as BibTeX, BibLaTeX, CSL JSON, RIS, CSV, MODS, COinS, bookmarks, or a formatted bibliography.
- **Schema & full-text** — read the item-type/field/creator schema, and get/set extracted full-text content for attachments (enables headless full-text search).
- **API key management via `/login zotero`** — the key (and resolved user id) are stored in `~/.pi/agent/auth.json`; the login re-prompts up to 3 times on a rejected key; `/logout zotero` removes it.

## Requirements

- A Zotero account with a **personal library**.
- A Zotero API key created at <https://www.zotero.org/settings/keys> with **Allow library access** and **Allow file access** (write access is needed for create/update/delete/upload).

## Install

Install the published npm package (writes to `~/.pi/agent/settings.json`):

```bash
pi install npm:pi-zotero-web
# or pin a version:
pi install npm:pi-zotero-web@0.2.2
```

Add `-l` to install into project settings (`.pi/settings.json`) instead of user settings.

Alternatively, test it from a checkout without installing:

```bash
pi -e ./index.ts
```

## Configure

Run `/login zotero` and paste your Zotero API key. It is verified against `/keys/current` and stored (with your user id) in `~/.pi/agent/auth.json`:

```jsonc
{
  "zotero": {
    "type": "api_key",
    "key": "<your-key>",
    "env": { "ZOTERO_USER_ID": "12345" }
  }
}
```

To use a **group library** instead of your personal library, add `"ZOTERO_GROUP_ID": "<group-id>"` under `env`.

Remove the stored key with `/logout zotero`.

## Tools

All tools are registered for the agent to call automatically. You can also prompt for them directly (e.g. *"Search my Zotero library for papers on diffusion policies"*).

| Tool | Actions / params | Description |
|------|------------------|-------------|
| `zotero_search` | `q`, `qmode`, `itemType`, `collectionKey`, `tag`, `limit`, `top` | Search the library. `qmode=everything` includes full text. Returns key/version/metadata. |
| `zotero_item` | `action=get\|create\|update\|delete`, `itemKey`, `version`, `item`, `forceCreate` | CRUD on an item. Use the `version` returned by search/get for update/delete. On `create`, the library is first searched for an existing item with the same DOI (or title + first author); a match is returned with `duplicate:true` instead of creating. Pass `forceCreate:true` to bypass. |
| `zotero_template` | `itemType`, `linkMode` | Fetch an item template to build valid create/update payloads. |
| `zotero_attachment` | `action=list\|upload\|download\|delete`, `itemKey`/`parentKey`, `filePath`, `version`, `title`, `contentType` | Manage PDF/attachment files. Upload reads a local file; download writes to a local path. |
| `zotero_tags` | `action=list\|get\|set`, `itemKey`, `version`, `tags`, `limit` | List library tags or tags on an item, or replace an item's full tags array (`tags: [{tag, type:0\|1}]`, type 0=manual, 1=automatic). |
| `zotero_collection` | `action=list\|get\|items\|create\|rename\|delete\|add\|remove`, `collectionKey`, `parentKey`, `name`, `version`, `itemKeys`/`items`, `top`, `limit` | Manage collections (folders): list/get/create/rename/delete, list items in a collection, and add/remove items to/from a collection (requires each item's current `version` + `collections`). |
| `zotero_export` | `format`, `itemKeys`, `collectionKey` | Export items as BibTeX, BibLaTeX, CSL JSON, RIS, CSV, MODS, COinS, bookmarks, or a formatted bibliography (`bib`). Select by `itemKeys` or a `collectionKey`. |
| `zotero_schema` | `action=itemTypes\|itemFields\|itemTypeFields\|creatorTypes\|creatorFields`, `itemType` | Read-only access to Zotero's item-type schema (public endpoints, no auth) so the agent can build valid create payloads for exotic types. |
| `zotero_fulltext` | `action=get\|set`, `itemKey`, `content`, `indexedChars`/`totalChars` or `indexedPages`/`totalPages` | Get or set extracted full-text content for an attachment, enabling `qmode=everything` search without the desktop client. |

### Typical workflows

Create a paper from a DOI/metadata:

1. `zotero_template` (or `zotero_schema` for exotic types) → base object.
2. Fill `title`, `creators`, `abstractNote`, `DOI`, `date`, etc. (the agent can fetch these from the web).
3. `zotero_item` with `action=create`, passing the filled item.

> **Duplicate detection.** `create` checks the library for an existing item matching the new one (by DOI, then by normalized title + first author) and returns the existing entry with `duplicate:true` instead of creating a second copy. Pass `forceCreate:true` to always create. Batches (an array of items) always create without dedup to avoid ambiguous matches.

Attach a PDF to an existing item:

1. `zotero_attachment` with `action=upload`, `parentKey=<itemKey>`, `filePath=/path/to/paper.pdf`.

Download a PDF:

1. `zotero_attachment` with `action=download`, `itemKey=<attachmentKey>`, `filePath=./paper.pdf`.

Organize and export:

1. `zotero_collection` `action=create` → new collection; `action=add` to file items into it (pass each item's current `version` + `collections`).
2. `zotero_export` with `format=bibtex`, `collectionKey=<key>` → BibTeX for the whole collection.

Make an uploaded PDF searchable headlessly:

1. Extract text locally (e.g. via a PDF tool), then `zotero_fulltext` `action=set` with `content` + `indexedChars`/`totalChars` (text) or `indexedPages`/`totalPages` (PDF). Now `zotero_search` with `qmode=everything` will find it.

## Testing

Unit tests use Node's built-in test runner with a mocked `fetch` (no real network):

```bash
npm test
```

The pi host packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`) are provided by pi at runtime. For tests, they're symlinked into `node_modules/@earendil-works*` from the global pi install. If you move this checkout, re-create those symlinks (or `npm install` a local pi-coding-agent).

## How it works

- `provider.ts` registers a native pi-ai `Provider` named `zotero` that declares **no LLM models** (so it never appears in `/model`). Its only purpose is authentication: `/login zotero` runs the provider's `apiKey.login` flow, which verifies the key and stores it.
- Tools read the stored credential via `ctx.modelRegistry.getProviderAuth("zotero")` and call the Zotero Web API (`https://api.zotero.org`) with the `Zotero-API-Key` header.
- File upload implements Zotero's full 4-step flow (create attachment item → upload authorization → S3 `prefix+file+suffix` POST → register upload).

## License

MIT