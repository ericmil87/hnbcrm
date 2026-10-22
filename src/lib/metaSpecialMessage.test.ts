import { describe, expect, it } from "vitest";
import {
  describeMetaCard,
  describeStoryReply,
  editHistoryOf,
  isDeletedByCustomer,
  mediaUnavailableLabel,
  reactionNoteOf,
  safeExternalUrl,
} from "./metaSpecialMessage";

describe("metaSpecialMessage", () => {
  it("ignores plain and whatsapp messages", () => {
    expect(describeMetaCard(null)).toBeNull();
    expect(describeMetaCard({ bridgeType: "poll" })).toBeNull();
    for (const t of ["text", "image", "video", "audio", "file"]) expect(describeMetaCard({ metaType: t })).toBeNull();
  });

  it("describes story, post, reel, heart, sticker, fallback", () => {
    expect(describeMetaCard({ metaType: "story_mention" })?.title).toBe("Mencionou você em um story");
    const post = describeMetaCard({ metaType: "ig_post", metaLink: { url: "https://instagram.com/p/x", title: "Foto" } });
    expect(post?.title).toBe("Compartilhou um post");
    expect(post?.subtitle).toBe("Foto");
    expect(post?.action?.label).toBe("Abrir no Instagram");
    expect(describeMetaCard({ metaType: "ig_reel", metaLink: { url: "https://instagram.com/reel/x" } })?.title).toBe(
      "Compartilhou um reel"
    );
    expect(describeMetaCard({ metaType: "like_heart" })?.title).toBe("Curtiu");
    expect(describeMetaCard({ metaType: "sticker" })?.title).toBe("Sticker");
    const fb = describeMetaCard({ metaType: "fallback", metaLink: { url: "https://x.com", title: "Artigo" } });
    expect(fb?.title).toBe("Artigo");
    expect(fb?.action?.href).toBe("https://x.com/");
  });

  it("drops unsafe links", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("not a url")).toBeNull();
    expect(safeExternalUrl(5)).toBeNull();
    expect(describeMetaCard({ metaType: "ig_post", metaLink: { url: "javascript:x" } })?.action).toBeUndefined();
    expect(describeStoryReply({ storyReply: { url: "data:text/html,x" } })).toEqual({ href: null });
  });

  it("story reply", () => {
    expect(describeStoryReply({})).toBeNull();
    expect(describeStoryReply({ storyReply: { url: "https://cdn.x/s.jpg" } })?.href).toBe("https://cdn.x/s.jpg");
    expect(describeStoryReply({ storyReply: { id: "1" } })).toEqual({ href: null });
  });

  it("media unavailable labels", () => {
    expect(mediaUnavailableLabel({})).toBeNull();
    expect(mediaUnavailableLabel({ mediaUnavailable: "expired" })).toBe("Mídia indisponível (expirou antes de baixar)");
    expect(mediaUnavailableLabel({ mediaUnavailable: "outro" })).toBe("Mídia indisponível");
  });

  it("deleted, history and note", () => {
    expect(isDeletedByCustomer({ deletedByCustomer: true })).toBe(true);
    expect(isDeletedByCustomer({ revoked: true })).toBe(false);
    expect(editHistoryOf({ editHistory: ["1", "2", "3", "4", "5", "6", ""] })).toEqual(["2", "3", "4", "5", "6"]);
    expect(editHistoryOf({})).toEqual([]);
    expect(reactionNoteOf({ reactionNote: "Reação visível só no HNBCRM" })).toBe("Reação visível só no HNBCRM");
    expect(reactionNoteOf({})).toBeNull();
  });
});
