import assert from "node:assert/strict";
import test from "node:test";
import { emptyTicTacToeBoard, playTicTacToeMove } from "./tic-tac-toe.js";

test("Tic-tac-toe detects a win", () => {
  const result = playTicTacToeMove(
    ["X", "X", null, "O", "O", null, null, null, null],
    "X",
    2,
  );
  assert.equal(result.outcome, "won");
  assert.deepEqual(result.winningLine, [0, 1, 2]);
});

test("Tic-tac-toe detects a draw", () => {
  const result = playTicTacToeMove(
    ["X", "O", "X", "X", "O", "O", "O", "X", null],
    "X",
    8,
  );
  assert.equal(result.outcome, "draw");
});

test("Tic-tac-toe rejects an occupied cell", () => {
  const board = emptyTicTacToeBoard();
  board[4] = "X";
  assert.throws(() => playTicTacToeMove(board, "O", 4), {
    name: "DomainError",
  });
});
