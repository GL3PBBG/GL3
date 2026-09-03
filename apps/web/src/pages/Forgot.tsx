import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useForgot } from "@gl3/client";
import { BrandMark } from "../components/BrandMark.js";
import styles from "./Login.module.css";

export function Forgot(): JSX.Element {
  const [email, setEmail] = useState("");
  // The server always answers 200 whether or not the address is registered —
  // anti-enumeration by design. The copy below is shown the moment the form
  // is submitted, not conditioned on the response, so it can never leak that
  // distinction even on a slow or failed network round trip.
  const [submitted, setSubmitted] = useState(false);
  const forgot = useForgot();

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    forgot.mutate({ email });
  };

  if (submitted) {
    return (
      <div className={styles.form}>
        <BrandMark variant="login" className={styles.brand} />
        <p>If that address is registered, a reset link is on its way.</p>
        <p><Link to="/login">← Back to log in</Link></p>
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <BrandMark variant="login" className={styles.brand} />
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        type="email"
        placeholder="Email"
        aria-label="Email"
        autoComplete="email"
        required
      />
      <button type="submit">Send reset link</button>
      <Link to="/login">← Back to log in</Link>
    </form>
  );
}
