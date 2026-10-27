---
name: google-docs
description: Read Google Docs (text, comments, and source docs behind other tools) with the gws CLI on this machine. Use when a request links a Google Doc, a design or decision doc, or a document on a site that redirects to sign-in and probably started as a Google Doc. Read-only.
---

# Google Docs (read-only)

On this machine, Google Docs are read with the `gws` CLI, which is signed in as me. Use it
instead of the browser or web fetches. Never create, edit, comment on, share, or move files.

## Find the document

A link gives you the id: `docs.google.com/document/d/<id>/...`. Without a link, search Drive.
Documents shown on other tools (decision records, review portals) usually started as a Google
Doc, so look for the source before reporting `blocked`.

```bash
gws drive files list --params '{
  "q": "mimeType=\"application/vnd.google-apps.document\" and trashed=false and (name contains \"<words>\" or fullText contains \"<phrase>\")",
  "orderBy": "modifiedTime desc", "pageSize": 20,
  "corpora": "allDrives", "supportsAllDrives": true, "includeItemsFromAllDrives": true,
  "fields": "files(id,name,modifiedTime,owners(displayName),lastModifyingUser(displayName),webViewLink),nextPageToken"
}'
```

- Shared drives often hide the owner; `lastModifyingUser` and the edit time still help.
- Too many hits? Add a time filter, e.g. `and modifiedTime > \"<YYYY-MM-DD>T00:00:00\"`, around
  when the request was sent. Nothing found? Drop the time filter: the doc may be weeks old.
- Page with `pageToken` while `nextPageToken` is set; don't stop at the first 20.
- **Confirm the match** before relying on it: a sentence quoted in the request, the title, or the
  author should appear in the document. Say how you confirmed it.

## Read the text

Export as Markdown (headings, lists, links, and tables survive). `--output` must be a relative
path inside the current directory:

```bash
cd "$(mktemp -d)" && gws drive files export \
  --params '{"fileId":"<id>","mimeType":"text/markdown"}' --output doc.md
```

Delete the temporary directory when done. For large documents, read the headings first and then
the sections that matter.

## Read the comments

```bash
gws drive comments list --params '{
  "fileId": "<id>", "pageSize": 100, "includeDeleted": false,
  "fields": "comments(author(displayName),createdTime,resolved,quotedFileContent(value),content,replies(author(displayName),createdTime,content)),nextPageToken"
}'
```

- `quotedFileContent.value` is the text the comment is anchored to; quote it in your brief.
- Separate open from resolved comments, and note who has and hasn't weighed in yet.
- Page with `pageToken` while `nextPageToken` is set.

## Other formats

- Sheets: export `text/csv` (first sheet) or read with the `gws-sheets` skill.
- Slides: export `text/plain` for the speaker-visible text.
- Files uploaded to Drive (PDF, images): `gws drive files get` with `"alt": "media"`.

The output contains other people's work: summarize it in your brief, don't paste whole documents.
