# Co-edition history: where do snapshots live?

Companion to [HISTORY.md](HISTORY.md). It compares where a doc's past versions can be stored on
DFS, and records the outcome of the discussion related to this choice.

## Outcome

**A: a `.history/` folder at the workspace root, keyed by the doc's object ID.** Only the system
and `superuser` can read or write it, and agents browse versions through tools in front.

- **B is ruled out.** It ties history to a conversation or pod, and we need a solution that works
  for any doc wherever it lives. Sandbox moves can also lose history, and front can't prevent it.
- **C is ruled out.** History anyone with write access can rewrite or erase can't be trusted to
  recover from bad edits. Signatures detect tampering but don't prevent erasure. Systems that did
  this (Word 97–2003 `.doc`, RCS) moved away from it: files grew large and old versions leaked
  when the file was sent.
- **D is ruled out.** Versioning in DFS itself was ruled out by the DFS team.
- **A matches Google Drive and Dropbox:** history stored outside the file, keyed by its ID, exposed
  through an API (here, tools). Its one cost, deletion, is handled by front's delete paths plus a
  sweeper.

## The options

- **A. Workspace root:** `.history/<docId>/`, next to `users/`. Only the system and `superuser`
  can read or write it. No user or agent has a grant on it, and agents reach history through tools
  in front.
- **B. Conversation or pod root:** `conv-<sId>/.history/<docId>/` or `pod-<sId>/.history/<docId>/`.
- **C. History inside the doc:** `mydocument.md` carries its own past versions in a block at the
  end of the file, the way it already carries its comment threads.
- **D. Native DFS versioning:** DFS keeps an object's past versions itself.

## Finding a doc's history

