#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 OpenMV, LLC.
#
# Auto-annotate images using a pretrained YOLOv8n model.
# In --watch mode, polls the input directory for new images and
# annotates them as they arrive. Outputs JSON lines to stdout.
#
# Usage:
#   python annotate.py --input DIR --output DIR [--conf 0.25] [--watch]

import argparse
import json
import os
import sys
import time


def annotate_image(model, image_path, output_dir, conf, class_map=None):
    """Run inference on a single image and write YOLO-format labels.

    class_map: dict mapping COCO class index -> project class index.
               If None, all detections are written with their original
               COCO class IDs.
    """
    results = model(image_path, conf=conf, verbose=False)
    stem = os.path.splitext(os.path.basename(image_path))[0]
    label_path = os.path.join(output_dir, f"{stem}.txt")

    detections = 0
    lines = []
    for r in results:
        if r.boxes is None:
            continue
        for box in r.boxes:
            coco_id = int(box.cls[0])
            if class_map is not None:
                if coco_id not in class_map:
                    continue
                cls_id = class_map[coco_id]
            else:
                cls_id = coco_id
            x, y, w, h = box.xywhn[0].tolist()
            lines.append(f"{cls_id} {x:.6f} {y:.6f} {w:.6f} {h:.6f}")
            detections += 1

    with open(label_path, "w") as f:
        f.write("\n".join(lines))
        if lines:
            f.write("\n")

    return detections


def build_class_map(project_classes, coco_names):
    """Build a mapping from COCO class index to project class index.

    Matches project class names against COCO names (case-insensitive).
    Returns a dict {coco_index: project_index}, or None if no
    --classes were specified (pass all detections through).
    """
    if not project_classes:
        return None
    cmap = {}
    for proj_idx, pname in enumerate(project_classes):
        pname_lower = pname.strip().lower()
        for coco_idx, cname in coco_names.items():
            if cname.lower() == pname_lower:
                cmap[coco_idx] = proj_idx
                break
    return cmap


def main():
    ap = argparse.ArgumentParser(description="Auto-annotate images with YOLOv8n")
    ap.add_argument("--input", required=True, help="Input images directory")
    ap.add_argument("--output", required=True, help="Output labels directory")
    ap.add_argument("--model", default="yolov8n.pt", help="YOLO model path")
    ap.add_argument("--conf", type=float, default=0.25, help="Confidence threshold")
    ap.add_argument("--watch", action="store_true", help="Watch for new images")
    ap.add_argument(
        "--classes", default="",
        help="Comma-separated project class names to filter/remap COCO detections"
    )
    args = ap.parse_args()

    os.makedirs(args.output, exist_ok=True)

    # Import here so startup errors are reported clearly
    try:
        from ultralytics import YOLO
    except ImportError:
        print(json.dumps({"error": "ultralytics not installed"}), flush=True)
        sys.exit(1)

    # Load model once
    print(json.dumps({"status": "loading_model", "model": args.model}), flush=True)
    model = YOLO(args.model)
    print(json.dumps({"status": "model_ready"}), flush=True)

    # Build class mapping from project classes to COCO classes
    project_classes = [c.strip() for c in args.classes.split(",") if c.strip()] if args.classes else []
    class_map = build_class_map(project_classes, model.names)
    if project_classes:
        mapped = {model.names.get(k, k): v for k, v in class_map.items()}
        print(json.dumps({"status": "class_map", "mapping": mapped}), flush=True)

    # Track which images have been processed
    processed = set()

    # Check for already-labeled images
    if os.path.isdir(args.output):
        for f in os.listdir(args.output):
            if f.endswith(".txt"):
                processed.add(f.replace(".txt", ".jpg"))

    def process_new_images():
        """Process any new images since last poll. Returns count processed."""
        if not os.path.isdir(args.input):
            return 0
        images = sorted(
            f for f in os.listdir(args.input)
            if f.endswith(".jpg") and f not in processed
        )
        n_done = 0
        for img_name in images:
            img_path = os.path.join(args.input, img_name)
            # Skip files that might still be written
            try:
                size = os.path.getsize(img_path)
                if size == 0:
                    continue
            except OSError:
                continue

            detections = annotate_image(
                model, img_path, args.output, args.conf, class_map
            )
            processed.add(img_name)
            n_done += 1
            result = {
                "image": img_name,
                "detections": detections,
                "total_processed": len(processed),
            }
            print(json.dumps(result), flush=True)
        return n_done

    if args.watch:
        # Poll for new images until killed. Emit an "idle" event whenever
        # we transition from processing-work to no-work, so the UI can show
        # that the queue is caught up (vs hanging on the last image).
        was_busy = False
        while True:
            done_this_pass = process_new_images()
            if done_this_pass > 0:
                was_busy = True
            elif was_busy:
                print(json.dumps({
                    "status": "idle",
                    "total_processed": len(processed),
                }), flush=True)
                was_busy = False
            time.sleep(0.5)
    else:
        # One-shot: process all existing images
        process_new_images()
        print(json.dumps({"status": "done", "total": len(processed)}), flush=True)


if __name__ == "__main__":
    main()
