import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAnswerChallenge, useChallengeQuestion, useLogout } from "../api/queries.js";
import { ErrorText } from "../components/ui.js";
import { BrandMark } from "../components/BrandMark.js";
import styles from "./Login.module.css";

/**
 * The human check a moderator can require of a suspected bot (anti-bot layer
 * 2). Sibling of Shell like /verify: every mutating request 409s
 * challenge_required while flagged, and the api client bounces here — so
 * this page must stand outside the gameplay chrome and use only GETs plus
 * the /api/challenge routes, which the gate exempts.
 */
export function Challenge(): JSX.Element {
  const [answer, setAnswer] = useState("");
  const navigate = useNavigate();
  const question = useChallengeQuestion();
  const submit = useAnswerChallenge();
  const logout = useLogout();

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (answer.trim() === "") return;
        submit.mutate(answer.trim(), {
          onSuccess: () => navigate("/"),
          onError: () => {
            setAnswer("");
            // Wrong answers burn the stored question server-side; fetch a fresh one.
            void question.refetch();
          },
        });
      }}
    >
      <BrandMark variant="login" className={styles.brand} />
      <p>A moderator flagged this account for a quick human check. Answer to keep playing.</p>
      <p aria-live="polite">{question.data?.question ?? "Loading the question…"}</p>
      <input
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="Answer"
        aria-label="Challenge answer"
        inputMode="numeric"
        autoComplete="off"
      />
      <button type="submit" disabled={submit.isPending || question.data === undefined}>Submit</button>
      <ErrorText error={submit.error ?? question.error} />
      <button
        type="button"
        className={styles.toggle}
        onClick={() => { logout.mutate(undefined, { onSuccess: () => navigate("/login") }); }}
      >
        Log out
      </button>
    </form>
  );
}
