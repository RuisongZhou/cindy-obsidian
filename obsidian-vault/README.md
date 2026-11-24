# Obsidian Vault

Find notes from your local Obsidian vault in Cindy and save useful conversations or tasks as Markdown. Everyday reading and writing works while Obsidian is closed and requires no API key.

## Get started

1. In Cindy desktop, open **Obsidian Vault** in the sidebar. Vaults already registered with Obsidian on this computer appear in the list.
2. If your vault is missing, choose **Add vault** and select the root folder that contains your notes. Adding a vault makes it the default. The dropdown switches only the current workbench. To change the default for chat and `@` completion, use the plugin preferences.
3. In **Browse**, search for a title, keywords, or a `#project/tag`. Open a result, then use **Linked notes** to follow outgoing links and backlinks.

### Browse folders and search

- Choose **Browse folders** to navigate folders and notes. Ask Cindy to list other types of files with `list_notes`, which accepts a vault-relative folder, depth (1–10), and extension.
- Choose **Load more results** to continue a search. Each result with a body match shows the first matching line, column, and context. Results matched by title or metadata still appear.
- To retrieve another page through the tool, pass `nextCursor` as `cursor` and keep the query, vault, page size, and match limit the same. Start over if results change.

## Use it in a conversation

- **Reference a note.** Type `@` in the composer and search by title, path, or tag. Choose a result to insert a reference. After you send the message, Cindy can use the reference to read the note.
- **Save a reply.** Use the view selector on an AI reply and choose **Save to Obsidian**. The form loads that reply. Review the vault, relative path, and body before saving. New notes default to `Inbox/`. You can also append to an existing note or under a heading, then open the saved note from the receipt.
- **Log something today.** Open **Daily note** from the composer’s **Obsidian** button. Add a timestamped entry or a checkbox task. The first write creates the file using Obsidian’s Daily Notes folder, date format, and available template.
- **Ask Cindy to organize your notes.** Try “`$obsidian` find the release notes tagged `#project` and show their paths.” Use `/obsidian-capture` to turn a conversation into a note or `/obsidian-daily` to review and update a journal. Cindy can also query frontmatter properties, find unlinked mentions, and update Canvas boards.

## Use the workbench from another computer

- In a remote task, ask “`$obsidian` open the vault workbench.” When Cindy supports remote task cards, the viewing computer can use the card directly. The header shows the system hostname of the vault computer, where vault reads, writes, and Obsidian open requests take place. The global workbench uses the plugin instance associated with its entry point.
- If the connection drops during a save, reconnect and choose **Check save result**. A saved receipt provides the vault-relative path. If the current form still has the original input and no receipt is found, you can retry the same request. If the result remains uncertain, check the target note first. With Cindy card state support, reopening the original card also restores the receipt check.

## Edit a specific passage

- Use `headingPath: ["Project A", "Summary"]` to read or edit a section with a repeated heading name. `read_note` includes the full path of every heading in its outline.
- Use `blockId: "^summary"` with the note path, or read `[[Plan#^summary]]`. Block edits preserve the reference marker. Unsupported or ambiguous targets are refused.
- Use `replace_in_note` for case-sensitive literal replacement in the body, a section, or a block. Start with `dryRun: true` to check the number of matches. A write requires a unique match by default, and you can pass the preview’s `mtimeMs` as `expectedMtimeMs`.

## Write rules and tags

- In **Browse → Vault write rules**, set each vault to read-only or allow writes to selected vault-relative folders and their subfolders. A restricted empty list blocks all writes. Existing setups default to allowing writes throughout the vault.
- Rules apply to the plugin’s note edits, saved replies, daily notes, Canvas changes, and moves to trash. Search and read access continue to work. Saved rules also apply when registered vaults overlap.
- Use `manage_tags` to list, add, or remove YAML frontmatter tags. Matches are case-insensitive and use the complete tag name. Removing `#project` keeps `#project/release` and inline tags in the note body.

## Files and permissions

- An on-demand Node worker reads and writes registered vaults. It keeps write receipts in the current user's application data on that computer to recognize retried requests. The plugin has no network service of its own. When you ask Cindy to work with a note, the retrieved text can enter the task context of the model you selected.
- Files are ordinary Markdown or `.canvas` files. Cindy asks you to confirm before overwriting an existing note or Canvas board or moving a note to `.trash`.
- The reply view provides the selected reply so you can edit it before saving. A workbench opened from a task can insert references into that task’s draft. You decide when to send. **Open Obsidian on the vault computer** requires Obsidian desktop on that computer.

## Troubleshooting

- **Vault missing.** Use **Add vault** and choose the folder on the computer running Cindy. The dropdown shows paths for vaults with the same name.
- **Search misses a recent change.** Choose **Refresh index**. The workbench warns when only part of a large vault was indexed.
- **A note already exists.** Change the relative path or choose an append option after checking the destination. The form keeps your text if a save fails.
- **Workbench or `@` completion is unavailable.** Check that the plugin is enabled, you are using Cindy desktop, and the vault is on the computer running the plugin. You can also try a direct `$obsidian` request.

Requires Cindy 0.1.143 or newer. Desktop integration supports Obsidian 1.15.1 or newer. When reporting a problem, include your Cindy version, plugin version, and steps to reproduce. Remove private paths and note contents before sharing.
