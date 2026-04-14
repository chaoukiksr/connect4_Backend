# Connect4 ML Training

This folder adds a machine-learning pipeline to train a strong Connect4 AI model.

## What this does

- Generates training positions from an alpha-beta expert policy.
- Trains a policy-value neural network with PyTorch.
- Evaluates model strength versus random and expert opponents.

## Why this approach

For classic 6x7 Connect4, perfect search is still the strongest path to "unbeatable" play.
Machine learning is best used to speed up move selection and provide a learned policy/value that can later be combined with search.

## Setup

Install Python dependencies:

```bash
pip install -r ml/requirements.txt
```

## Train

From `connect4_api` directory:

```bash
python ml/train_connect4.py --mode train --games 800 --expert-depth 6 --epochs 20 --batch-size 256 --evaluate-games 100
```

Output checkpoints are written to `ml/models`.

## Evaluate an existing model

```bash
python ml/train_connect4.py --mode evaluate --model-path ml/models/your_model.pt --evaluate-games 120 --expert-depth 6
```

## Tips to improve strength

1. Increase `--games` to 5k+ and `--expert-depth` to 7+ if CPU allows.
2. Train longer (`--epochs 30+`) and tune learning rate (`--lr`).
3. Keep search in production and use the network for move ordering/pruning.
4. Benchmark regularly versus your existing minimax controller.