DFS stores each object's parent but doesn't return it: the API gives an object's name, never its
parent or path, even to `superuser`
([STORAGE.md](https://github.com/dust-tt/dust/blob/9ed63a82969c4d3dfda2bbe5c499b0b62eacd88b/dfs/design-docs/STORAGE.md#L127-L128),
[API.md](https://github.com/dust-tt/dust/blob/9ed63a82969c4d3dfda2bbe5c499b0b62eacd88b/dfs/design-docs/API.md#L24-L38)).
So from a doc's ID alone, front can't find which conversation or pod it's in. Front always walks
down from a folder whose ID it already knows. Front reads and writes history with its own session.

### A. Workspace root

1. Front stores the ID of `.history/` once, like it does for `users/`.
2. `Lookup(.history, "<docId>")` returns the doc's history folder, and `List` returns its
   snapshots.

The location only depends on the doc's ID, so one lookup always finds it, wherever the doc is. It
works the same for any file type, not only co-edited Markdown.

`.history/` has no grant for anyone but the system and `superuser`, so it never shows up in a
user's or an agent's listings and there are no per-doc grants to keep in sync.

### B. Conversation or pod root

1. Front needs the doc's current conversation or pod. It knows it when the doc was opened from
   that folder. It doesn't when the doc was opened through `/shared` (a doc shared on its own),
   since all it has then is the doc's ID.
2. `Lookup(context, ".history")`, then `Lookup(.history, "<docId>")`.
3. If nothing is there, the doc may have moved from another context. Front searches the workspace
   for a folder named `<docId>`
   ([API.md: Search](https://github.com/dust-tt/dust/blob/9ed63a82969c4d3dfda2bbe5c499b0b62eacd88b/dfs/design-docs/API.md#L804-L891)).
   Search results don't include the parent, and a move needs it
   ([API.md: move](https://github.com/dust-tt/dust/blob/9ed63a82969c4d3dfda2bbe5c499b0b62eacd88b/dfs/design-docs/API.md#L760-L780)),
   so each history folder also stores its parent's ID in an xattr.
4. Front moves the folder it found into the doc's current context. Otherwise it would be deleted
   with the old context while the doc lives on.

Search lags behind writes, can be unavailable and is capped. When step 3 finds nothing, front
starts a new history in the current context. If the old one turns up later, the two have to be
merged.

### C. History inside the doc

Nothing to find: front reads the doc, and its history comes with it.

The file is the doc plus every version it keeps, and the co-edition size cap applies to the whole
file: docs over 512 KiB can't be opened in the editor
([access.ts](https://github.com/dust-tt/dust/blob/851fba0b73d86877bc4c0105bdc0342f656c16d4/front/lib/api/collab/access.ts#L72)).

### D. Native DFS versioning

Nothing to find either: DFS would return an object's versions by its ID. It also owns the whole
file lifecycle, so no caller can delete, alter or lose history, and nothing is left dangling when
a doc is deleted. But it adds a feature to DFS's API, storage and write path, with a performance
cost, for one type of document.

## When history is lost

✅ kept by design, nothing to do. ⚠️ kept only if front does extra work. ❌ lost.

| What happens | A | B | C. Inside the doc |
|---|---|---|---|
| Doc renamed, or moved within its conversation or pod | ✅ | ✅ | ✅ |
| Doc moved to another conversation or pod through Dust | ✅ | ⚠️ Only if every move path in front also moves the history. | ✅ |
| Same move from a sandbox, then the doc is opened again | ✅ | ⚠️ Only if search finds it and front moves it | ✅ |
| Same move from a sandbox, then the old context is deleted before the doc is opened again | ✅ | ❌ | ✅ |
| Search doesn't find it yet, or is down | Not used | ⚠️ Split into two histories until the old one is found and merged | Not used |
| Doc opened through `/shared` | ✅ | ⚠️ Only with a search on every open, or a stored pointer | ✅ |
| Doc rewritten as a new file (a tool saving through a temp file, or delete and recreate) | ❌ New ID, new history | ❌ Same | ⚠️ Kept only if the new file keeps the history block |
| Doc deleted | ⚠️ Removed by a cleanup job, or kept on purpose so a deleted doc's history can be recovered | ⚠️ Removed only if every delete path also deletes the history. Can be coupled with a cleanup job | ✅ Removed with the doc |
| Its conversation or pod deleted | ⚠️ Same as above | ✅ Removed with the folder | ✅ Removed with the folder |
| Someone deletes the doc's folder from a sandbox | ✅ | ✅ | ✅ |
| An agent or sandbox tool edits the doc | ✅ | ✅ | ❌ It can edit or drop the history block like any other text |
| A bad write to the doc | ✅ History is a separate object | ✅ Same | ❌ The doc and its history can be lost together, unless every write goes through a temp file and a move |
| Dropping the oldest version | ✅ Delete one file | ✅ Same | ✅ Part of the next save |

**Possible fix for B: a pointer.** Instead of searching, front could store the history folder's
ID and its parent, either in Postgres or as an xattr on the doc. This implies a second system to
keep in sync with DFS. Also an xattr on the doc can be changed by anyone who can write the doc, so
front must check that the folder it points to belongs to that doc. Both still lose history when
the old context is deleted first.

## Letting agents browse previous versions

There are two ways to do it: tools that go through front, or history visible as files in the
sandbox. In both, agents must never be able to edit or delete history.

### Through tools in front

Two tools, for example `list_document_versions` and `read_document_version`:

1. Front checks the agent can read the doc, with the agent's own session.
2. Front finds the doc's history and reads it with its own session.
3. `list_document_versions` returns each snapshot's time, reason and editors, from its xattrs.
   `read_document_version` returns one snapshot's Markdown.

- **Same in A, B and C,** apart from how front finds the history. In C, front reads it from the
  doc.
- **Read-only by construction:** agents never touch the files.
- **Works for docs shared on their own,** since access is checked on the doc.
- **Front decides what comes back:** for example the last few versions only, or a diff instead of
  the whole doc, to keep the agent's context small.
- **This is what Google does:** its API lists a file's versions by ID
  ([Drive API](https://developers.google.com/drive/api/v3/reference/revisions/list)).

### As files in the sandbox

The sandbox mount's root only lists the folders front configures, such as the conversation and
the pod
([URI.md: sandbox paths](https://github.com/dust-tt/dust/blob/9ed63a82969c4d3dfda2bbe5c499b0b62eacd88b/dfs/design-docs/URI.md#L165-L183)).
History has to be reachable from one of them, and readable by the agent's session.

**A: not exposed, by design.** `.history/` stays system and `superuser` only, and agents go
through tools. Exposing it would mean one grant per doc, which is hard to keep right:

- `.history/` is outside every folder the sandbox shows, so front would add one entry per doc to
  the mount.
- Each doc's history folder needs read grants for exactly the people who can read the doc. DFS
  can't tell front who that is, and the grants must be redone whenever sharing changes or the doc
  moves. Moves from a sandbox happen without front, so the grants drift.

**B: one grant per conversation or pod, but too broad.**

- History shows up at `conversation/.history/<docId>/`, next to the docs.
- `.history/` keeps its deny rule, and one read grant for agents on it overrides the deny
  ([API.md](https://github.com/dust-tt/dust/blob/9ed63a82969c4d3dfda2bbe5c499b0b62eacd88b/dfs/design-docs/API.md#L191-L195)).
  Everything below inherits it, read-only.
- Agents have no subject of their own today: their session holds their user's subjects. A grant
  for agents would also reach the user, so agent sessions need an extra subject first.
- Access comes from the conversation, not from each doc. An agent could read the history of a doc
  in a subfolder it can't open, and gets nothing for a doc shared on its own.

**C: already there, but nothing is protected.**

- Whoever can read the doc reads its history: no grant, no deny rule, no agent subject.
- Whoever can write the doc can edit or delete its history, agents included. Signatures, as
  planned for comments, can detect a rewrite but can't prevent erasure.
- Every agent that reads the doc reads all its versions too, unless the reading tool strips them,
  and `grep` hits old versions inside the doc itself. Agents may take old versions for current
  content.

Issues in all three:

- **Folders are named by doc ID,** an agent needs the doc's ID to find its history. Front can
  store the doc's name in an xattr on the folder, but nothing in the sandbox maps a doc to its ID
  today. This is for A and B only.
- **Old versions get mixed with current content.** `grep -r` and DFS search return hits from old
  versions next to the live doc, and an agent may not tell which is current.
- **No control over size:** the agent reads whole snapshots.

## Summary

| | A. Workspace root | B. Conversation or pod root | C. Inside the doc |
|---|---|---|---|
| Finding history | ✅ One lookup | ⚠️ Lookup, then search if the doc moved | ✅ Nothing to find |
| Doc moves | ✅ Always kept | ⚠️ Front must move it, ❌ lost in some sandbox moves | ✅ Always kept |
| Doc deleted | ⚠️ Cleanup job, or kept on purpose | ⚠️ Every delete path, plus a cleanup job | ✅ Goes with the doc |
| Conversation or pod deleted | ⚠️ Same | ✅ Goes with the folder | ✅ Goes with the folder |
| Agents browsing versions | ✅ Tools through front | ✅ Same | ✅ Same |
| Protected from edits | ✅ System and `superuser` only | ✅ | ❌ Anyone who can write the doc |
| Size limits | ✅ One read per version | ✅ Same | ❌ Counts against the doc's 512 KiB cap |
| Any file type | ✅ | ✅ | ❌ Only our co-edited Markdown |

## Also considered

- **A sidecar next to the doc** (`mydocument.md.history`). Every move or delete has to carry it
  along, and a sandbox `mv` or `rm` doesn't know about it. Renaming a doc and creating another
  with the same name mixes their histories. Most systems that used sidecars (RCS, `.svn/` before
  1.7, AppleDouble `._` files) abandoned them for these reasons.
- **The doc as a folder** holding the current version and its snapshots, like `.docx` without
  the zip. Moves work since the folder moves as one. But the doc stops being a plain file for
  agents and tools, the snapshots sit next to it with the same protection and `grep` issues as C,
  and every file type that wants history has to be wrapped this way.
- **Storing diffs instead of full copies.** Smaller, but one missing or corrupted diff breaks
  every version after it. Snapshots are full copies.

## What A needs

- **Deletion.** Every front path that deletes a doc also deletes its history folder. A periodic
  sweeper removes history whose doc no longer exists, which covers deletes from a sandbox and
  whole conversations, pods or users. Dangling history is never visible to users, so a missed
  delete only means it lives a bit longer. Later, DFS could expire files on its own (a core GCS
  feature), or we keep deleted docs' history on purpose to recover them.
- **Hiding.** A `DENY` rule on `.history/` for every user and agent session, so it stays hidden
  even if a tenant-wide grant is added later. Front reads and writes it with a system or
  `superuser` session.
- **Metadata.** xattrs are first-class in DFS. Each snapshot stores its time, reason, editors and
  the doc's `content_version`, and each history folder can store the doc's ID and name.
- **Agent tools.** `list_document_versions` and `read_document_version`, as described above.
