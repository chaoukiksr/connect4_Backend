#!/usr/bin/env python3
"""
Pre-train Connect4Net on real game data from the TiDB/MySQL database.

For each finished game stored in the `partie` table the script:
  1. Replays the move sequence (signature) step by step.
  2. At every position records:
       state  — 3-channel board encoding (identical to alphazero.py)
       policy — one-hot vector on the column that was actually played
       value  — +1 if the current player eventually won, -1 if they lost, 0 draw
  3. Trains Connect4Net with cross-entropy (policy) + MSE (value) losses,
     exactly the same objective as alphazero.py self-play training.
  4. Saves a checkpoint that can be passed to alphazero.py via --resume
     so self-play starts from a smarter initial model.

Usage:
    pip install mysql-connector-python
    python ml/pretrain_from_db.py
    python ml/pretrain_from_db.py --epochs 20 --output ml/models/pretrained.pt
    # Then kick off AlphaZero from the pre-trained weights:
    python ml/alphazero.py --iterations 30 --resume ml/models/pretrained.pt
"""

from __future__ import annotations

import argparse
import os
import sys
import time

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

# ── Load .env if present ──────────────────────────────────────────────────────
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
except ImportError:
    pass

# ── Database configuration ────────────────────────────────────────────────────
# Falls back to the values in knexfile.js if env vars are not set.
DB_CONFIG = {
    "host":     os.getenv("DB_HOST",     "gateway01.eu-central-1.prod.aws.tidbcloud.com"),
    "port":     int(os.getenv("DB_PORT", "4000")),
    "user":     os.getenv("DB_USER",     "tPqNhDuBbqhWTB8.root"),
    "password": os.getenv("DB_PASSWORD", "GWZAPxVGHv4pNM2Q"),
    "database": os.getenv("DB_NAME",     "connect4"),
    "ssl_disabled": False,
}


# ══════════════════════════════════════════════════════════════════════════════
# Database helpers
# ══════════════════════════════════════════════════════════════════════════════

def fetch_games(limit: int | None = None):
    """Return all finished standard (6×7) games from the database."""
    try:
        import mysql.connector
    except ImportError:
        print("[db] mysql-connector-python not installed.")
        print("     Run: pip install mysql-connector-python")
        sys.exit(1)

    print("[db] Connecting to database…")
    conn = mysql.connector.connect(**DB_CONFIG)
    cursor = conn.cursor(dictionary=True)

    query = """
        SELECT signature, joueur_gagnant, joueur_depart, mode, type_partie
        FROM   partie
        WHERE  status      = 'finished'
          AND  signature   IS NOT NULL
          AND  signature   != ''
          AND  LENGTH(signature) >= 7
          AND  (board_size IS NULL OR board_size = '7x6')
        ORDER BY id_partie ASC
    """
    if limit:
        query += f" LIMIT {int(limit)}"

    cursor.execute(query)
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    print(f"[db] {len(rows)} games fetched")
    return rows


# ══════════════════════════════════════════════════════════════════════════════
# Game replay → training examples
# ══════════════════════════════════════════════════════════════════════════════

def replay_to_examples(
    signature: str,
    joueur_gagnant: str | None,
    joueur_depart: str | None,
):
    """
    Replay one game and return a list of (state, policy, value) tuples.

    Convention
    ----------
    • The player who moved first (joueur_depart) is treated as player 1
      inside the Connect4 environment (which also starts with player 1).
    • value is from the *current player's* perspective at each position:
        +1  → this player will win
        -1  → this player will lose
         0  → draw
    • policy is a one-hot float32 vector of length 7 pointing at the
      column that was actually played (behaviour-cloning target).

    Returns [] for any game that cannot be replayed cleanly.
    """
    # Determine winner as player number (1 = joueur_depart, 2 = other)
    jg = joueur_gagnant if joueur_gagnant and joueur_gagnant != "null" else None
    jd = joueur_depart or "R"

    if jg is None:
        winner_player = 0          # draw
    elif jg == jd:
        winner_player = 1          # starting player won
    else:
        winner_player = 2          # second player won

    game = Connect4()              # current_player = 1 (= joueur_depart)
    examples = []

    for digit in signature:
        if not digit.isdigit():
            return []              # malformed signature

        col = int(digit) - 1      # 1-indexed → 0-indexed
        if col < 0 or col >= COLS:
            return []

        legal = game.legal_moves()
        if col not in legal:
            return []              # impossible move — corrupted data

        # ── Encode state BEFORE the move ──────────────────────────────────
        encoded = game.get_encoded_state()   # (3, 6, 7) float32

        # ── One-hot policy on the played column ───────────────────────────
        policy = np.zeros(COLS, dtype=np.float32)
        policy[col] = 1.0

        # ── Value from current player's perspective ────────────────────────
        if winner_player == 0:
            value = 0.0
        elif game.current_player == winner_player:
            value = 1.0
        else:
            value = -1.0

        examples.append((encoded, policy, value))

        _, done, _ = game.make_move(col)
        if done:
            break

    return examples


