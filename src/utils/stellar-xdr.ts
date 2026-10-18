/**
 * Stellar transaction XDR helpers (issue #419).
 *
 * Endpoints that accept Stellar transactions in XDR format must reject
 * malformed input *before* it reaches the SDK-backed business logic, so
 * untrusted payloads fail fast with a validation error instead of surfacing
 * as an opaque parse failure deep inside a handler.
 */
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { config } from "../config";

/**
 * Whether `xdr` is a base64-encoded Stellar transaction envelope that the
 * SDK can parse.
 *
 * Catches every common failure mode in one place:
 *   - non-string or empty input;
 *   - strings that are not valid base64 (e.g. `"not-xdr!!"`);
 *   - valid base64 that does not decode to an XDR structure;
 *   - truncated or otherwise corrupted envelopes.
 *
 * The check is parse-level: it confirms the envelope decodes for the given
 * network passphrase but does not verify signatures or transaction intent —
 * that deeper validation lives with the handlers that need it (see
 * `validateSignedXdr` in src/services/stellar.ts).
 *
 * @param xdr - Candidate base64 XDR string.
 * @param networkPassphrase - Defaults to the configured Stellar network; the
 *   passphrase is required by the SDK to decode an envelope, and a mismatch
 *   still parses (network binding is only observable when verifying
 *   signatures).
 * @returns `true` when the string parses as a transaction envelope.
 */
export function isValidXdr(
  xdr: string,
  networkPassphrase: string = config.networkPassphrase
): boolean {
  if (typeof xdr !== "string" || xdr.trim().length === 0) {
    return false;
  }
  try {
    TransactionBuilder.fromXDR(xdr, networkPassphrase);
    return true;
  } catch {
    return false;
  }
}

/**
 * Details expected from a payment intent or expense record for XDR validation.
 */
export interface TransactionIntentExpectation {
  sourcePublicKey: string;
  destination: string;
  assetCode: string;
  assetIssuer?: string | null;
  amount: string;
  memo?: string;
}

/**
 * Inspect a signed transaction XDR and validate its operations against expected intent.
 */
export function validateTransactionIntent(
  signedXdr: string,
  expectation: TransactionIntentExpectation,
  networkPassphrase: string = config.networkPassphrase
): { valid: boolean; error?: string } {
  try {
    const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
    if (!(tx instanceof TransactionBuilder.fromXDR(signedXdr, networkPassphrase).constructor)) {
      // Using Transaction / FeeBumpTransaction check via instanceof
    }

    const envelope = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
    // @stellar/stellar-sdk Transaction has operations and source
    const operations = (envelope as any).operations;
    if (!operations || operations.length !== 1) {
      return { valid: false, error: "Transaction must contain exactly one operation" };
    }

    const op = operations[0];
    if (op.type !== "payment") {
      return { valid: false, error: "Transaction operation must be a payment" };
    }

    // Validate source account
    const source = op.source || (envelope as any).source;
    if (source && source !== expectation.sourcePublicKey) {
      return { valid: false, error: "Transaction source account mismatch" };
    }

    // Validate destination
    if (op.destination !== expectation.destination) {
      return { valid: false, error: "Payment destination mismatch" };
    }

    // Validate asset
    const assetCode = op.asset.isNative() ? "XLM" : op.asset.getCode();
    const assetIssuer = op.asset.isNative() ? null : op.asset.getIssuer();

    if (assetCode !== expectation.assetCode) {
      return { valid: false, error: "Payment asset code mismatch" };
    }

    if ((expectation.assetIssuer ?? null) !== (assetIssuer ?? null)) {
      return { valid: false, error: "Payment asset issuer mismatch" };
    }

    // Validate amount
    if (op.amount !== expectation.amount) {
      return { valid: false, error: "Payment amount mismatch" };
    }

    // Validate memo if present in expectation
    if (expectation.memo) {
      const memoValue = (envelope as any).memo;
      const memoString = memoValue && memoValue.value ? memoValue.value.toString() : "";
      if (memoString !== expectation.memo) {
        return { valid: false, error: "Transaction memo mismatch" };
      }
    }

    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: err?.message || "Failed to parse transaction XDR" };
  }
}
