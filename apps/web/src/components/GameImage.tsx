import { useState } from "react";
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
 */
export function GameImage({ url, alt, size = "md" }: {
  url: string | null | undefined;
  alt: string;
  size?: GameImageSize;
}): JSX.Element {
  const [failed, setFailed] = useState(false);

  if (url === null || url === undefined || url === "" || failed) {
    // `aria-hidden` with an empty alt: the placeholder carries no information a
    // screen reader wants, and announcing "no image" for every row of a list
    // would be worse than silence. The row's own text is the label.
    return <span className={`${styles.gameImage} ${SIZE_CLASS[size]} ${styles.gameImagePlaceholder}`} aria-hidden="true" />;
  }

  return (
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
}
