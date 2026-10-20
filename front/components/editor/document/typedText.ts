import type { TextRange } from "@app/components/editor/document/AgentEdits";
import type { Node } from "@tiptap/pm/model";
import { Fragment } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { StepMap } from "@tiptap/pm/transform";
import { Decoration } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

export const TYPING_SETTLE_MS = 1_000;

const replacesDocument = (transaction: Transaction): boolean =>
  !!transaction.getMeta(ySyncPluginKey)?.isChangeOrigin;

export const isSessionChange = (transaction: Transaction) =>
  replacesDocument(transaction) &&
  !transaction.getMeta(ySyncPluginKey).isUndoRedoOperation;

const diffRange = (
  before: Fragment,
  after: Fragment,
  offset: number
): number[] => {
  const start = before.findDiffStart(after);
  const end = before.findDiffEnd(after);
  if (start === null || !end) {
    return [];
  }
  const overlap = Math.max(0, start - Math.min(end.a, end.b));
  return [offset + start, end.a + overlap - start, end.b + overlap - start];
};

const diffRanges = (
  before: Fragment,
  after: Fragment,
  offset: number
): number[] => {
  if (before.childCount !== after.childCount) {
    return diffRange(before, after, offset);
  }
  const ranges: number[] = [];
  let at = offset;
  before.forEach((child, _, index) => {
    const other = after.child(index);
    if (!child.eq(other)) {
      ranges.push(
        ...(child.isTextblock || child.isLeaf || !child.sameMarkup(other)
          ? diffRange(Fragment.from(child), Fragment.from(other), at)
          : diffRanges(child.content, other.content, at + 1))
      );
    }
    at += child.nodeSize;
  });
  return ranges;
};

/**
 * @cc [owner:adrien,label:product] session-change-mapping
 * Changes applied from the session, this editor's undo and redo included, replace the whole
 * document, so positions MUST be mapped through what
 * differs between `before` and `after` instead: unchanged before the first difference, shifted by
 * the change in size after the last one. When both have as many blocks, this MUST hold for each
 * pair of blocks at the same index, and within a pair of blocks of the same type holding blocks,
 * so a block left unchanged between two changed ones keeps its positions, nested blocks included.
 */
export const diffMapping = (before: Node, after: Node): StepMap =>
  new StepMap(diffRanges(before.content, after.content, 0));

export const changeMapping = (
  transaction: Transaction,
  oldState: EditorState,
  newState: EditorState
): Mappable =>
  transaction.docChanged && replacesDocument(transaction)
    ? diffMapping(oldState.doc, newState.doc)
    : transaction.mapping;

export const mapRanges = (ranges: TextRange[], mapping: Mappable) =>
  ranges
    .map(({ from, to }) => ({
      from: mapping.map(from, 1),
      to: mapping.map(to, -1),
    }))
    .filter(({ from, to }) => to > from);

export const typedLength = (ranges: TextRange[]) =>
  ranges.reduce((length, { from, to }) => length + to - from, 0);

const typedBand = (
  color: string,
  { from, to }: TextRange,
  settled: boolean
): Decoration =>
  Decoration.inline(
    from,
    to,
    {
      class: "collab-typed",
      style: `--typed-color: ${color}`,
      ...(settled ? { "data-settled": "" } : {}),
    },
    { typedText: true }
  );

/**
 * @cc [owner:adrien,label:product] typed-text-bands
 * The first `revealed` characters of `ranges` MUST be banded in `color` (`collab-typed`), one band
 * per text block running from the block's first range to the end of what is revealed in it. A band
 * MUST be settled when `settled` is set or once more than its block's text is revealed.
 */
export const typedBands = (
  doc: Node,
  color: string,
  ranges: TextRange[],
  revealed: number,
  settled: boolean
): Decoration[] => {
  const bands: Decoration[] = [];
  let band: { block: number; range: TextRange; endOffset: number } | null =
    null;
  const close = () => {
    if (band && band.range.to > band.range.from) {
      bands.push(
        typedBand(color, band.range, settled || revealed > band.endOffset)
      );
    }
  };
  let offset = 0;
  for (const { from, to } of ranges) {
    const block = doc.resolve(from).start();
    if (!band || band.block !== block) {
      close();
      band = { block, range: { from, to: from }, endOffset: offset };
    }
    const shown = Math.min(Math.max(revealed - offset, 0), to - from);
    if (shown > 0) {
      band.range.to = from + shown;
    }
    offset += to - from;
    band.endOffset = offset;
  }
  close();
  return bands;
};
