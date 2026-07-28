/** Tracks whether prompt images stayed inline or were offloaded while preserving model order. */
export type PromptImageOrderEntry = "inline" | "offloaded";

// 6/28 PATCH: rename hint, PromptMediaOrderEntry is the same shape but the
// semantics broadened to cover video too (per 6/24 PATCH for minimax M3 video
// support — imageOrder is used for image AND video block ordering). Keep
// PromptImageOrderEntry as the canonical name; PromptMediaOrderEntry is the
// alias some call sites already use.
export type PromptMediaOrderEntry = PromptImageOrderEntry;
