#!/usr/bin/env python3
"""
AlphaZero-style training for Connect4.

Pipeline:
1. Self-play with MCTS guided by the current neural network.
2. Train the network on the generated (state, policy, value) examples.
3. Evaluate: accept new model only if it beats the previous best.
4. Repeat until target iterations reached.
5. Export best model to ONNX for use in the Node.js backend.

Usage:
    # Train from scratch (recommended start)
    python ml/alphazero.py --iterations 30 --games 80 --simulations 100

    # Continue from a checkpoint
    python ml/alphazero.py --iterations 30 --games 80 --resume ml/models/best_alphazero.pt

    # Export existing checkpoint to ONNX
    python ml/alphazero.py --export-only ml/models/best_alphazero.pt

Board encoding (3 channels, shape 3x6x7):
    channel 0: current player pieces  (1 where current player has a piece)
    channel 1: opponent pieces        (1 where opponent has a piece)
    channel 2: turn indicator         (all 1s if player 1's turn, all 0s if player 2's)

This encoding is shared with the Node.js inference service.
"""

from __future__ import annotations

import argparse
import math
import os
import random
import time
from collections import deque
from typing import List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, TensorDataset

# ── Constants ────────────────────────────────────────────────────────────────
ROWS = 6
COLS = 7
IN_CHANNELS = 3  # current_player, opponent, turn_indicator


def _state_legal_moves_from_encoded(state: np.ndarray) -> List[int]:
    """Infer legal columns from encoded state channels (3, 6, 7)."""
    occ_top = state[0, 0] + state[1, 0]
    return [c for c in range(COLS) if occ_top[c] < 0.5]


def _sanitize_policy_target(policy: np.ndarray, state: np.ndarray) -> np.ndarray:
    """Return a finite, normalized policy target over legal moves."""
    p = np.asarray(policy, dtype=np.float32).copy()
    valid = _state_legal_moves_from_encoded(state)
    out = np.zeros(COLS, dtype=np.float32)
    if not valid:
        return np.full(COLS, 1.0 / COLS, dtype=np.float32)

    p = np.nan_to_num(p, nan=0.0, posinf=0.0, neginf=0.0)
    p = np.maximum(p, 0.0)
    out[valid] = p[valid]
    s = float(out.sum())
    if s <= 0.0:
        out[valid] = 1.0 / len(valid)
    else:
        out /= s
    return out


def _model_has_non_finite_params(model: nn.Module) -> List[str]:
    bad: List[str] = []
    for name, param in model.state_dict().items():
        if torch.is_tensor(param) and not torch.isfinite(param).all():
            bad.append(name)
    return bad


# ══════════════════════════════════════════════════════════════════════════════
# Game environment
# ══════════════════════════════════════════════════════════════════════════════

class Connect4:
    """Mutable Connect4 game state."""

    __slots__ = ("board", "current_player", "move_count", "_last_row", "_last_col")

    def __init__(self) -> None:
        self.board = np.zeros((ROWS, COLS), dtype=np.int8)
        self.current_player = 1
        self.move_count = 0
        self._last_row = -1
        self._last_col = -1

    def reset(self) -> "Connect4":
        self.board[:] = 0
        self.current_player = 1
        self.move_count = 0
        self._last_row = self._last_col = -1
        return self

    def copy(self) -> "Connect4":
        g = Connect4()
        g.board = self.board.copy()
        g.current_player = self.current_player
        g.move_count = self.move_count
        g._last_row = self._last_row
        g._last_col = self._last_col
        return g

    def legal_moves(self) -> List[int]:
        return [c for c in range(COLS) if self.board[0, c] == 0]

    def make_move(self, col: int) -> Tuple[int, bool, int]:
        """Drop a piece in col. Returns (row, done, winner).
        winner: 0=none/draw, 1 or 2.
        """
        row = -1
        for r in range(ROWS - 1, -1, -1):
            if self.board[r, col] == 0:
                self.board[r, col] = self.current_player
                row = r
                break
        assert row != -1, f"Column {col} is full"

        self.move_count += 1
        self._last_row = row
        self._last_col = col

        if self._check_win(row, col, self.current_player):
            return row, True, self.current_player

        if not self.legal_moves():
            return row, True, 0  # draw

        self.current_player = 3 - self.current_player
        return row, False, 0

    def _check_win(self, row: int, col: int, player: int) -> bool:
        dirs = ((0, 1), (1, 0), (1, 1), (1, -1))
        for dr, dc in dirs:
            count = 1
            for s in (1, -1):
                r, c = row, col
                while True:
                    r += dr * s
                    c += dc * s
                    if 0 <= r < ROWS and 0 <= c < COLS and self.board[r, c] == player:
                        count += 1
                    else:
                        break
            if count >= 4:
                return True
        return False

    def get_encoded_state(self) -> np.ndarray:
        """Return (3, 6, 7) float32 tensor for NN input."""
        opp = 3 - self.current_player
        state = np.zeros((IN_CHANNELS, ROWS, COLS), dtype=np.float32)
        state[0] = (self.board == self.current_player).astype(np.float32)
        state[1] = (self.board == opp).astype(np.float32)
        state[2] = 1.0 if self.current_player == 1 else 0.0
        return state

    def __repr__(self) -> str:
        sym = {0: ".", 1: "X", 2: "O"}
        rows = [" ".join(sym[self.board[r, c]] for c in range(COLS)) for r in range(ROWS)]
        return "\n".join(rows) + f"\nPlayer {self.current_player} to move"


