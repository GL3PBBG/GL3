import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useReset } from "../api/queries.js";
import { ErrorText } from "../components/ui.js";
import styles from "./Login.module.css";

export function Reset(): JSX.Element {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const navigate = useNavigate();
  const reset = useReset();

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setValidationError(null);
    if (password.length < 8) {
      setValidationError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setValidationError("Passwords don't match.");
      return;
    }
    reset.mutate(
      { token, password },
      { onSuccess: () => navigate("/login", { state: { passwordChanged: true } }) },
    );
  };

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <h1 className={styles.brand}>GL3</h1>
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        placeholder="New password"
        aria-label="New password"
        autoComplete="new-password"
      />
      <input
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        type="password"
        placeholder="Confirm password"
        aria-label="Confirm password"
        autoComplete="new-password"
      />
      <button type="submit" disabled={reset.isPending}>Set new password</button>
      {validationError ? <p role="alert">{validationError}</p> : <ErrorText error={reset.error} />}
    </form>
  );
}
