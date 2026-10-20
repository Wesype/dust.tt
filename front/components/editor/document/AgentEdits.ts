import type { InsertedIdRange } from "@app/types/collab";
import type { ProsemirrorBinding } from "@tiptap/y-tiptap";
import * as Y from "yjs";

/**
 * Resolves the text an agent's edit inserted in a live document. The session names that text by its
 * Yjs item ids (`agent_edit`), so only the agent's own text is found, never text someone typed at
 * the same time. Reads Yjs v13 internals and the y-tiptap mapping: to replace with Yjs v14
 * attribution (`x/daph/co-edition/LIVE_SESSION.md`).
 */

export interface TextRange {
  from: number;
  to: number;
}

/** A Yjs type the binding maps to the editor's nodes. */
type BoundType =
  ProsemirrorBinding["mapping"] extends Map<infer T, unknown> ? T : never;

/** The size in the editor's document of a block the binding shows, or null if it shows none. */
const blockSize = (
  binding: ProsemirrorBinding,
  type: BoundType
): number | null => {
  if (type instanceof Y.XmlText) {
    return type.length;
  }
  const node = binding.mapping.get(type);
  return node && !Array.isArray(node) ? node.nodeSize : null;
};

/** Each type's child items at their offset inside it, computed once per resolution. */
type Offsets = Map<BoundType, Map<Y.Item, number>>;

/**
 * Where each child item of `type` starts inside it, in the editor's positions: text by its length,
 * blocks by the size of their node. Stops at a block the editor shows nowhere.
 */
const childOffsets = (
  binding: ProsemirrorBinding,
  type: BoundType,
  cache: Offsets
): Map<Y.Item, number> => {
  const cached = cache.get(type);
  if (cached) {
    return cached;
  }
  const offsets = new Map<Y.Item, number>();
  let offset = 0;
  for (let item = type._start; item; item = item.right) {
    offsets.set(item, offset);
    if (item.deleted) {
      continue;
    }
    if (item.content instanceof Y.ContentType) {
      const size = blockSize(binding, item.content.type);
      if (size === null) {
        break;
      }
      offset += size;
    } else if (item.countable) {
      offset += item.length;
    }
  }
  cache.set(type, offsets);
  return offsets;
};

/**
 * The editor's position of the character at `clock` in the text item `item`, or null when the
 * editor shows it nowhere, such as inside a deleted block. As y-tiptap's
 * `relativePositionToAbsolutePosition`, without its guard against cursors misresolving to the
 * document's start, which item ids never do, and with each type's offsets computed once.
 */
function textItemPosition(
  binding: ProsemirrorBinding,
  item: Y.Item,
  clock: number,
  cache: Offsets
): number | null {
  if (!(item.parent instanceof Y.XmlText)) {
    return null;
  }
  let type: BoundType = item.parent;
  const inText = childOffsets(binding, type, cache).get(item);
  if (inText === undefined) {
    return null;
  }
  let position = inText + clock - item.id.clock;
  while (type !== binding.type) {
    const typeItem = type._item;
    const parent = typeItem?.parent;
    if (!typeItem || typeItem.deleted || !(parent instanceof Y.AbstractType)) {
      return null;
    }
    // Into `parent`, past the blocks before `type`.
    const offset = childOffsets(binding, parent, cache).get(typeItem);
    if (offset === undefined) {
      return null;
    }
    position += 1 + offset;
    type = parent;
  }
  // The fragment is the document itself, not a block in it.
  return position - 1;
}

/**
 * @cc [owner:PopDaph,label:product] collab-agent-edit-ranges
 * The ranges MUST be exactly the text of the `inserted` items that `binding` shows, in document
 * order: each surviving text item clamped to its range, since items of one client merge across
 * changes. Items not integrated yet, deleted, inside a deleted block, or formatting alone MUST make
 * none.
 */
export function insertedTextRanges(
  binding: ProsemirrorBinding,
  inserted: InsertedIdRange[]
): TextRange[] {
  const { store } = binding.doc;
  const cache: Offsets = new Map();
  const ranges: TextRange[] = [];
  for (const { client, clock, length } of inserted) {
    const structs = store.clients.get(client);
    const end = Math.min(clock + length, Y.getState(store, client));
    if (!structs || clock >= end) {
      continue;
    }
    for (
      let index = Y.findIndexSS(structs, clock);
      index < structs.length && structs[index].id.clock < end;
      index++
    ) {
      const item = structs[index];
      if (
        !(item instanceof Y.Item) ||
        item.deleted ||
        !(item.content instanceof Y.ContentString)
      ) {
        continue;
      }
      const from = Math.max(clock, item.id.clock);
      const to = Math.min(end, item.id.clock + item.length);
      const position = textItemPosition(binding, item, from, cache);
      if (position !== null) {
        ranges.push({ from: position, to: position + to - from });
      }
    }
  }
  return ranges.sort((a, b) => a.from - b.from);
}
