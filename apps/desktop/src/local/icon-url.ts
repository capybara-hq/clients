// The only icon form a local page shows. Pure (no DOM), so it is unit-tested.

const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const DATA_IMAGE_MAX = 1_500_000;

/** True for the only icon form a page shows: a base64 PNG / JPEG / WebP data: URL. */
export function isIconDataUrl(v: unknown): v is string {
  return typeof v === "string" && v.length <= DATA_IMAGE_MAX && DATA_IMAGE.test(v);
}
