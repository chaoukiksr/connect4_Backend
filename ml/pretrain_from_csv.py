#!/usr/bin/env python3
"""
Pre-train Connect4Net on real game data from a CSV file.

For each finished game the script:
  1. Replays the move sequence step by step.
  2. At every position records:
       state  — 3-channel board encoding (identical to alphazero.py)
       policy — one-hot vector on the column that was actually played
       value  — +1 if the current player eventually won, -1 if they lost, 0 draw
  3. Trains Connect4Net with cross-entropy (policy) + MSE (value) losses,
     exactly the same objective as alphazero.py self-play training.
  4. Saves a .pt checkpoint AND exports the ONNX model that the Node.js
     backend picks up automatically on the next server restart.

CSV format expected (9 columns, comma-separated, quoted):
  id, partie_id, coups, joueur_gagnant, couleur_gagnant,
  ligne_gagnante, mode_jeu, statut, created_at

Usage:
    # Basic — train on all TERMINEE games in the CSV
    python ml/pretrain_from_csv.py --csv ../../merged_bdd.csv

    # Limit games to avoid RAM issues on a small machine
    python ml/pretrain_from_csv.py --csv ../../merged_bdd.csv --limit 50000

    # More epochs, bigger model, export ONNX automatically
    python ml/pretrain_from_csv.py --csv ../../merged_bdd.csv \\
        --epochs 25 --res-blocks 7 --channels 192 --export-onnx

    # Resume from an existing checkpoint (keeps architecture)
    python ml/pretrain_from_csv.py --csv ../../merged_bdd.csv \\
        --resume ml/models/pretrained_csv.pt

    # Then kick off full AlphaZero self-play from the pre-trained weights:
    python ml/alphazero.py --iterations 20 --resume ml/models/pretrained_csv.pt

System safety:
    The script never touches the RUNNING model (best_alphazero.onnx) until the
    very end when --export-onnx is passed and training completed successfully.
    The Node.js backend keeps using the existing model during the whole run.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from typing import List, Optional, Tuple

import numpy as np
import torch

# ── Import shared code from alphazero.py ─────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from alphazero import (
    COLS,
    IN_CHANNELS,
    ROWS,
    Connect4,
    Connect4Net,
    export_onnx,
    load_checkpoint,
    save_checkpoint,
    train_network,
)

# ── Default paths ─────────────────────────────────────────────────────────────
DEFAULT_OUTPUT   = os.path.join(os.path.dirname(__file__), "models", "pretrained_csv.pt")
DEFAULT_ONNX_OUT = os.path.join(os.path.dirname(__file__), "models", "best_alphazero.onnx")


# ==============================================================================
# CSV loading
# ==============================================================================

def load_csv_games(
    csv_path: str,
    limit: Optional[int] = None,
) -> List[dict]:
    """
    Read the CSV and return a list of dicts for TERMINEE (finished) games only.
    Columns used: coups, statut.
    Unknown or extra columns are silently ignored.
    """
    games = []
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            statut = row.get("statut", "").strip().upper()
            if statut != "TERMINEE":
                continue
            coups = row.get("coups", "").strip()
            if not coups:
                continue
            games.append({"coups": coups})
            if limit and len(games) >= limit:
                break

    print(f"[csv] {len(games)} TERMINEE games loaded from {csv_path}")
    return games


# ==============================================================================
# Game replay helpers
# ==============================================================================

def parse_coups(coups_str: str) -> List[int]:
    """
    Parse "(4434452...)" into a list of 0-indexed column numbers.
    Returns [] (skip this game) if any digit is out of [1, COLS].

    The coups field uses 1-indexed column numbers. Column '8' or '0' would
    indicate a non-standard board — those games are skipped automatically.
    """
    cleaned = coups_str.strip().strip("()")
    moves = []
    for ch in cleaned:
        if not ch.isdigit():
            continue        # ignore parentheses or spaces inside the string
        col = int(ch) - 1  # 1-indexed -> 0-indexed
        if col < 0 or col >= COLS:
            return []       # non-standard board size — skip whole game
        moves.append(col)
    return moves


def replay_to_examples(
    moves: List[int],
) -> List[Tuple[np.ndarray, np.ndarray, float]]:
    """
    Replay a game and return (state, policy, value) training tuples.

    Winner is determined by actually replaying the moves — this is 100%
    reliable and does not depend on potentially empty DB fields.

    Value convention (from the *current* player's perspective):
        +1  this player eventually won
        -1  this player eventually lost
         0  draw (board full, no winner)

    Returns [] if the move sequence is corrupted or impossible to replay.
    """
    game   = Connect4()
    snapshots: List[Tuple[np.ndarray, int, int]] = []  # (encoded, col, player)
    winner = 0

    for col in moves:
        if col not in game.legal_moves():
            return []   # corrupted move — skip whole game

        encoded = game.get_encoded_state()          # (3, 6, 7) float32
        snapshots.append((encoded, col, game.current_player))

        _, done, w = game.make_move(col)
        if done:
            winner = w  # 0 = draw, 1 or 2 = winner
            break

    if not snapshots:
        return []

    examples: List[Tuple[np.ndarray, np.ndarray, float]] = []
    for encoded, col, player in snapshots:
        policy = np.zeros(COLS, dtype=np.float32)
        policy[col] = 1.0

        if winner == 0:
            value = 0.0
        elif winner == player:
            value = 1.0
        else:
            value = -1.0

        examples.append((encoded, policy, value))

    return examples


# ==============================================================================
# Build dataset
# ==============================================================================

def build_examples(
    games: List[dict],
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Replay all games and stack examples into numpy arrays.
    Returns (states, policies, values) ready for training.

    Memory estimate:
        Each example = (3*6*7 + 7 + 1) float32 = 134 values = ~536 bytes
        1 million examples ~ 536 MB
        Average game ~ 35 moves, so 1M examples ~ 28 600 games
    """
    all_states:   List[np.ndarray] = []
    all_policies: List[np.ndarray] = []
    all_values:   List[float]      = []

    skipped = 0
    t0 = time.time()

    for i, row in enumerate(games, 1):
        moves = parse_coups(row["coups"])
        if not moves:
            skipped += 1
            continue

        examples = replay_to_examples(moves)
        if not examples:
            skipped += 1
            continue

        for state, policy, value in examples:
            all_states.append(state)
            all_policies.append(policy)
            all_values.append(value)

        if i % 10_000 == 0:
            elapsed = time.time() - t0
            rate    = i / elapsed
            eta     = (len(games) - i) / rate if rate > 0 else 0
            print(
                f"  {i:>7}/{len(games)}  examples={len(all_states):>8}  "
                f"skipped={skipped}  speed={rate:.0f} games/s  "
                f"ETA={eta:.0f}s"
            )

    elapsed = time.time() - t0
    valid   = len(games) - skipped
    print(
        f"[data] {len(all_states)} examples from {valid} games "
        f"(skipped {skipped} / {len(games)}) in {elapsed:.1f}s"
    )

    if not all_states:
        return np.empty(0), np.empty(0), np.empty(0)

    # Stack into contiguous arrays (single large allocation)
    states   = np.stack(all_states,   axis=0).astype(np.float32)   # (N, 3, 6, 7)
    policies = np.stack(all_policies, axis=0).astype(np.float32)   # (N, 7)
    values   = np.array(all_values,             dtype=np.float32)  # (N,)

    # Value distribution stats
    wins   = int((values  > 0).sum())
    losses = int((values  < 0).sum())
    draws  = int((values == 0).sum())
    n      = len(values)
    print(
        f"[data] value distribution — "
        f"win={wins} ({100*wins/n:.0f}%)  "
        f"loss={losses} ({100*losses/n:.0f}%)  "
        f"draw={draws} ({100*draws/n:.0f}%)"
    )

    mem_gb = (states.nbytes + policies.nbytes + values.nbytes) / 1e9
    print(f"[data] dataset RAM usage: {mem_gb:.2f} GB")

    return states, policies, values


# ==============================================================================
# Cache helpers (avoids re-processing the CSV on repeated runs)
# ==============================================================================

def save_cache(path: str, states: np.ndarray, policies: np.ndarray, values: np.ndarray) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    np.savez_compressed(path, states=states, policies=policies, values=values)
    size_mb = os.path.getsize(path) / 1e6
    print(f"[cache] saved to {path} ({size_mb:.0f} MB)")


def load_cache(path: str) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    data = np.load(path)
    states, policies, values = data["states"], data["policies"], data["values"]
    print(f"[cache] loaded {len(states)} examples from {path}")
    return states, policies, values


# ==============================================================================
# Training wrapper that works on pre-built numpy arrays
# ==============================================================================

def train_on_arrays(
    model: Connect4Net,
    states: np.ndarray,
    policies: np.ndarray,
    values: np.ndarray,
    device: torch.device,
    epochs: int,
    batch_size: int,
    lr: float,
) -> None:
    """Wrap numpy arrays into (state, policy, value) tuples for train_network."""
    examples = list(zip(states, policies, values.tolist()))
    train_network(model, examples, device, epochs=epochs, batch_size=batch_size, lr=lr)


# ==============================================================================
# Main
# ==============================================================================

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Pre-train Connect4Net from a CSV game dataset",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--csv", required=True,
        help="Path to the CSV file (merged_bdd.csv or similar)",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Max number of games to load (None = all). "
             "Use this to cap RAM usage on smaller machines.",
    )
    parser.add_argument(
        "--epochs", type=int, default=20,
        help="Training epochs",
    )
    parser.add_argument(
        "--batch-size", type=int, default=512,
        help="Mini-batch size",
    )
    parser.add_argument(
        "--lr", type=float, default=3e-4,
        help="Learning rate",
    )
    parser.add_argument(
        "--res-blocks", type=int, default=5,
        help="ResNet blocks (ignored when --resume is set)",
    )
    parser.add_argument(
        "--channels", type=int, default=128,
        help="ResNet channels (ignored when --resume is set)",
    )
    parser.add_argument(
        "--resume", type=str, default=None,
        help="Resume from an existing .pt checkpoint",
    )
    parser.add_argument(
        "--output", type=str, default=DEFAULT_OUTPUT,
        help="Where to save the trained checkpoint (.pt)",
    )
    parser.add_argument(
        "--export-onnx", action="store_true",
        help="Export best_alphazero.onnx after training (activates the new model)",
    )
    parser.add_argument(
        "--onnx-out", type=str, default=DEFAULT_ONNX_OUT,
        help="Path for the ONNX export",
    )
    parser.add_argument(
        "--cache", type=str, default=None,
        help="Path to a .npz cache file. If it exists, skip CSV processing and "
             "load directly. If it doesn't exist, process CSV and save cache here.",
    )
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    gpu_info = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU only"
    print(f"[env] device={device}  ({gpu_info})")
    print(f"[env] PyTorch {torch.__version__}")
    print()

    # ── Model ─────────────────────────────────────────────────────────────────
    if args.resume:
        model, meta = load_checkpoint(args.resume, device)
        print(f"[model] resumed from {args.resume}  metadata={meta}")
    else:
        model = Connect4Net(args.res_blocks, args.channels).to(device)
        params = sum(p.numel() for p in model.parameters())
        print(
            f"[model] new ResNet  res_blocks={args.res_blocks}  "
            f"channels={args.channels}  params={params:,}"
        )
    print()

    # ── Dataset ───────────────────────────────────────────────────────────────
    if args.cache and os.path.exists(args.cache):
        states, policies, values = load_cache(args.cache)
    else:
        games = load_csv_games(args.csv, limit=args.limit)
        if not games:
            print("[data] No TERMINEE games found in CSV. Check the file path and format.")
            sys.exit(1)

        print(f"[data] Replaying {len(games)} games…")
        states, policies, values = build_examples(games)

        if len(states) == 0:
            print("[data] No valid examples generated. All games may have invalid moves.")
            sys.exit(1)

        if args.cache:
            save_cache(args.cache, states, policies, values)

    print(f"\n[train] {len(states)} examples  "
          f"epochs={args.epochs}  batch={args.batch_size}  lr={args.lr}")
    print("=" * 60)

    # ── Train ─────────────────────────────────────────────────────────────────
    train_on_arrays(
        model, states, policies, values,
        device,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
    )

    # ── Save checkpoint ────────────────────────────────────────────────────────
    save_checkpoint(
        model,
        args.output,
        iteration=0,
        metadata={
            "source":       "pretrain_from_csv",
            "num_examples": int(len(states)),
            "num_games":    args.limit or "all",
            "epochs":       args.epochs,
        },
    )
    print(f"\n[save] Checkpoint saved → {args.output}")

    # ── ONNX export (activates the new model in Node.js) ──────────────────────
    if args.export_onnx:
        os.makedirs(os.path.dirname(args.onnx_out) or ".", exist_ok=True)
        export_onnx(model, args.onnx_out)
        print(f"[onnx] Model exported → {args.onnx_out}")
        print("[onnx] Restart the Node.js server to load the new model.")

    print()
    print("=" * 60)
    print("Pre-training done!")
    print()
    print("Next steps:")
    print(f"  1. Test the new model:")
    print(f"       node -e \"require('./services/mlService').loadModel()\"")
    print(f"  2. (Optional) Run AlphaZero self-play to sharpen it further:")
    print(f"       python ml/alphazero.py --iterations 20 --resume {args.output}")
    print("=" * 60)


if __name__ == "__main__":
    main()
