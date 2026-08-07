import { badRequest, conflict } from "./errors.js";

export type TicTacToeMark = "X" | "O";
export type TicTacToeCell = TicTacToeMark | null;
export type TicTacToeBoard = TicTacToeCell[];

export const emptyTicTacToeBoard = (): TicTacToeBoard =>
  Array.from<TicTacToeCell>({ length: 9 }).fill(null);

const winningLines = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
] as const;

export interface TicTacToeMoveResult {
  board: TicTacToeBoard;
  outcome: "ongoing" | "won" | "draw";
  winningLine: number[] | null;
}

export const playTicTacToeMove = (
  board: TicTacToeBoard,
  mark: TicTacToeMark,
  cell: number,
): TicTacToeMoveResult => {
  if (board.length !== 9) {
    throw conflict("invalid_game_state", "The Tic-tac-toe board is invalid");
  }
  if (!Number.isSafeInteger(cell) || cell < 0 || cell > 8) {
    throw badRequest("invalid_cell", "Cell must be an integer from 0 to 8");
  }
  if (board[cell] !== null) {
    throw conflict("cell_occupied", "That cell has already been played");
  }

  const next = [...board];
  next[cell] = mark;
  const winningLine = winningLines.find((line) =>
    line.every((index) => next[index] === mark),
  );

  if (winningLine !== undefined) {
    return { board: next, outcome: "won", winningLine: [...winningLine] };
  }
  if (next.every((value) => value !== null)) {
    return { board: next, outcome: "draw", winningLine: null };
  }
  return { board: next, outcome: "ongoing", winningLine: null };
};
