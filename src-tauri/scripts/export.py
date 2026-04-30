#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 OpenMV, LLC.
#
# Export a trained YOLOv8n model to int8-quantized TFLite matching the
# reference yolov8n_192.tflite IO contract: uint8 IN (scale 1/255, zp 0),
# float32 OUT, full int8 internal graph.
#
# Pipeline:
#   1. Load .pt and apply Ultralytics' tf_wrapper Detect-head patch (this
#      normalizes the bbox decode by stride/grid so cls and bbox share a
#      [0, 1] range before the final Concat -- without this, int8 quant
#      collapses class scores to ~0.01-0.02).
#   2. Export the patched model to ONNX.
#   3. Build calibration data from the project images (BHWC float32 [0, 255]).
#   4. Call onnx2tf directly with input_quant_dtype="uint8" and
#      output_quant_dtype="float32" (Ultralytics' built-in YOLO.export() does
#      not expose those flags).
#   5. Copy the _full_integer_quant.tflite variant -- it has uint8 IN /
#      float32 OUT and a fully int8 quantized internal graph, matching the
#      reference model the camera firmware/NPU expects.
#
# TF must be imported BEFORE onnx/onnx2tf. If onnx loads first, its bundled
# abseil shadows TF's libtensorflow_framework copy and the int8 calibration
# loop deadlocks in Notification::WaitForNotification.
#
# Usage:
#   python export.py --project DIR --imgsz 192

import tensorflow as tf  # noqa: F401  MUST be first - see header comment

import argparse
import json
import os
import shutil
import sys

import numpy as np


def main():
    ap = argparse.ArgumentParser(description="Export YOLOv8 to TFLite")
    ap.add_argument("--project", required=True, help="Project directory")
    ap.add_argument("--imgsz", type=int, default=192, help="Image size")
    args = ap.parse_args()

    best_pt = os.path.join(args.project, "runs", "train", "weights", "best.pt")
    if not os.path.exists(best_pt):
        print(json.dumps({"error": "No trained model found (best.pt)"}), flush=True)
        sys.exit(1)

    data_yaml = os.path.join(args.project, "dataset.yaml")
    if not os.path.exists(data_yaml):
        print(json.dumps({"error": "No dataset.yaml found - run training first"}), flush=True)
        sys.exit(1)

    weights_dir = os.path.dirname(best_pt)
    onnx_file = os.path.join(weights_dir, "best.onnx")

    # Step 1: Load model, apply tf_wrapper Detect-head patch, export to ONNX.
    print(json.dumps({"status": "exporting_onnx"}), flush=True)
    import torch
    from ultralytics import YOLO
    from ultralytics.utils.export.tensorflow import tf_wrapper
    from ultralytics.data import YOLODataset, build_dataloader
    from ultralytics.data.utils import check_det_dataset

    model = YOLO(best_pt)
    tf_wrapper(model.model)
    if os.path.exists(onnx_file):
        os.remove(onnx_file)
    model.export(format="onnx", imgsz=args.imgsz, simplify=True)
    if not os.path.exists(onnx_file):
        print(json.dumps({"error": "ONNX export failed"}), flush=True)
        sys.exit(1)

    # Step 2: Build calibration data via Ultralytics' YOLODataset path so
    # letterbox preprocessing matches training. Output is BHWC float32 in
    # [0, 255], which is what onnx2tf expects with the [[[[0,0,0]]]] /
    # [[[[255,255,255]]]] range hints. Hand-rolled cv2 resize gave undertuned
    # int8 ranges that collapsed cls scores on small (2-class) models.
    print(json.dumps({"status": "building_calibration"}), flush=True)
    data = check_det_dataset(data_yaml)
    cal_split = "val" if "val" in data else "train"
    dataset = YOLODataset(
        data[cal_split],
        data=data,
        task="detect",
        imgsz=args.imgsz,
        augment=False,
        batch_size=16,
    )
    n = len(dataset)
    if n < 1:
        print(json.dumps({"error": "No calibration images in dataset"}), flush=True)
        sys.exit(1)
    loader = build_dataloader(dataset, batch=min(16, n), workers=0, drop_last=False)
    image_batches = [batch["img"] for batch in loader]
    calib_data = (
        torch.nn.functional.interpolate(
            torch.cat(image_batches, 0).float(), size=args.imgsz
        )
        .permute(0, 2, 3, 1)
        .numpy()
        .astype(np.float32)
    )
    calib_npy = os.path.join(weights_dir, "calib_data.npy")
    np.save(calib_npy, calib_data)

    print(json.dumps({
        "status": "converting_tflite",
        "calibration_images": int(calib_data.shape[0]),
    }), flush=True)

    # Step 3: Convert with onnx2tf. The default flatbuffer_direct backend
    # works correctly with the tf_wrapper-patched ONNX. input_quant_dtype
    # and output_quant_dtype force uint8 IN / float32 OUT to match the
    # reference model's IO contract.
    saved_model_dir = os.path.join(weights_dir, "best_saved_model")
    if os.path.exists(saved_model_dir):
        shutil.rmtree(saved_model_dir)

    if not os.path.exists("calibration_image_sample_data_20x128x128x3_float32.npy"):
        np.save(
            "calibration_image_sample_data_20x128x128x3_float32.npy",
            np.random.rand(20, 128, 128, 3).astype(np.float32),
        )

    import onnx2tf
    onnx2tf.convert(
        input_onnx_file_path=onnx_file,
        output_folder_path=saved_model_dir,
        not_use_onnxsim=True,
        verbosity="error",
        output_integer_quantized_tflite=True,
        custom_input_op_name_np_data_path=[
            ["images", calib_npy, [[[[0, 0, 0]]]], [[[[255, 255, 255]]]]],
        ],
        enable_batchmatmul_unfold=False,
        output_signaturedefs=True,
        input_quant_dtype="uint8",
        output_quant_dtype="float32",
    )

    print(json.dumps({"status": "tflite_done"}), flush=True)

    # Step 4: Copy the full_integer_quant variant (uint8 IN / float32 OUT,
    # full int8 graph). Skip int16-act siblings.
    integer_quant = None
    for f in sorted(os.listdir(saved_model_dir)):
        if "full_integer_quant" in f and "int16" not in f:
            integer_quant = os.path.join(saved_model_dir, f)
            break

    if not integer_quant or not os.path.exists(integer_quant):
        print(json.dumps({"error": "full_integer_quant TFLite not found"}), flush=True)
        sys.exit(1)

    export_dir = os.path.join(args.project, "export")
    os.makedirs(export_dir, exist_ok=True)
    dest = os.path.join(export_dir, "model.tflite")
    shutil.copy2(integer_quant, dest)

    config_path = os.path.join(args.project, "project.json")
    with open(config_path) as f:
        config = json.load(f)
    labels_path = os.path.join(export_dir, "labels.txt")
    with open(labels_path, "w") as f:
        for cls in config["classes"]:
            f.write(cls + "\n")

    file_size = os.path.getsize(dest)

    print(json.dumps({
        "status": "done",
        "tflite_path": dest,
        "labels_path": labels_path,
        "file_size": file_size,
    }), flush=True)


if __name__ == "__main__":
    main()
