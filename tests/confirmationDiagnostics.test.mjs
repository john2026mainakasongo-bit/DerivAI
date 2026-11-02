import test from "node:test";
import assert from "node:assert/strict";
import { confirmationDiagnostics } from "../src/utils/confirmationDiagnostics.js";
test("No setup returns WAIT", () => {
  assert.equal(confirmationDiagnostics(null).state, "WAIT");
});
test("Pending tap returns WAIT", () => {
  assert.equal(confirmationDiagnostics({
    status: "Tap observed",
    entered: false,
    tapEpoch: 1000,
    seconds: 300,
    lastEpoch: 1100,
    candles: []
  }).state, "WAIT");
});
test("Confirmed entry returns CONFIRMED", () => {
  assert.equal(confirmationDiagnostics({
    status: "Entry confirmed",
    side: "BUY",
    entered: true
  }).state, "CONFIRMED");
});
test("Closed trade never returns CONFIRMED", () => {
  for (const status of [
    "SL touched",
    "TP2 touched",
    "TP3 touched",
    "Invalidated",
    "Expired"
  ]) {
    assert.equal(confirmationDiagnostics({
      status,
      side: "BUY",
      entered: true
    }).state, "CLOSED");
  }
});
test("Unverified data gap blocks confirmation", () => {
  assert.equal(confirmationDiagnostics({
    status: "Tap observed",
    entered: false,
    gapUnverified: true
  }).state, "BLOCKED");
});