# ══════════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Pre-train Connect4Net on database games"
    )
    parser.add_argument("--epochs",     type=int,   default=15,
                        help="Training epochs (default: 15)")
    parser.add_argument("--batch-size", type=int,   default=512,
                        help="Mini-batch size (default: 512)")
    parser.add_argument("--lr",         type=float, default=5e-4,
                        help="Learning rate (default: 5e-4)")
    parser.add_argument("--res-blocks", type=int,   default=5,
                        help="ResNet blocks — ignored when --resume is set")
    parser.add_argument("--channels",   type=int,   default=128,
                        help="ResNet channels — ignored when --resume is set")
    parser.add_argument("--limit",      type=int,   default=None,
                        help="Max games to load from DB (default: all)")
    parser.add_argument("--output",     type=str,
                        default="ml/models/pretrained.pt",
                        help="Where to save the trained checkpoint")
    parser.add_argument("--resume",     type=str,   default=None,
                        help="Start from an existing checkpoint instead of a fresh model")
    parser.add_argument("--export-onnx", action="store_true",
                        help="Also export ONNX after training")
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[env] device={device}")

    # ── Model ─────────────────────────────────────────────────────────────────
    if args.resume:
        model, _ = load_checkpoint(args.resume, device)
        print(f"[model] resumed from {args.resume}")
    else:
        model = Connect4Net(args.res_blocks, args.channels).to(device)
        print(f"[model] new ({args.res_blocks} res-blocks, {args.channels} channels)")

    # ── Fetch games ───────────────────────────────────────────────────────────
    games = fetch_games(args.limit)
    if not games:
        print("[data] No games found — check DB connection or game count.")
        sys.exit(1)

    # ── Build training examples ───────────────────────────────────────────────
    print("[data] Replaying games and building examples…")
    t0 = time.time()
    all_examples = []
    skipped = 0

    modes: dict[str, int] = {}   # counts per game source (BGA / online / …)

    for i, row in enumerate(games):
        examples = replay_to_examples(
            row["signature"],
            row["joueur_gagnant"],
            row["joueur_depart"],
        )
        if examples:
            all_examples.extend(examples)
            src = row.get("mode") or "unknown"
            modes[src] = modes.get(src, 0) + 1
        else:
            skipped += 1

        if (i + 1) % 1000 == 0:
            print(
                f"  {i + 1}/{len(games)} games | "
                f"examples={len(all_examples)} | skipped={skipped}"
            )

    elapsed = time.time() - t0
    print(
        f"[data] {len(all_examples)} examples from "
        f"{len(games) - skipped} games "
        f"(skipped {skipped}) in {elapsed:.1f}s"
    )
    for src, count in sorted(modes.items()):
        print(f"  • {src}: {count} games")

    if not all_examples:
        print("[data] No valid examples — nothing to train on.")
        sys.exit(1)

    # ── Win / draw / loss distribution ───────────────────────────────────────
    vals = [e[2] for e in all_examples]
    wins   = sum(1 for v in vals if v > 0)
    losses = sum(1 for v in vals if v < 0)
    draws  = sum(1 for v in vals if v == 0)
    print(
        f"[data] value distribution — "
        f"win={wins} ({100*wins/len(vals):.0f}%) "
        f"loss={losses} ({100*losses/len(vals):.0f}%) "
        f"draw={draws} ({100*draws/len(vals):.0f}%)"
    )

    # ── Train ─────────────────────────────────────────────────────────────────
    print(f"\n[train] {args.epochs} epochs, batch={args.batch_size}, lr={args.lr}")
    print("=" * 60)

    train_network(
        model,
        all_examples,
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
            "source": "pretrain_from_db",
            "num_examples": len(all_examples),
            "num_games": len(games) - skipped,
        },
    )
    print(f"\n[save] Checkpoint → {args.output}")

    # ── Optional ONNX export ──────────────────────────────────────────────────
    if args.export_onnx:
        onnx_path = args.output.replace(".pt", ".onnx")
        export_onnx(model, onnx_path)

    print("\n" + "=" * 60)
    print("Pre-training done! Next step:")
    print(f"  python ml/alphazero.py --iterations 30 --resume {args.output}")
    print("=" * 60)


if __name__ == "__main__":
    main()
