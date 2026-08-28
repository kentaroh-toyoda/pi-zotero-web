# pi-zotero-ext

Zotero integration for [pi](https://pi.dev) via the Zotero Web API.

- **CRUD on paper metadata + PDFs** — create, read, update, delete items and attachments; upload/download PDF files.
- **Library search** — keyword, title/author/year, and full-text (`qmode=everything`) search.
- **API key management via `/login zotero`** — the key (and resolved user id) are stored in `~/.pi/agent/auth.json`; `/logout zotero` removes it.

## Requirements

- A Zotero account with a **personal library**.
- A Zotero API key created at <https://www.zotero.org/settings/keys> with **Allow library access** and **Allow file access** (write access is needed for create/update/delete/upload).

## Install

This is a directory-style pi extension. Install it globally so pi auto-discovers it:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD" ~/.pi/agent/extensions/pi-zotero-ext
```

(Or copy the directory there.) Then `/reload` inside pi, or restart pi.

Alternatively, test it without installing:

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
| `zotero_item` | `action=get\|create\|update\|delete`, `itemKey`, `version`, `item` | CRUD on an item. Use the `version` returned by search/get for update/delete. |
| `zotero_template` | `itemType`, `linkMode` | Fetch an item template to build valid create/update payloads. |
| `zotero_attachment` | `action=list\|upload\|download\|delete`, `itemKey`/`parentKey`, `filePath`, `version`, `title`, `contentType` | Manage PDF/attachment files. Upload reads a local file; download writes to a local path. |

### Typical workflows

Create a paper from a DOI/metadata:

1. `zotero_template` with `itemType=journalArticle` → base object.
2. Fill `title`, `creators`, `abstractNote`, `DOI`, `date`, etc. (the agent can fetch these from the web).
3. `zotero_item` with `action=create`, passing the filled item.

Attach a PDF to an existing item:

1. `zotero_attachment` with `action=upload`, `parentKey=<itemKey>`, `filePath=/path/to/paper.pdf`.

Download a PDF:

1. `zotero_attachment` with `action=download`, `itemKey=<attachmentKey>`, `filePath=./paper.pdf`.

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