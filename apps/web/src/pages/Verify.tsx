import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useLogout, useResendVerify, useVerify } from "../api/queries.js";
import { ErrorText } from "../components/ui.js";
import styles from "./Login.module.css";

export function Verify(): JSX.Element {
  const [searchParams] = useSearchParams();
  const codeFromUrl = searchParams.get("code") ?? "";
  const [code, setCode] = useState(codeFromUrl);
  const navigate = useNavigate();
  const verify = useVerify();
  const resend = useResendVerify();
  const logout = useLogout();
  // Guards the auto-submit against firing twice under StrictMode's double
  // effect invocation — the code is one-time-use, so a second attempt would
  // read back as invalid_code rather than a harmless no-op.
  const autoSubmitted = useRef(false);

  useEffect(() => {
    if (codeFromUrl && !autoSubmitted.current) {
      autoSubmitted.current = true;
      verify.mutate({ code: codeFromUrl }, { onSuccess: () => navigate("/") });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeFromUrl]);

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        verify.mutate({ code }, { onSuccess: () => navigate("/") });
      }}
    >
      <h1 className={styles.brand}>GL3</h1>
      <p>Check your email for a verification link, or paste the code below.</p>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="Verification code"
        aria-label="Verification code"
        autoComplete="one-time-code"
      />
      <button type="submit" disabled={verify.isPending}>Verify</button>
      <button
        type="button"
        className={styles.toggle}
        disabled={resend.isPending}
        onClick={() => resend.mutate()}
      >
        Resend email
      </button>
      {resend.isSuccess ? <p role="status">Email sent — check your inbox.</p> : null}
      <button type="button" className={styles.toggle} disabled={logout.isPending} onClick={() => logout.mutate()}>
        Log out
      </button>
      <ErrorText error={verify.error ?? resend.error} />
    </form>
  );
}
