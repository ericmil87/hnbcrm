import { describe, expect, it } from "vitest";
import { isVoiceNote, type InboxMessage } from "./types";

const msg = (over: Record<string, unknown>) => over as unknown as InboxMessage;
const audio = { mimeType: "audio/ogg" };

describe("isVoiceNote", () => {
  it("counts an inbox-sent audio with empty content", () => {
    expect(isVoiceNote(msg({ content: "", contentType: "audio", attachmentFiles: [audio] }))).toBe(true);
  });
  it("counts an audio attachment with whitespace content and audio contentType", () => {
    expect(isVoiceNote(msg({ content: "  ", contentType: "audio", attachmentFiles: [audio] }))).toBe(true);
  });
  it("counts bridge audio", () => {
    expect(isVoiceNote(msg({ content: "x", metadata: { bridgeType: "audio" } }))).toBe(true);
  });
  it("rejects an audio file with a free-text caption and no audio contentType", () => {
    expect(isVoiceNote(msg({ content: "segue o arquivo", contentType: "file", attachmentFiles: [audio] }))).toBe(false);
  });
  it("rejects a file message with empty content carrying an audio attachment", () => {
    expect(isVoiceNote(msg({ content: "", contentType: "file", attachmentFiles: [audio] }))).toBe(false);
  });
  it("rejects text without attachments", () => {
    expect(isVoiceNote(msg({ content: "", contentType: "text" }))).toBe(false);
  });
});
