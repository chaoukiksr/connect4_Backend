#!/usr/bin/env python3
"""
Connect4 policy-value model training with expert labels.

Workflow:
1) Generate positions from self-play using an alpha-beta expert policy.
2) Train a neural network to predict the expert move (policy head)
   and game outcome from the side-to-move perspective (value head).
3) Evaluate the trained model versus random and expert opponents.

This does not replace perfect search for absolute best play.
It gives you a fast neural policy that can later be combined with search.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import time
from dataclasses import dataclass
from typing import List, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, TensorDataset

ROWS = 6
COLS = 7
CONNECT_N = 4
WIN_SCORE = 1_000_000


def other_player(player: int) -> int:
    return 2 if player == 1 else 1


def legal_moves(board: np.ndarray) -> List[int]:
    return [c for c in range(COLS) if board[0, c] == 0]


def drop_piece(board: np.ndarray, col: int, player: int) -> int:
    for r in range(ROWS - 1, -1, -1):
        if board[r, col] == 0:
            board[r, col] = player
            return r
    return -1


def undo_piece(board: np.ndarray, row: int, col: int) -> None:
    board[row, col] = 0


def is_full(board: np.ndarray) -> bool:
    return np.all(board[0] != 0)


def check_win(board: np.ndarray, row: int, col: int, player: int) -> bool:
    dirs = ((0, 1), (1, 0), (1, 1), (1, -1))
    for dr, dc in dirs:
        count = 1
        for s in range(1, CONNECT_N):
            rr, cc = row + dr * s, col + dc * s
            if rr < 0 or rr >= ROWS or cc < 0 or cc >= COLS or board[rr, cc] != player:
                break
            count += 1
        for s in range(1, CONNECT_N):
            rr, cc = row - dr * s, col - dc * s
            if rr < 0 or rr >= ROWS or cc < 0 or cc >= COLS or board[rr, cc] != player:
                break
            count += 1
        if count >= CONNECT_N:
            return True
    return False


def score_window(window: np.ndarray, player: int) -> int:
    opp = other_player(player)
    pc = int(np.sum(window == player))
    oc = int(np.sum(window == opp))
    ec = int(np.sum(window == 0))

    if pc > 0 and oc > 0:
        return 0

    if pc == 4:
        return 2000
    if pc == 3 and ec == 1:
        return 50
    if pc == 2 and ec == 2:
        return 10

    if oc == 4:
        return -2000
    if oc == 3 and ec == 1:
        return -90
    if oc == 2 and ec == 2:
        return -15

    return 0


def evaluate_board(board: np.ndarray, player: int) -> int:
    opp = other_player(player)
    score = 0
    col_weights = [3, 4, 5, 7, 5, 4, 3]

    # Positional bonus
    for r in range(ROWS):
        for c in range(COLS):
            v = board[r, c]
            if v == player:
                score += col_weights[c]
            elif v == opp:
                score -= col_weights[c]

    # Horizontal
    for r in range(ROWS):
        for c in range(COLS - 3):
            score += score_window(board[r, c:c + 4], player)
    # Vertical
    for c in range(COLS):
        for r in range(ROWS - 3):
            score += score_window(board[r:r + 4, c], player)
    # Diagonal down-right
    for r in range(ROWS - 3):
        for c in range(COLS - 3):
            window = np.array([board[r + i, c + i] for i in range(4)], dtype=np.int8)
            score += score_window(window, player)
    # Diagonal up-right
    for r in range(3, ROWS):
        for c in range(COLS - 3):
            window = np.array([board[r - i, c + i] for i in range(4)], dtype=np.int8)
            score += score_window(window, player)

    return score


def board_key(board: np.ndarray) -> bytes:
    return board.tobytes()


def negamax(
    board: np.ndarray,
    depth: int,
    alpha: int,
    beta: int,
    player: int,
    tt: dict[Tuple[bytes, int, int], Tuple[int, int]],
) -> int:
    # key includes side-to-move to avoid cross-player collisions
    key = (board_key(board), depth, player)
    if key in tt:
        return tt[key][0]

    moves = legal_moves(board)
    if depth == 0 or not moves or is_full(board):
        val = evaluate_board(board, player)
        tt[key] = (val, -1)
        return val

    # Center-first ordering usually helps alpha-beta
    center = COLS // 2
    moves.sort(key=lambda c: abs(c - center))

    best = -math.inf
    best_move = moves[0]

    for col in moves:
        row = drop_piece(board, col, player)
        if row == -1:
            continue

        if check_win(board, row, col, player):
            score = WIN_SCORE + depth
        else:
            score = -negamax(board, depth - 1, -beta, -alpha, other_player(player), tt)

        undo_piece(board, row, col)

        if score > best:
            best = score
            best_move = col

        alpha = max(alpha, score)
        if alpha >= beta:
            break

    tt[key] = (int(best), int(best_move))
    return int(best)


def expert_move(board: np.ndarray, player: int, depth: int) -> int:
    moves = legal_moves(board)
    if not moves:
        return -1

    # Immediate win
    for col in moves:
        row = drop_piece(board, col, player)
        win = row != -1 and check_win(board, row, col, player)
        undo_piece(board, row, col)
        if win:
            return col

    # Immediate block
    opp = other_player(player)
    for col in moves:
        row = drop_piece(board, col, opp)
        win = row != -1 and check_win(board, row, col, opp)
        undo_piece(board, row, col)
        if win:
            return col

    center = COLS // 2
    ordered = sorted(moves, key=lambda c: abs(c - center))

    best_col = ordered[0]
    best_score = -math.inf
    tt: dict[Tuple[bytes, int, int], Tuple[int, int]] = {}

    alpha, beta = -math.inf, math.inf
    for col in ordered:
        row = drop_piece(board, col, player)
        if row == -1:
            continue

        if check_win(board, row, col, player):
            score = WIN_SCORE + depth
        else:
            score = -negamax(board, depth - 1, int(-beta), int(-alpha), other_player(player), tt)

        undo_piece(board, row, col)

        if score > best_score:
            best_score = score
            best_col = col

        alpha = max(alpha, score)

    return int(best_col)


def encode_state(board: np.ndarray, player_to_move: int) -> np.ndarray:
    """2-channel encoding from side-to-move perspective.
    channel 0: current player's stones
    channel 1: opponent stones
    """
    opp = other_player(player_to_move)
    ch0 = (board == player_to_move).astype(np.float32)
    ch1 = (board == opp).astype(np.float32)
    return np.stack([ch0, ch1], axis=0)


@dataclass
class DatasetBundle:
    states: np.ndarray
    policy_targets: np.ndarray
    value_targets: np.ndarray


def generate_expert_dataset(
    games: int,
    expert_depth: int,
    random_move_ratio: float,
    seed: int,
) -> DatasetBundle:
    rng = random.Random(seed)

    states: List[np.ndarray] = []
    policy_targets: List[int] = []
    value_targets: List[float] = []

    for g in range(games):
        board = np.zeros((ROWS, COLS), dtype=np.int8)
        player = 1 if rng.random() < 0.5 else 2

        game_state_idx: List[int] = []
        game_players: List[int] = []
        winner = 0

        while True:
            moves = legal_moves(board)
            if not moves:
                winner = 0
                break

            # Store training sample before move
            states.append(encode_state(board, player))
            game_state_idx.append(len(states) - 1)
            game_players.append(player)

            if rng.random() < random_move_ratio:
                move = rng.choice(moves)
            else:
                move = expert_move(board, player, expert_depth)
                if move not in moves:
                    move = rng.choice(moves)

            policy_targets.append(move)

            row = drop_piece(board, move, player)
            if row != -1 and check_win(board, row, move, player):
                winner = player
                break

            if is_full(board):
                winner = 0
                break

            player = other_player(player)

        for idx, p in zip(game_state_idx, game_players):
            if winner == 0:
                value_targets.append(0.0)
            elif p == winner:
                value_targets.append(1.0)
            else:
                value_targets.append(-1.0)

        if (g + 1) % max(1, games // 10) == 0:
            print(f"[data] generated {g + 1}/{games} games")

    return DatasetBundle(
        states=np.asarray(states, dtype=np.float32),
        policy_targets=np.asarray(policy_targets, dtype=np.int64),
        value_targets=np.asarray(value_targets, dtype=np.float32),
    )


class PolicyValueNet(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(2, 64, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.Conv2d(64, 64, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.Conv2d(64, 64, kernel_size=3, padding=1),
            nn.ReLU(),
        )
        flat_dim = 64 * ROWS * COLS

        self.policy_head = nn.Sequential(
            nn.Flatten(),
            nn.Linear(flat_dim, 256),
            nn.ReLU(),
            nn.Linear(256, COLS),
        )

        self.value_head = nn.Sequential(
            nn.Flatten(),
            nn.Linear(flat_dim, 256),
            nn.ReLU(),
            nn.Linear(256, 1),
            nn.Tanh(),
        )

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        h = self.features(x)
        policy_logits = self.policy_head(h)
        value = self.value_head(h).squeeze(-1)
        return policy_logits, value


def select_model_move(model: nn.Module, board: np.ndarray, player: int, device: torch.device) -> int:
    moves = legal_moves(board)
    if not moves:
        return -1

    x = torch.from_numpy(encode_state(board, player)).unsqueeze(0).to(device)
    with torch.no_grad():
        logits, _ = model(x)

    logits = logits.squeeze(0)
    mask = torch.full_like(logits, -1e9)
    for m in moves:
        mask[m] = 0.0
    masked_logits = logits + mask
    return int(torch.argmax(masked_logits).item())


def play_single_game(
    model: nn.Module,
    model_player: int,
    opponent_kind: str,
    opponent_depth: int,
    device: torch.device,
    rng: random.Random,
) -> int:
    board = np.zeros((ROWS, COLS), dtype=np.int8)
    player = 1 if rng.random() < 0.5 else 2

    while True:
        moves = legal_moves(board)
        if not moves:
            return 0

        if player == model_player:
            col = select_model_move(model, board, player, device)
        else:
            if opponent_kind == "random":
                col = rng.choice(moves)
            elif opponent_kind == "expert":
                col = expert_move(board, player, opponent_depth)
                if col not in moves:
                    col = rng.choice(moves)
            else:
                raise ValueError(f"Unsupported opponent kind: {opponent_kind}")

        row = drop_piece(board, col, player)
        if row != -1 and check_win(board, row, col, player):
            return player

        if is_full(board):
            return 0

        player = other_player(player)


def evaluate_model(
    model: nn.Module,
    games: int,
    opponent_kind: str,
    opponent_depth: int,
    device: torch.device,
    seed: int,
) -> dict:
    rng = random.Random(seed)

    model_wins = 0
    draws = 0
    losses = 0

    for i in range(games):
        model_player = 1 if i % 2 == 0 else 2
        winner = play_single_game(
            model=model,
            model_player=model_player,
            opponent_kind=opponent_kind,
            opponent_depth=opponent_depth,
            device=device,
            rng=rng,
        )
        if winner == 0:
            draws += 1
        elif winner == model_player:
            model_wins += 1
        else:
            losses += 1

    return {
        "games": games,
        "wins": model_wins,
        "draws": draws,
        "losses": losses,
        "win_rate": model_wins / games if games else 0.0,
        "non_loss_rate": (model_wins + draws) / games if games else 0.0,
        "opponent": opponent_kind,
        "opponent_depth": opponent_depth,
    }


def train_model(
    model: nn.Module,
    bundle: DatasetBundle,
    epochs: int,
    batch_size: int,
    lr: float,
    device: torch.device,
) -> dict:
    states_t = torch.from_numpy(bundle.states)
    policy_t = torch.from_numpy(bundle.policy_targets)
    value_t = torch.from_numpy(bundle.value_targets)

    dataset = TensorDataset(states_t, policy_t, value_t)
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=True, drop_last=False)

    model.to(device)
    opt = torch.optim.Adam(model.parameters(), lr=lr)

    history = []
    for epoch in range(1, epochs + 1):
        model.train()
        epoch_policy_loss = 0.0
        epoch_value_loss = 0.0
        batches = 0

        for xb, y_policy, y_value in loader:
            xb = xb.to(device)
            y_policy = y_policy.to(device)
            y_value = y_value.to(device)

            pred_policy, pred_value = model(xb)
            policy_loss = F.cross_entropy(pred_policy, y_policy)
            value_loss = F.mse_loss(pred_value, y_value)
            loss = policy_loss + value_loss

            opt.zero_grad()
            loss.backward()
            opt.step()

            epoch_policy_loss += float(policy_loss.item())
            epoch_value_loss += float(value_loss.item())
            batches += 1

        avg_policy = epoch_policy_loss / max(1, batches)
        avg_value = epoch_value_loss / max(1, batches)
        history.append({"epoch": epoch, "policy_loss": avg_policy, "value_loss": avg_value})
        print(
            f"[train] epoch {epoch:02d}/{epochs} "
            f"policy_loss={avg_policy:.4f} value_loss={avg_value:.4f}"
        )

    return {"history": history}


def choose_device(name: str) -> torch.device:
    if name == "cpu":
        return torch.device("cpu")
    if name == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but not available")
        return torch.device("cuda")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def save_checkpoint(
    model: nn.Module,
    out_dir: str,
    train_args: dict,
    train_metrics: dict,
    eval_random: dict,
    eval_expert: dict,
) -> str:
    os.makedirs(out_dir, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")

    model_path = os.path.join(out_dir, f"connect4_policy_value_{ts}.pt")
    meta_path = os.path.join(out_dir, f"connect4_policy_value_{ts}.json")

    torch.save(
        {
            "model_state_dict": model.state_dict(),
            "train_args": train_args,
            "train_metrics": train_metrics,
            "eval_random": eval_random,
            "eval_expert": eval_expert,
        },
        model_path,
    )

    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "model_path": model_path,
                "train_args": train_args,
                "train_metrics": train_metrics,
                "eval_random": eval_random,
                "eval_expert": eval_expert,
            },
            f,
            indent=2,
        )

    return model_path


def load_model(model_path: str, device: torch.device) -> PolicyValueNet:
    ckpt = torch.load(model_path, map_location=device)
    model = PolicyValueNet().to(device)
    model.load_state_dict(ckpt["model_state_dict"])
    model.eval()
    return model


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train a Connect4 policy-value network from expert data")

    p.add_argument("--mode", choices=["train", "evaluate"], default="train")
    p.add_argument("--model-path", type=str, default="", help="Path to .pt checkpoint for evaluate mode")

    p.add_argument("--games", type=int, default=400)
    p.add_argument("--expert-depth", type=int, default=5)
    p.add_argument("--random-move-ratio", type=float, default=0.15)

    p.add_argument("--epochs", type=int, default=15)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--lr", type=float, default=1e-3)

    p.add_argument("--evaluate-games", type=int, default=80)
    p.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--output-dir", type=str, default="ml/models")

    return p.parse_args()


def main() -> None:
    args = parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    device = choose_device(args.device)
    print(f"[env] device={device}")

    if args.mode == "evaluate":
        if not args.model_path:
            raise ValueError("--model-path is required in evaluate mode")

        model = load_model(args.model_path, device)
        eval_random = evaluate_model(
            model=model,
            games=args.evaluate_games,
            opponent_kind="random",
            opponent_depth=0,
            device=device,
            seed=args.seed,
        )
        eval_expert = evaluate_model(
            model=model,
            games=args.evaluate_games,
            opponent_kind="expert",
            opponent_depth=args.expert_depth,
            device=device,
            seed=args.seed + 1,
        )

        print("[eval] vs random:", json.dumps(eval_random, indent=2))
        print("[eval] vs expert:", json.dumps(eval_expert, indent=2))
        return

    print("[data] generating dataset...")
    bundle = generate_expert_dataset(
        games=args.games,
        expert_depth=args.expert_depth,
        random_move_ratio=args.random_move_ratio,
        seed=args.seed,
    )
    print(
        f"[data] done: samples={len(bundle.states)} "
        f"shape={tuple(bundle.states.shape)}"
    )

    model = PolicyValueNet()

    print("[train] starting...")
    train_metrics = train_model(
        model=model,
        bundle=bundle,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        device=device,
    )

    model.eval()
    eval_random = evaluate_model(
        model=model,
        games=args.evaluate_games,
        opponent_kind="random",
        opponent_depth=0,
        device=device,
        seed=args.seed,
    )
    eval_expert = evaluate_model(
        model=model,
        games=max(20, args.evaluate_games // 2),
        opponent_kind="expert",
        opponent_depth=args.expert_depth,
        device=device,
        seed=args.seed + 1,
    )

    train_args = {
        "games": args.games,
        "expert_depth": args.expert_depth,
        "random_move_ratio": args.random_move_ratio,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "lr": args.lr,
        "seed": args.seed,
        "device": str(device),
    }

    model_path = save_checkpoint(
        model=model,
        out_dir=args.output_dir,
        train_args=train_args,
        train_metrics=train_metrics,
        eval_random=eval_random,
        eval_expert=eval_expert,
    )

    print(f"[save] checkpoint: {model_path}")
    print("[eval] vs random:", json.dumps(eval_random, indent=2))
    print("[eval] vs expert:", json.dumps(eval_expert, indent=2))


if __name__ == "__main__":
    main()
