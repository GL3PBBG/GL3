import { describe, expect, it } from "vitest";
import { identifyImage } from "../src/assets/image.js";
import { makeJpeg, makePng, makeWebp } from "./helpers/assets.js";

/**
 * The header reader is what lets this project accept uploads with no native
 * image dependency. It has two jobs and both are security-relevant: prove the
 * bytes are the format they claim, and read the size so an oversized image can
 * be refused before it is stored.
 */
describe("identifyImage", () => {
  it("reads PNG dimensions from the IHDR chunk", () => {
    expect(identifyImage(makePng(64, 32))).toEqual({ mime: "image/png", width: 64, height: 32 });
  });

  it("reads JPEG dimensions from the SOF segment, walking past earlier segments", () => {
    // makeJpeg emits an APP0 before the SOF0 on purpose: dimensions do not sit
    // at a fixed offset in JPEG, and a reader that assumes they do passes this
    // test's PNG sibling and fails on every real photo.
    expect(identifyImage(makeJpeg(120, 90))).toEqual({ mime: "image/jpeg", width: 120, height: 90 });
  });

  it("reads lossy WebP dimensions from the VP8 keyframe header", () => {
    expect(identifyImage(makeWebp(48, 24))).toEqual({ mime: "image/webp", width: 48, height: 24 });
  });

  it("returns null for bytes that are not an image at all", () => {
    expect(identifyImage(Buffer.from("<?php system($_GET['c']); ?>"))).toBeNull();
  });

  it("returns null for a truncated PNG that only carries the magic number", () => {
    // The magic number alone must not be enough. A file crafted to start with
    // the PNG signature and continue with anything else is exactly the payload
    // a content-type check by extension would wave through.
    const truncated = makePng(8, 8).subarray(0, 10);
    expect(identifyImage(truncated)).toBeNull();
  });

  it("returns null for a zero-dimension PNG", () => {
    const png = makePng(1, 1);
    png.writeUInt32BE(0, 16);
    expect(identifyImage(png)).toBeNull();
  });
});
