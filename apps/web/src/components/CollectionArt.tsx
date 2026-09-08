import { GameImage } from "./GameImage.js";
import styles from "./Collection.module.css";

export type CollectionKind = "car" | "firearm" | "melee" | "armor";

/** Large, zoomable game art with a quiet silhouette for an unfilled slot. */
export function CollectionArt({ url, name, kind }: { url?: string | undefined; name: string; kind: CollectionKind }): JSX.Element {
  return <div className={styles.art}>
    {url ? <GameImage key={url} url={url} alt={name} size="lg" /> : <svg className={styles.silhouette} viewBox="0 0 160 100" fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" aria-hidden="true">
      {kind === "car" ? <>
        <path d="m19 58 12-24h72l23 22 18 5v20H16V62Z" />
        <path d="m37 39-8 17h87L99 39ZM67 39v17M20 67h16m91 0h12M77 66h12" />
        <circle cx="43" cy="80" r="12" fill="var(--surface-sunk)" /><circle cx="117" cy="80" r="12" fill="var(--surface-sunk)" />
        <circle cx="43" cy="80" r="4" /><circle cx="117" cy="80" r="4" />
      </> : kind === "firearm" ? <>
        <path d="M25 26h110v23H78l-9 33H40l9-33H25Z" /><path d="M79 49v15H69M32 33h96M45 55h21M43 64h20M41 73h19" />
      </> : kind === "melee" ? <>
        <path d="m43 82 61-65q10-9 17-2t-2 17L53 92ZM57 68l10 10M61 62l11 11M66 57l11 11M43 82l10 10" />
      </> : <>
        <path d="M56 13 40 22l-9 31 16 6v30h66V59l16-6-9-31-16-9-10 17H66Z" /><path d="M80 33v51M53 44h20v15H53ZM87 44h20v15H87ZM54 67h19v13H54ZM87 67h19v13H87Z" />
      </>}
    </svg>}
  </div>;
}
