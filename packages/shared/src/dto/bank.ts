import { z } from "zod";
import { MoneySchema } from "../primitives.js";

export const BankTransactionRequestSchema = z.object({ amount: MoneySchema });
export type BankTransactionRequest = z.infer<typeof BankTransactionRequestSchema>;

export const BankStatusResponseSchema = z.object({ cash: MoneySchema, bank: MoneySchema });
export type BankStatusResponse = z.infer<typeof BankStatusResponseSchema>;
