import { useState } from "react";
import { useBank, useMe } from "../api/queries.js";
import { canAfford } from "../lib/money.js";
import { ErrorText, Loading, Money, Panel } from "../components/ui.js";
import styles from "./pages.module.css";

/** Mirrors MoneySchema + the server's amount_must_be_positive check. */
function isValidAmount(raw: string): boolean {
  return /^\d+$/.test(raw) && BigInt(raw) > 0n;
}

export function Bank(): JSX.Element {
  const me = useMe();
  const bank = useBank();
  const [amount, setAmount] = useState("");

  if (!me.data) return <Loading />;

  const valid = isValidAmount(amount);
  const submit = (direction: "deposit" | "withdraw"): void => {
    if (!valid) return;
    bank.mutate({ direction, amount }, { onSuccess: () => { setAmount(""); } });
  };

  return (
    <Panel title="Bank">
      <p className={styles.big}>
        <Money value={me.data.bank} />
      </p>
      <p className={styles.meta}>
        <Money value={me.data.cash} /> on hand.
      </p>

      <div className={styles.form}>
        <label>
          <span className={styles.meta}>Amount </span>
          <input
            inputMode="numeric"
            value={amount}
            placeholder="0"
            onChange={(event) => { setAmount(event.target.value.trim()); }}
          />
        </label>
        <button
          type="button"
          disabled={!valid || bank.isPending || !canAfford(me.data.cash, valid ? amount : "0")}
          onClick={() => { submit("deposit"); }}
        >
          Deposit
        </button>
        <button
          type="button"
          disabled={!valid || bank.isPending || !canAfford(me.data.bank, valid ? amount : "0")}
          onClick={() => { submit("withdraw"); }}
        >
          Withdraw
        </button>
      </div>

      {amount !== "" && !valid ? (
        <p role="alert" className={styles.bad}>Whole numbers above zero only.</p>
      ) : null}
      <ErrorText error={bank.error} />
    </Panel>
  );
}
