# Obsidian Vault

Search your local Obsidian notes, follow wikilinks, update Daily Notes, and save useful conversations right from Cindy. The plugin reads and writes your registered Markdown vaults directly—**no open Obsidian app or API key required**.

## What You Can Do

- **Search & cite notes in chat**: Type `@` in the composer to look up notes by title, path, or tag and bring your own knowledge into Cindy's answers.
- **Save any AI reply in one click**: Choose **Save to Obsidian** from an AI reply's view menu and it is saved as a new note right away. Saving the same reply again does not create a copy, and you can edit and save another version.
- **A folder for each partner**: New notes a partner saves in its conversation go into its own folder (`伙伴/<partner name>` by default). Change any partner's folder in the workbench under **Partner folders**.
- **Add AI-generated .md files**: When you right-click a file in Cindy and choose to open it with the default app (or click Open in the preview), you can add it to Obsidian with a folder and name, or open it as usual.
- **Log your Daily Note effortlessly**: Open the **Daily note** tab to append timestamped notes or checkbox tasks using your existing Obsidian daily-note folder, date format, and template.
- **Let Cindy organize your vault**: Browse folders, search with filters, make surgical text replacements, tidy up tags, explore backlinks and orphan notes, or create and update Canvas boards in plain language.
- **Work reliably across computers**: When viewing a remote task from another computer, the workbench shows which computer hosts the vault. If a connection drops mid-save, reconnect and check the save receipt so nothing is written twice.

## Get Started in 3 Steps

1. **Open the workbench**: Click **Obsidian Vault** in Cindy's sidebar. Vaults already registered with Obsidian on this computer appear automatically.
2. **Select or add a vault**: If your folder isn't listed, click **Add vault** and choose your vault root (this also sets it as the default). The dropdown switches only the current workbench; change the default for chat and `@` completion in plugin settings.
3. **Explore or capture**: Search by keyword or `#tag`, click **Browse folders** to walk your directory tree, or open a note and follow outgoing links and backlinks under **Linked notes**.

## Everyday Workflows

- **Reference a note**: Type `@` in the composer, pick a note, and send your question so Cindy can read the full text.
- **Save an AI reply**: Choose **Save to Obsidian** from a message's view switcher. Partner conversations save to that partner's folder and other tasks to `Inbox/`. Afterwards you can open the note in Obsidian, or choose **Edit and save again** to append to an existing note or heading.
- **Built-in slash skills**:
  - `/obsidian-capture`: Distill the current conversation into a structured note with `[[wikilinks]]` and frontmatter tags.
  - `/obsidian-daily`: Review today's plan, add tasks, or write an end-of-day wrap-up.
- **Ask naturally**: Try "`$obsidian` find release notes tagged `#project`", "replace `TBD` with `Confirmed` in `Plan.md`", or "turn today's architecture notes into a Canvas board."

## Precision Editing & Organization

- **Folder browsing & paginated search**: Walk folders and filter any file type (`.md`, `.canvas`, images, etc.) with `list_files`, or search Markdown notes by text, tag, folder, and frontmatter properties with cursor pagination and match positions.
- **Duplicate headings & block IDs**: Target repeated headings accurately using full heading paths (such as `["Project A", "Summary"]`) or Obsidian block IDs (`^summary`) without breaking code fences or unrelated sections.
- **Safe literal replacement**: Preview match counts first (`dryRun`), require a unique match by default, and check file modification time (`expectedMtimeMs`) to avoid overwriting concurrent edits.
- **Clean tag management**: View vault-wide tag counts (`list_tags`) or list, add, and remove YAML frontmatter tags on a single note (`manage_tags`) with case-insensitive exact matching—removing `#project` never removes `#project/release` or inline `#project` tags.
- **Safe trash instead of permanent deletion**: Deleting a note moves it into the vault's `.trash` folder only after Cindy confirms the exact target with you.

## Privacy & Safety Guardrails

- **Local-only access**: The local Node worker accesses only vaults you registered and has no network service of its own. Write receipts stay in your computer's local application data folder to prevent duplicate saves on reconnect. Content read during a chat enters the context of the model you selected.
- **Per-vault write rules**: Under **Browse → Vault write rules**, mark a vault **read-only** or limit writes to specific subfolders (such as `Inbox` or `Daily`). Rules apply to note edits, saved replies, Daily Notes, tag changes, Canvas updates, and moves to trash, while browsing and reading remain available.
- **Explicit confirmation for destructive actions**: Cindy always prompts you to confirm before overwriting an existing note, replacing an entire Canvas board, moving a note to `.trash`, or changing a vault's write rules.
- **Official command line interface (optional)**: After you turn it on in Obsidian under **Settings → General → Command line interface**, the plugin uses it for link, tag and today's Daily Note queries while the vault is open in Obsidian. It only runs a fixed set of query commands and "open note", and never writes, moves or deletes notes through it.
- **Open in Obsidian desktop**: Jump straight to any note or Canvas in the Obsidian desktop app on the vault computer (requires Obsidian installed there).

## Changelog

### v1.1.4

- When Obsidian is running with its official command line interface turned on, backlinks, unresolved links, vault tag counts and today's Daily Note path come straight from Obsidian, so they match what Obsidian shows. Otherwise the plugin reads the files as before. Writes always go directly to the files.
- **Open in Obsidian** now targets the vault by ID, so vaults with the same name no longer open the wrong one.

### v1.1.3

- Each partner can have its own folder in the vault. New notes a partner saves with no folder, or to the inbox, go there.
- Saving an AI reply now takes one click, and the same reply is never saved twice.
- Opening a .md file in Cindy can add it to Obsidian (can be turned off in settings).

### v1.1.2
- **Folder browsing & paginated search**: Added folder-tree browsing with extension filtering, plus cursor pagination and body match positions in search results.
- **Precision editing**: Added full heading-path disambiguation for duplicate headings, Obsidian `^block ID` reads/edits, and literal find-and-replace with dry-run previews and conflict checks.
- **Write guardrails & tag tools**: Added per-vault read-only and allowed-folder write rules, vault-wide tag statistics, exact single-note frontmatter tag management, and a dedicated confirmed move-to-trash tool.
- **Remote & reconnect reliability**: Workbench now displays the vault's host computer and lets you verify write receipts after a dropped connection to avoid duplicate saves.
- **Cleaner toolset**: Removed duplicate entry points and clarified tool descriptions for more reliable tool selection.

### v1.1.1
- Initial release: Read and write local registered Obsidian vaults directly in Cindy with no open Obsidian app or API key needed.
- Included the interactive workbench, `@` note references, one-click saving of AI replies, Daily Note logging, wikilink graph exploration, Canvas editing, desktop Obsidian launch, and the `/obsidian-capture` and `/obsidian-daily` skills.

## Troubleshooting

- **Vault missing**: Click **Add vault** on the computer running Cindy and pick the folder directly. Vaults with identical names display their paths in the dropdown.
- **Backlinks or tag counts differ from Obsidian**: Turn on **Command line interface** under Obsidian **Settings → General** and keep the vault open in Obsidian; the plugin then uses Obsidian's own results.
- **Recent edits not showing up**: Click **Refresh index**. Large vaults show a notice if scanning hits index limits.
- **Note already exists**: Choose another path or switch to an append mode. Your draft stays intact if a save is rejected.
- **Workbench or `@` completion unavailable**: Verify the plugin is enabled on Cindy desktop and that the vault exists on the computer running the plugin, or invoke it directly with `$obsidian`.

Requires **Cindy 0.1.143 or newer**; desktop integration supports **Obsidian 1.15.1 or newer**.