# ══════════════════════════════════════════════════════════════════════════════
# Neural network (ResNet policy-value network)
# ══════════════════════════════════════════════════════════════════════════════

class ResBlock(nn.Module):
    def __init__(self, channels: int) -> None:
        super().__init__()
        self.conv1 = nn.Conv2d(channels, channels, 3, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(channels)
        self.conv2 = nn.Conv2d(channels, channels, 3, padding=1, bias=False)
        self.bn2 = nn.BatchNorm2d(channels)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        x = F.relu(self.bn1(self.conv1(x)))
        x = self.bn2(self.conv2(x))
        return F.relu(x + residual)


class Connect4Net(nn.Module):
    """ResNet policy-value network.

    Input : (batch, 3, 6, 7)
    Output: policy_logits (batch, 7), value (batch, 1) in [-1, 1]
    """

    def __init__(self, num_res_blocks: int = 5, num_channels: int = 128) -> None:
        super().__init__()
        self.num_res_blocks = num_res_blocks
        self.num_channels = num_channels

        self.start = nn.Sequential(
            nn.Conv2d(IN_CHANNELS, num_channels, 3, padding=1, bias=False),
            nn.BatchNorm2d(num_channels),
            nn.ReLU(),
        )
        self.res_tower = nn.ModuleList(
            [ResBlock(num_channels) for _ in range(num_res_blocks)]
        )
        # Policy head → (batch, 7)
        self.policy_head = nn.Sequential(
            nn.Conv2d(num_channels, 32, 1, bias=False),
            nn.BatchNorm2d(32),
            nn.ReLU(),
            nn.Flatten(),
            nn.Linear(32 * ROWS * COLS, COLS),
        )
        # Value head → (batch, 1)
        self.value_head = nn.Sequential(
            nn.Conv2d(num_channels, 3, 1, bias=False),
            nn.BatchNorm2d(3),
            nn.ReLU(),
            nn.Flatten(),
            nn.Linear(3 * ROWS * COLS, 64),
            nn.ReLU(),
            nn.Linear(64, 1),
            nn.Tanh(),
        )

    def forward(
        self, x: torch.Tensor
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        x = self.start(x)
        for block in self.res_tower:
            x = block(x)
        return self.policy_head(x), self.value_head(x)

    @torch.no_grad()
    def predict(
        self, state: np.ndarray, device: torch.device
    ) -> Tuple[np.ndarray, float]:
        """Return (policy float32[7], value float) for a single encoded state."""
        self.eval()
        t = torch.from_numpy(state).unsqueeze(0).to(device)
        logits, value = self(t)
        policy = F.softmax(logits, dim=1).squeeze(0).cpu().numpy()
        return policy, float(value.item())


# ══════════════════════════════════════════════════════════════════════════════
# MCTS
# ══════════════════════════════════════════════════════════════════════════════

class MCTSNode:
    __slots__ = ("prior", "visit_count", "value_sum", "parent", "children")

    def __init__(self, prior: float, parent: Optional["MCTSNode"] = None) -> None:
        self.prior = prior
        self.visit_count = 0
        self.value_sum = 0.0
        self.parent = parent
        self.children: dict[int, "MCTSNode"] = {}

    # value from THIS node's current player's perspective
    @property
    def q_value(self) -> float:
        return self.value_sum / self.visit_count if self.visit_count else 0.0

    # UCB score as seen by the PARENT when picking this child.
    # Negate q_value because a high value for the child player = bad for parent.
    def ucb_for_parent(self, c_puct: float = 1.5) -> float:
        parent_n = self.parent.visit_count if self.parent else 1
        u = c_puct * self.prior * math.sqrt(parent_n) / (1 + self.visit_count)
        return -self.q_value + u

    def is_leaf(self) -> bool:
        return len(self.children) == 0


def _dirichlet_noise(
    priors: np.ndarray,
    valid_moves: List[int],
    alpha: float = 0.3,
    eps: float = 0.25,
) -> np.ndarray:
    noise = np.random.dirichlet([alpha] * len(valid_moves))
    p = priors.copy()
    for i, col in enumerate(valid_moves):
        p[col] = (1 - eps) * priors[col] + eps * noise[i]
    return p


class MCTS:
    def __init__(
        self,
        model: Connect4Net,
        device: torch.device,
        num_simulations: int = 200,
        c_puct: float = 1.5,
        add_noise: bool = True,
    ) -> None:
        self.model = model
        self.device = device
        self.num_simulations = num_simulations
        self.c_puct = c_puct
        self.add_noise = add_noise

    def search(
        self, game: Connect4, temperature: float = 1.0
    ) -> Tuple[np.ndarray, int]:
        """Run MCTS from current game state.
        Returns (action_probs [7], best_col).
        """
        root = MCTSNode(prior=1.0, parent=None)

        # ── Expand root ──────────────────────────────────────────────────────
        root_policy, _ = self.model.predict(game.get_encoded_state(), self.device)
        valid = game.legal_moves()
        root_policy = self._mask_and_normalize(root_policy, valid)
        if self.add_noise:
            root_policy = _dirichlet_noise(root_policy, valid)
        for col in valid:
            root.children[col] = MCTSNode(prior=root_policy[col], parent=root)

        # ── Simulations ──────────────────────────────────────────────────────
        for _ in range(self.num_simulations):
            node = root
            sim = game.copy()
            done = False
            winner = 0

            # 1. Selection
            while not node.is_leaf() and not done:
                col = max(
                    node.children,
                    key=lambda c: node.children[c].ucb_for_parent(self.c_puct),
                )
                _, done, winner = sim.make_move(col)
                node = node.children[col]

            # 2. Evaluation / Expansion
            if done:
                # The player who JUST moved (before make_move switched current_player)
                # is 3 - sim.current_player when game was won; winner holds who won.
                if winner == 0:
                    value = 0.0
                else:
                    # sim.current_player is the player who is NEXT to move (after win).
                    # The winner is the player who made the last move = 3 - sim.current_player.
                    # From sim.current_player's perspective: value = -1 (they lost).
                    value = -1.0
            else:
                policy, value = self.model.predict(
                    sim.get_encoded_state(), self.device
                )
                valid_sim = sim.legal_moves()
                if valid_sim:
                    policy = self._mask_and_normalize(policy, valid_sim)
                    for col in valid_sim:
                        node.children[col] = MCTSNode(
                            prior=policy[col], parent=node
                        )

            # 3. Backpropagation
            # value is from the current player's perspective at `node`.
            # Negate at each step going up (alternating players).
            cur = node
            v = value
            while cur is not None:
                cur.visit_count += 1
                cur.value_sum += v
                v = -v
                cur = cur.parent

        # ── Extract policy from visit counts ─────────────────────────────────
        visits = np.array(
            [root.children[c].visit_count if c in root.children else 0 for c in range(COLS)],
            dtype=np.float32,
        )

        if temperature == 0:
            action_probs = np.zeros(COLS, dtype=np.float32)
            action_probs[int(np.argmax(visits))] = 1.0
        else:
            log_v = np.log(visits + 1e-8) / temperature
            log_v -= log_v.max()
            visits = np.exp(log_v)
            total = visits.sum()
            action_probs = visits / total if total > 0 else visits

        return action_probs, int(np.argmax(action_probs))

    @staticmethod
    def _mask_and_normalize(policy: np.ndarray, valid: List[int]) -> np.ndarray:
        masked = np.zeros(COLS, dtype=np.float32)
        masked[valid] = policy[valid]
        s = masked.sum()
        if s > 0:
            masked /= s
        else:
            masked[valid] = 1.0 / len(valid)
        return masked


# ══════════════════════════════════════════════════════════════════════════════
# Self-play
# ══════════════════════════════════════════════════════════════════════════════

def self_play_game(
    model: Connect4Net,
    device: torch.device,
    num_simulations: int,
    temp_threshold: int = 12,
) -> Tuple[List[Tuple[np.ndarray, np.ndarray, float]], int]:
    """Play one game with MCTS. Returns (training_examples, winner)."""
    game = Connect4()
    mcts = MCTS(model, device, num_simulations=num_simulations, add_noise=True)

    states: List[np.ndarray] = []
    policies: List[np.ndarray] = []
    players: List[int] = []

    move_num = 0
    done = False
    winner = 0

    while not done:
        if not game.legal_moves():
            break
        temp = 1.0 if move_num < temp_threshold else 0.05
        state = game.get_encoded_state()
        action_probs, _ = mcts.search(game, temperature=temp)

        states.append(state)
        policies.append(action_probs)
        players.append(game.current_player)

        # Sample move from policy
        valid = game.legal_moves()
        p = action_probs.copy()
        mask = np.zeros(COLS)
        mask[valid] = 1.0
        p *= mask
        s = p.sum()
        p = p / s if s > 0 else mask / mask.sum()

        col = int(np.random.choice(COLS, p=p))
        _, done, winner = game.make_move(col)
        move_num += 1

    examples = []
    for state, policy, player in zip(states, policies, players):
        if winner == 0:
            value = 0.0
        elif winner == player:
            value = 1.0
        else:
            value = -1.0
        examples.append((state, policy, value))

    return examples, winner


def run_self_play(
    model: Connect4Net,
    device: torch.device,
    num_games: int,
    num_simulations: int,
    verbose: bool = True,
) -> List[Tuple[np.ndarray, np.ndarray, float]]:
    """Generate training data from multiple self-play games."""
    model.eval()
    all_examples: List[Tuple] = []
    wins = {0: 0, 1: 0, 2: 0}
    t0 = time.time()
    # Print at least every 4 games for typical runs so CPU jobs show heartbeat.
    log_every = min(max(1, num_games // 20), 4)

    if verbose:
        print(f"  starting self-play: games={num_games}, sims/move={num_simulations}")

    for g in range(num_games):
        examples, winner = self_play_game(model, device, num_simulations)
        all_examples.extend(examples)
        wins[winner] += 1
        if verbose and (((g + 1) % log_every == 0) or (g + 1 == num_games)):
            elapsed = time.time() - t0
            games_done = g + 1
            sec_per_game = elapsed / games_done
            eta = sec_per_game * (num_games - games_done)
            print(
                f"  game {g+1}/{num_games} | "
                f"P1={wins[1]} P2={wins[2]} D={wins[0]} | "
                f"examples={len(all_examples)} | "
                f"elapsed={elapsed:.1f}s eta={eta:.1f}s"
            )

    return all_examples


# ══════════════════════════════════════════════════════════════════════════════
# Training
# ══════════════════════════════════════════════════════════════════════════════

def train_network(
    model: Connect4Net,
    examples: List[Tuple[np.ndarray, np.ndarray, float]],
    device: torch.device,
    epochs: int = 8,
    batch_size: int = 256,
    lr: float = 1e-3,
    weight_decay: float = 1e-4,
) -> dict:
    model.train()
    model.to(device)

    bad_params = _model_has_non_finite_params(model)
    if bad_params:
        raise RuntimeError(
            "Loaded model contains non-finite parameters. "
            "Checkpoint is likely corrupted. "
            f"First bad tensors: {bad_params[:5]}"
        )

    states_np = np.array([e[0] for e in examples], dtype=np.float32)
    policies_np = np.array([e[1] for e in examples], dtype=np.float32)
    values_np = np.array([e[2] for e in examples], dtype=np.float32)

    # Remove obviously invalid examples and sanitize policy targets.
    finite_mask = (
        np.isfinite(states_np).all(axis=(1, 2, 3))
        & np.isfinite(policies_np).all(axis=1)
        & np.isfinite(values_np)
    )
    states_np = states_np[finite_mask]
    policies_np = policies_np[finite_mask]
    values_np = values_np[finite_mask]

    if len(states_np) == 0:
        raise RuntimeError("No finite training examples available after sanitization")

    for i in range(len(policies_np)):
        policies_np[i] = _sanitize_policy_target(policies_np[i], states_np[i])

    states = torch.from_numpy(states_np)
    policies = torch.from_numpy(policies_np)
    values = torch.from_numpy(values_np).unsqueeze(1)

    loader = DataLoader(
        TensorDataset(states, policies, values),
        batch_size=batch_size,
        shuffle=True,
        drop_last=False,
    )
    optimizer = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=weight_decay)

    total_p_loss = 0.0
    total_v_loss = 0.0
    batches = 0

    for epoch in range(epochs):
        for xb, pb, vb in loader:
            xb, pb, vb = xb.to(device), pb.to(device), vb.to(device)
            logits, value_pred = model(xb)
            if not torch.isfinite(logits).all() or not torch.isfinite(value_pred).all():
                raise RuntimeError(
                    "Model produced non-finite outputs during training. "
                    "Try training from a fresh checkpoint."
                )
            p_loss = -torch.mean(torch.sum(pb * F.log_softmax(logits, dim=1), dim=1))
            v_loss = F.mse_loss(value_pred, vb)
            loss = p_loss + v_loss
            if not torch.isfinite(loss):
                raise RuntimeError(
                    "Encountered non-finite loss. "
                    "Inputs/targets or checkpoint are invalid."
                )
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            total_p_loss += p_loss.item()
            total_v_loss += v_loss.item()
            batches += 1
        print(
            f"  epoch {epoch+1}/{epochs} "
            f"policy={total_p_loss/batches:.4f} "
            f"value={total_v_loss/batches:.4f}"
        )

    return {
        "policy_loss": total_p_loss / max(1, batches),
        "value_loss": total_v_loss / max(1, batches),
    }


# ══════════════════════════════════════════════════════════════════════════════
# Evaluation
# ══════════════════════════════════════════════════════════════════════════════

def evaluate_models(
    new_model: Connect4Net,
    old_model: Connect4Net,
    device: torch.device,
    num_games: int = 40,
    num_simulations: int = 80,
) -> float:
    """Return win rate of new_model vs old_model (0.0–1.0)."""
    new_wins = old_wins = draws = 0
    new_mcts = MCTS(new_model, device, num_simulations, add_noise=False)
    old_mcts = MCTS(old_model, device, num_simulations, add_noise=False)

    for i in range(num_games):
        new_plays_as = 1 if i % 2 == 0 else 2
        game = Connect4()
        done = False
        winner = 0

        while not done:
            if not game.legal_moves():
                break
            if game.current_player == new_plays_as:
                _, col = new_mcts.search(game, temperature=0)
            else:
                _, col = old_mcts.search(game, temperature=0)
            _, done, winner = game.make_move(col)

        if winner == new_plays_as:
            new_wins += 1
        elif winner == 0:
            draws += 1
        else:
            old_wins += 1

    win_rate = (new_wins + 0.5 * draws) / num_games
    print(
        f"  eval: new={new_wins} old={old_wins} draws={draws} "
        f"win_rate={win_rate:.2%}"
    )
    return win_rate


# ══════════════════════════════════════════════════════════════════════════════
# Checkpointing & ONNX export
# ══════════════════════════════════════════════════════════════════════════════

def save_checkpoint(
    model: Connect4Net, path: str, iteration: int, metadata: dict
) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    torch.save(
        {
            "model_state_dict": model.state_dict(),
            "num_res_blocks": model.num_res_blocks,
            "num_channels": model.num_channels,
            "iteration": iteration,
            "metadata": metadata,
        },
        path,
    )


def load_checkpoint(path: str, device: torch.device) -> Tuple[Connect4Net, int]:
    ckpt = torch.load(path, map_location=device)
    model = Connect4Net(
        num_res_blocks=ckpt.get("num_res_blocks", 5),
        num_channels=ckpt.get("num_channels", 128),
    ).to(device)
    model.load_state_dict(ckpt["model_state_dict"])
    bad_params = _model_has_non_finite_params(model)
    if bad_params:
        raise ValueError(
            f"Checkpoint contains non-finite parameters: {bad_params[:5]}"
        )
    return model, ckpt.get("iteration", 0)


def export_onnx(model: Connect4Net, output_path: str) -> None:
    """Export model to ONNX for Node.js inference."""
    model.eval().cpu()
    dummy = torch.zeros(1, IN_CHANNELS, ROWS, COLS, dtype=torch.float32)
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    torch.onnx.export(
        model,
        dummy,
        output_path,
        export_params=True,
        opset_version=17,
        do_constant_folding=True,
        input_names=["input"],
        output_names=["policy_logits", "value"],
        dynamic_axes={
            "input": {0: "batch_size"},
            "policy_logits": {0: "batch_size"},
            "value": {0: "batch_size"},
        },
    )
    print(f"  ONNX model saved to: {output_path}")
    print("  Input : 'input'         -> (batch, 3, 6, 7) float32")
    print("  Output: 'policy_logits' -> (batch, 7)       float32  (raw logits)")
    print("  Output: 'value'         -> (batch, 1)       float32  (tanh, -1..1)")

    try:
        import onnx
        onnx.checker.check_model(onnx.load(output_path))
        print("  ONNX check: OK")
    except ImportError:
        print("  (install 'onnx' to validate the exported model)")


# ══════════════════════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════════════════════

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="AlphaZero Connect4 training")

    p.add_argument(
        "--iterations", type=int, default=30,
        help="Number of self-play → train → eval iterations (default 30)"
    )
    p.add_argument(
        "--games", type=int, default=80,
        help="Self-play games per iteration (default 80)"
    )
    p.add_argument(
        "--simulations", type=int, default=100,
        help="MCTS simulations per move during self-play (default 100)"
    )
    p.add_argument(
        "--eval-games", type=int, default=40,
        help="Games used to evaluate new vs old model (default 40)"
    )
    p.add_argument(
        "--eval-simulations", type=int, default=80,
        help="MCTS simulations per move during evaluation (default 80)"
    )
    p.add_argument(
        "--win-threshold", type=float, default=0.55,
        help="Win rate needed to accept new model (default 0.55)"
    )
    p.add_argument(
        "--epochs", type=int, default=8,
        help="Training epochs per iteration (default 8)"
    )
    p.add_argument(
        "--batch-size", type=int, default=256, help="Batch size (default 256)"
    )
    p.add_argument(
        "--lr", type=float, default=1e-3, help="Learning rate (default 1e-3)"
    )
    p.add_argument(
        "--buffer-size", type=int, default=200_000,
        help="Max replay buffer size (default 200000)"
    )
    p.add_argument(
        "--res-blocks", type=int, default=5,
        help="Number of residual blocks (default 5)"
    )
    p.add_argument(
        "--channels", type=int, default=128,
        help="Conv channels in ResNet (default 128)"
    )
    p.add_argument(
        "--output-dir", type=str, default="ml/models",
        help="Directory for checkpoints and ONNX model"
    )
    p.add_argument(
        "--resume", type=str, default="",
        help="Resume from this checkpoint path"
    )
    p.add_argument(
        "--export-only", type=str, default="",
        help="Export this checkpoint to ONNX and exit"
    )
    p.add_argument(
        "--device", choices=["auto", "cpu", "cuda"], default="auto"
    )
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    # Device
    if args.device == "auto":
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    else:
        device = torch.device(args.device)
    print(f"[env] device={device}")

    onnx_path = os.path.join(args.output_dir, "best_alphazero.onnx")
    best_ckpt = os.path.join(args.output_dir, "best_alphazero.pt")

    # ── Export-only mode ──────────────────────────────────────────────────────
    if args.export_only:
        print(f"[export] loading {args.export_only}")
        model, it = load_checkpoint(args.export_only, torch.device("cpu"))
        export_onnx(model, onnx_path)
        return

    # ── Initialise model ─────────────────────────────────────────────────────
    start_iteration = 0
    if args.resume and os.path.exists(args.resume):
        print(f"[init] resuming from {args.resume}")
        model, start_iteration = load_checkpoint(args.resume, device)
    elif os.path.exists(best_ckpt):
        print(f"[init] resuming from {best_ckpt}")
        try:
            model, start_iteration = load_checkpoint(best_ckpt, device)
        except Exception as exc:
            print(f"[warn] failed to load best checkpoint: {exc}")
            print("[warn] creating a fresh model instead")
            model = Connect4Net(
                num_res_blocks=args.res_blocks,
                num_channels=args.channels,
            ).to(device)
    else:
        print("[init] creating new model")
        model = Connect4Net(
            num_res_blocks=args.res_blocks,
            num_channels=args.channels,
        ).to(device)

    replay_buffer: deque = deque(maxlen=args.buffer_size)

    print(f"\n{'='*60}")
    print(f"AlphaZero Connect4 Training")
    print(f"  iterations   : {args.iterations}")
    print(f"  games/iter   : {args.games}")
    print(f"  simulations  : {args.simulations}")
    print(f"  res_blocks   : {model.num_res_blocks}")
    print(f"  channels     : {model.num_channels}")
    print(f"  output_dir   : {args.output_dir}")
    print(f"{'='*60}\n")

    for it in range(start_iteration, start_iteration + args.iterations):
        t0 = time.time()
        print(f"\n{'─'*60}")
        print(f"Iteration {it + 1}  (buffer={len(replay_buffer)})")

        # ── 1. Self-play ─────────────────────────────────────────────────────
        print("[1] Self-play...")
        new_examples = run_self_play(
            model, device,
            num_games=args.games,
            num_simulations=args.simulations,
            verbose=True,
        )
        replay_buffer.extend(new_examples)
        print(f"    added {len(new_examples)} examples | buffer={len(replay_buffer)}")

        # ── 2. Train ─────────────────────────────────────────────────────────
        print("[2] Training...")
        train_data = list(replay_buffer)
        metrics = train_network(
            model, train_data, device,
            epochs=args.epochs,
            batch_size=args.batch_size,
            lr=args.lr,
        )

        # ── 3. Evaluate & accept/reject ──────────────────────────────────────
        if it > start_iteration and os.path.exists(best_ckpt):
            print("[3] Evaluating vs best model...")
            old_model, _ = load_checkpoint(best_ckpt, device)
            old_model.eval()
            model.eval()
            win_rate = evaluate_models(
                model, old_model, device,
                num_games=args.eval_games,
                num_simulations=args.eval_simulations,
            )
            if win_rate >= args.win_threshold:
                print(f"    accepted (win_rate={win_rate:.2%})")
                save_checkpoint(model, best_ckpt, it + 1, metrics)
                export_onnx(model, onnx_path)
            else:
                print(f"    rejected (win_rate={win_rate:.2%}), keeping previous best")
        else:
            print("[3] Saving as initial best model...")
            save_checkpoint(model, best_ckpt, it + 1, metrics)
            export_onnx(model, onnx_path)

        print(f"    iteration done in {time.time()-t0:.1f}s")

    print(f"\nTraining complete!")
    print(f"  Best model : {best_ckpt}")
    print(f"  ONNX model : {onnx_path}")
    print(f"\nCopy the ONNX file to use in Node.js:")
    print(f"  cp {onnx_path} connect4_api/ml/model.onnx")


if __name__ == "__main__":
    main()
