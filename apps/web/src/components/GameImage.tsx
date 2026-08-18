import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import styles from "./ui.module.css";

export type GameImageSize = "sm" | "md" | "lg";

const SIZE_CLASS: Record<GameImageSize, string> = {
  sm: styles.gameImageSm as string,
  md: styles.gameImageMd as string,
  lg: styles.gameImageLg as string,
};

/**
 * Game art, with the two failure modes every image on a list page has.
 *
 * A missing binding (`url` null) and a 404 from storage are the SAME thing to a
 * player, and both are ordinary rather than exceptional: most rows carry no art
 * until an admin uploads some. So neither is an error — both render the
 * placeholder.
 *
 * The box is fixed by CSS at every state. That is the point of the component:
 * a bare `<img>` occupies zero height until its bytes arrive and then shoves
 * everything below it down the page, and a list of thirty items does that
 * thirty times.
 *
 * Every image is clickable to view full size unless `zoomable={false}`. A
 * thumbnail in a table row is otherwise a dead end — the art exists at whatever
 * resolution was uploaded and there was no way to see it.
 */
export function GameImage({ url, alt, size = "md", zoomable = true }: {
  url: string | null | undefined;
  alt: string;
  size?: GameImageSize;
  zoomable?: boolean;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  if (url === null || url === undefined || url === "" || failed) {
    // `aria-hidden` with no text: the placeholder carries no information a
    // screen reader wants, and announcing "no image" for every row of a list
    // would be worse than silence. The row's own text is the label.
    return <span className={`${styles.gameImage} ${SIZE_CLASS[size]} ${styles.gameImagePlaceholder}`} aria-hidden="true" />;
  }

  const image = (
    <img
      className={`${styles.gameImage} ${SIZE_CLASS[size]}`}
      src={url}
      alt={alt}
      // Art is below the fold on most pages and there may be dozens of it.
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );

  if (!zoomable) return image;

  return (
    <>
      {/* A real <button>, not a click handler on the <img>: keyboard focus and
          Enter/Space come free, and the control announces itself as one. */}
      <button
        type="button"
        className={styles.gameImageButton}
        title={`View ${alt} full size`}
        aria-label={`View ${alt} full size`}
        onClick={() => setZoomed(true)}
      >
        {image}
      </button>
      {zoomed ? <Lightbox url={url} alt={alt} onClose={() => setZoomed(false)} /> : null}
    </>
  );
}

/**
 * The image bound to a singleton slot, fetched by name.
 *
 * A page's view is static data built at boot, so it cannot carry a URL that
 * depends on what an admin uploaded afterwards. Both the manifest renderer's
 * `slotImage` node and the hand-written core pages (jail, hospital, casino…)
 * resolve their art through this.
 *
 * A failure is treated as "no art": this is decoration, and a page must not
 * show an error because its picture could not be looked up.
 */
export function useSlotImage(scope: string, slot: string): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<{ url: string | null }>(`/api/assets/slot/${scope}/${slot}`)
      .then((body) => { if (!cancelled) setUrl(body.url); })
      .catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; };
  }, [scope, slot]);

  return url;
}

/** `GameImage` for a singleton slot: looks the art up, then draws it. */
export function SlotImage({ scope, slot, alt, size = "lg" }: {
  scope: string;
  slot: string;
  alt: string;
  size?: GameImageSize;
}): JSX.Element | null {
  const url = useSlotImage(scope, slot);
  // Null, not a placeholder: a page banner nobody has uploaded should take up
  // no space at all, unlike a list row whose fixed box keeps the list aligned.
  if (url === null) return null;
  return <GameImage url={url} alt={alt} size={size} />;
}

/**
 * The full-size view. Deliberately plain: a backdrop, the image at its natural
 * size bounded by the viewport, and three ways out (Escape, the backdrop, the
 * close button) because a modal with one exit is a trap on some input device.
 */
function Lightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }): JSX.Element {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Focus management: `aria-modal` alone hides nothing from the keyboard. Move
  // focus onto the close button when the dialog opens, hold it there (the
  // button is the dialog's only focusable control, so trapping is keeping Tab
  // from walking out behind the overlay), and put it back on the element that
  // opened the dialog when it closes.
  useEffect(() => {
    // Mount-only: capture the opener once and restore it once, so a parent
    // re-render (which recreates onClose) cannot bounce focus mid-dialog.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => { opener?.focus(); };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  return (
    <div className={styles.lightbox} role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
      {/* Stop propagation so clicking the image itself does not close it —
          only the backdrop around it does. */}
      <img
        className={styles.lightboxImage}
        src={url}
        alt={alt}
        onClick={(event) => { event.stopPropagation(); }}
      />
      <button ref={closeRef} type="button" className={styles.lightboxClose} onClick={onClose}>Close</button>
    </div>
  );
}
