#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 OpenMV, LLC.
#
# Train a YOLOv8n model on a labeled dataset using transfer learning.
# Reads project.json for class names, generates dataset.yaml with
# an 80/20 train/val split, and outputs JSON progress lines to stdout.
#
# Usage:
#   python train.py --project DIR --epochs 50 --imgsz 192

import argparse
import json
import os
import random
import shutil
import sys
import time


def generate_dataset(project_dir, imgsz):
    """Create dataset.yaml and split images into train/val sets.

    Only images marked 'accepted' in status.json are used for training.
    Rejected and pending images are excluded.
    """
    config_path = os.path.join(project_dir, "project.json")
    with open(config_path) as f:
        config = json.load(f)

    classes = config["classes"]
    images_dir = os.path.join(project_dir, "images")
    labels_dir = os.path.join(project_dir, "labels")

    status_path = os.path.join(project_dir, "status.json")
    status_map = {}
    if os.path.exists(status_path):
        with open(status_path) as f:
            try:
                status_map = json.load(f) or {}
            except json.JSONDecodeError:
                status_map = {}

    # Collect accepted images that have a non-empty label file
    paired = []
    skipped_unreviewed = 0
    skipped_rejected = 0
    skipped_no_labels = 0
    for img in sorted(os.listdir(images_dir)):
        if not img.endswith(".jpg"):
            continue
        stem = img.replace(".jpg", "")
        status = status_map.get(stem, "pending")
        if status == "rejected":
            skipped_rejected += 1
            continue
        if status != "accepted":
            skipped_unreviewed += 1
            continue
        label = os.path.join(labels_dir, f"{stem}.txt")
        if not os.path.exists(label) or os.path.getsize(label) == 0:
            skipped_no_labels += 1
            continue
        paired.append(stem)

    if not paired:
        print(json.dumps({
            "error": (
                "No accepted images with labels found. "
                f"Skipped: {skipped_unreviewed} unreviewed, "
                f"{skipped_rejected} rejected, "
                f"{skipped_no_labels} accepted-but-empty."
            ),
        }), flush=True)
        sys.exit(1)

    # Shuffle and split 80/20
    random.shuffle(paired)
    split = max(1, int(len(paired) * 0.8))
    train_set = paired[:split]
    val_set = paired[split:] if split < len(paired) else paired[-1:]

    # Create dataset directories
    dataset_dir = os.path.join(project_dir, "dataset")
    for subset in ["train", "val"]:
        for subdir in ["images", "labels"]:
            os.makedirs(os.path.join(dataset_dir, subset, subdir), exist_ok=True)

    # Copy files
    for stem in train_set:
        shutil.copy2(
            os.path.join(images_dir, f"{stem}.jpg"),
            os.path.join(dataset_dir, "train", "images", f"{stem}.jpg"),
        )
        shutil.copy2(
            os.path.join(labels_dir, f"{stem}.txt"),
            os.path.join(dataset_dir, "train", "labels", f"{stem}.txt"),
        )

    for stem in val_set:
        shutil.copy2(
            os.path.join(images_dir, f"{stem}.jpg"),
            os.path.join(dataset_dir, "val", "images", f"{stem}.jpg"),
        )
        shutil.copy2(
            os.path.join(labels_dir, f"{stem}.txt"),
            os.path.join(dataset_dir, "val", "labels", f"{stem}.txt"),
        )

    # Write dataset.yaml
    yaml_path = os.path.join(project_dir, "dataset.yaml")
    with open(yaml_path, "w") as f:
        f.write(f"path: {dataset_dir}\n")
        f.write("train: train/images\n")
        f.write("val: val/images\n")
        f.write(f"nc: {len(classes)}\n")
        f.write(f"names: {classes}\n")

    return (
        yaml_path,
        len(train_set),
        len(val_set),
        skipped_unreviewed,
        skipped_rejected,
    )


def main():
    ap = argparse.ArgumentParser(description="Train YOLOv8n on project dataset")
    ap.add_argument("--project", required=True, help="Project directory")
    ap.add_argument("--epochs", type=int, default=50, help="Training epochs")
    ap.add_argument("--imgsz", type=int, default=192, help="Image size")
    ap.add_argument("--model", default="yolov8n.pt", help="Base model")
    ap.add_argument("--batch", type=int, default=16, help="Batch size")
    args = ap.parse_args()

    try:
        from ultralytics import YOLO
    except ImportError:
        print(json.dumps({"error": "ultralytics not installed"}), flush=True)
        sys.exit(1)

    # Pick the fastest device available.
    import torch
    if torch.cuda.is_available():
        device = 0
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        device = "mps"
    else:
        device = "cpu"

    print(json.dumps({"status": "device_selected", "device": str(device)}), flush=True)

    # Generate dataset split
    print(json.dumps({"status": "preparing_dataset"}), flush=True)
    (yaml_path, n_train, n_val,
     n_skip_unreviewed, n_skip_rejected) = generate_dataset(args.project, args.imgsz)
    print(json.dumps({
        "status": "dataset_ready",
        "train_images": n_train,
        "val_images": n_val,
        "skipped_unreviewed": n_skip_unreviewed,
        "skipped_rejected": n_skip_rejected,
    }), flush=True)

    # Custom callback to output JSON progress
    timing = {"run_start": None, "epoch_start": None}

    def on_train_start(_trainer):
        now = time.monotonic()
        timing["run_start"] = now
        timing["epoch_start"] = now

    def on_train_epoch_end(trainer):
        metrics = trainer.metrics
        epoch = trainer.epoch + 1
        now = time.monotonic()
        epoch_secs = now - (timing["epoch_start"] or now)
        elapsed_secs = now - (timing["run_start"] or now)
        timing["epoch_start"] = now
        eta_secs = epoch_secs * max(0, args.epochs - epoch)
        result = {
            "epoch": epoch,
            "epochs": args.epochs,
            "box_loss": round(float(trainer.loss_items[0]), 4),
            "cls_loss": round(float(trainer.loss_items[1]), 4),
            "mAP50": round(float(metrics.get("metrics/mAP50(B)", 0)), 4),
            "epoch_secs": round(epoch_secs, 2),
            "elapsed_secs": round(elapsed_secs, 2),
            "eta_secs": round(eta_secs, 2),
        }
        print(json.dumps(result), flush=True)

    # Train
    print(json.dumps({"status": "training_started"}), flush=True)
    model = YOLO(args.model)
    model.add_callback("on_train_start", on_train_start)
    model.add_callback("on_train_epoch_end", on_train_epoch_end)

    results = model.train(
        data=yaml_path,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=device,
        project=os.path.join(args.project, "runs"),
        name="train",
        exist_ok=True,
        verbose=False,
    )

    # Report completion
    best_path = os.path.join(args.project, "runs", "train", "weights", "best.pt")
    print(json.dumps({
        "status": "done",
        "best_weights": best_path,
        "exists": os.path.exists(best_path),
    }), flush=True)


if __name__ == "__main__":
    main()
