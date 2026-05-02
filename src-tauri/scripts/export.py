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
#   6. If --target selects an NPU, post-compile model.tflite for that NPU
#      (Vela for Ethos-U55, stedgeai + N6 relocator for STM32 N6) and
#      overwrite model.tflite with the compiled artifact.
#
# TF must be imported BEFORE onnx/onnx2tf. If onnx loads first, its bundled
# abseil shadows TF's libtensorflow_framework copy and the int8 calibration
# loop deadlocks in Notification::WaitForNotification.
#
# Usage:
#   python export.py --project DIR --imgsz 192 [--target TARGET --models-dir DIR]

import os

# Disable all ultralytics network paths (PyPI version check, GA telemetry,
# attempt_download_asset for missing weights). Must be set BEFORE the
# ultralytics import, since utils/__init__.py caches ONLINE at module load.
os.environ["YOLO_OFFLINE"] = "true"

import tensorflow as tf  # noqa: F401  MUST be first - see header comment

import argparse
import json
import random
import re
import shutil
import subprocess
import sys

import numpy as np


# Per-target Vela flags. Match tools/vela.ini system configs and the
# firmware's per-core layout (HP core gets DTCM_MRAM, HE core gets
# SRAM_MRAM). All targets use Shared_Sram and Performance.
VELA_TARGET_ARGS = {
    "ethos-u55-256": [
        "--accelerator-config", "ethos-u55-256",
        "--system-config", "RTSS_HP_DTCM_MRAM",
        "--memory-mode", "Shared_Sram",
        "--optimise", "Performance",
    ],
    "ethos-u55-128": [
        "--accelerator-config", "ethos-u55-128",
        "--system-config", "RTSS_HE_SRAM_MRAM",
        "--memory-mode", "Shared_Sram",
        "--optimise", "Performance",
    ],
}

VALID_TARGETS = ("cpu", "ethos-u55-128", "ethos-u55-256", "st-neural-art")


def vela_compile(model_path, build_dir, target, models_dir):
    if target not in VELA_TARGET_ARGS:
        raise ValueError("Unsupported Vela target: {}".format(target))
    if not models_dir or not os.path.isdir(models_dir):
        raise FileNotFoundError(
            "Vela target requires --models-dir with vela.ini"
        )
    vela_ini = os.path.join(models_dir, "vela.ini")
    if not os.path.isfile(vela_ini):
        raise FileNotFoundError("vela.ini not found at: {}".format(vela_ini))

    model = os.path.basename(os.path.splitext(model_path)[0])
    # Run vela through the bundled Python instead of the `vela` console
    # script: the script lives in the Python install's bin/ which is not on
    # PATH for the Tauri-spawned subprocess. `python -m ethosu.vela` works
    # off the package's __main__.py and matches the console-script entry.
    command = [
        sys.executable,
        "-m", "ethosu.vela",
        *VELA_TARGET_ARGS[target],
        "--output-dir", build_dir,
        "--config", vela_ini,
        model_path,
    ]
    try:
        subprocess.run(command, check=True, text=True, capture_output=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            "vela failed (exit {}): {}".format(e.returncode, e.stderr)
        )

    out = os.path.join(build_dir, "{}_vela.tflite".format(model))
    if not os.path.exists(out):
        raise FileNotFoundError(
            "Vela output not found: {}".format(out)
        )
    return out


def _find_stedgeai_bin(stedgeai_dir):
    # Bundle layout: <stedgeai_dir>/Utilities/<platform_subdir>/stedgeai
    # (subdir name varies per OS/arch -- macarm, linuxx86_64, etc.).
    # Exactly one platform's binaries ship per build, so first match wins.
    binname = "stedgeai.exe" if sys.platform == "win32" else "stedgeai"
    utilities = os.path.join(stedgeai_dir, "Utilities")
    if os.path.isdir(utilities):
        for sub in os.listdir(utilities):
            candidate = os.path.join(utilities, sub, binname)
            if os.path.isfile(candidate):
                return candidate
    raise FileNotFoundError(
        "stedgeai binary not found under {}".format(utilities)
    )


def stedge_compile(model_path, build_dir, models_dir, stedgeai_dir):
    if not stedgeai_dir or not os.path.isdir(stedgeai_dir):
        raise FileNotFoundError(
            "stedgeai dir not provided or missing: {}".format(stedgeai_dir)
        )
    npu_driver = os.path.join(
        stedgeai_dir, "scripts", "N6_reloc", "npu_driver.py"
    )
    if not os.path.isfile(npu_driver):
        raise FileNotFoundError(
            "npu_driver.py not found at: {}".format(npu_driver)
        )
    stedgeai_bin = _find_stedgeai_bin(stedgeai_dir)
    print("export.py: stedgeai_bin={}".format(stedgeai_bin), file=sys.stderr, flush=True)
    if not models_dir or not os.path.isdir(models_dir):
        raise FileNotFoundError(
            "STM32 N6 target requires --models-dir with neuralart.json"
        )
    config = os.path.join(models_dir, "neuralart.json")
    if not os.path.isfile(config):
        raise FileNotFoundError(
            "neuralart.json not found at: {}".format(config)
        )

    model_name = os.path.basename(os.path.splitext(model_path)[0])
    output_dir = os.path.join(build_dir, model_name)
    os.makedirs(output_dir, exist_ok=True)

    # Strip Make-related env vars that could leak into the subprocess.
    env = os.environ.copy()
    for var in ["RM", "CFLAGS", "CPPFLAGS", "CXXFLAGS", "LDFLAGS", "MAKEFLAGS"]:
        env.pop(var, None)

    generate_command = [
        stedgeai_bin,
        "generate",
        "--target", "stm32n6",
        "--model", model_path,
        "--relocatable",
        "--st-neural-art", "default@{}".format(config),
        "--workspace", os.path.join(output_dir, "workspace"),
        "--output", os.path.join(output_dir, "gen"),
        "--verbosity", "1",
    ]
    print("export.py: running stedgeai: {}".format(" ".join(generate_command)),
          file=sys.stderr, flush=True)
    # Inherit stdout/stderr so stedgeai's diagnostics stream into our log
    # in real time (capture_output was swallowing the actual error).
    rc = subprocess.run(generate_command, env=env).returncode
    if rc != 0:
        raise RuntimeError("stedgeai generate failed (exit {})".format(rc))

    reloc_command = [
        sys.executable,
        npu_driver,
        "--input", os.path.join(output_dir, "gen", "network.c"),
        "--output", output_dir,
        "--verbosity", "1",
    ]
    print("export.py: running N6 reloc: {}".format(" ".join(reloc_command)),
          file=sys.stderr, flush=True)
    rc = subprocess.run(reloc_command, env=env).returncode
    if rc != 0:
        raise RuntimeError("N6 relocation failed (exit {})".format(rc))

    out = os.path.join(output_dir, "network_rel.bin")
    if not os.path.exists(out):
        raise FileNotFoundError(
            "stedgeai output not found: {}".format(out)
        )
    return out


def compile_for_target(model_path, target, models_dir, stedgeai_dir):
    # Build artifacts go in a sibling dir to keep the export dir clean.
    build_dir = os.path.join(os.path.dirname(model_path), "compile")
    if os.path.exists(build_dir):
        shutil.rmtree(build_dir)
    os.makedirs(build_dir, exist_ok=True)

    if target in VELA_TARGET_ARGS:
        compiled = vela_compile(model_path, build_dir, target, models_dir)
    elif target == "st-neural-art":
        compiled = stedge_compile(model_path, build_dir, models_dir, stedgeai_dir)
    else:
        raise ValueError("Unsupported target: {}".format(target))

    shutil.copy2(compiled, model_path)
    shutil.rmtree(build_dir, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description="Export YOLOv8 to TFLite")
    ap.add_argument("--project", required=True, help="Project directory")
    ap.add_argument("--imgsz", type=int, default=192, help="Image size")
    ap.add_argument(
        "--target",
        choices=VALID_TARGETS,
        default="cpu",
        help="Deployment target (drives optional NPU compile step)",
    )
    ap.add_argument(
        "--models-dir",
        default=None,
        help="Directory holding vela.ini and neuralart.json (required for non-CPU targets)",
    )
    ap.add_argument(
        "--stedgeai-dir",
        default=None,
        help="Root of the stedgeai distribution (required for st-neural-art target)",
    )
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
    from ultralytics.data import YOLODataset
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
    #
    # Stratified per-class sampling + shuffle: the dataset on disk is
    # grouped by class (all class-A images, then all class-B), and on
    # imbalanced sets the histogram-based calibrators (Entropy for the QDQ
    # path, the onnx2tf default) fit activation ranges to whichever class
    # has more samples, dropping the minority class entirely on the NPU.
    # Take an equal number of images per class and shuffle the order.
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

    rng = random.Random(0)
    class_to_imgs = {}
    for i, lab in enumerate(dataset.labels):
        cls_arr = lab.get("cls")
        if cls_arr is None:
            continue
        for c in set(int(v) for v in np.asarray(cls_arr).flatten().tolist()):
            class_to_imgs.setdefault(c, []).append(i)

    if class_to_imgs:
        target = min(len(v) for v in class_to_imgs.values())
        selected = set()
        for imgs in class_to_imgs.values():
            rng.shuffle(imgs)
            taken = 0
            for idx in imgs:
                if idx in selected:
                    continue
                selected.add(idx)
                taken += 1
                if taken >= target:
                    break
        indices = list(selected)
    else:
        indices = list(range(n))
    rng.shuffle(indices)

    samples = [torch.as_tensor(dataset[i]["img"]) for i in indices]
    calib_data = (
        torch.nn.functional.interpolate(
            torch.stack(samples).float(), size=args.imgsz
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

    # onnx2tf calls download_test_image_data() during convert for auxiliary
    # tensor shape inference. Its hardcoded URL returns 404, and the bundled
    # Python's network kill switch blocks the request anyway. Patch it
    # in-process to return a deterministic dummy array. Patch BOTH the
    # source module and the onnx2tf.onnx2tf module: the latter does
    # `from ...common_functions import download_test_image_data`, so it
    # holds its own binding that the source-module patch alone won't reach.
    import onnx2tf
    import onnx2tf.onnx2tf as _o2t_main
    import onnx2tf.utils.common_functions as _o2t_cf

    def _stub_download_test_image_data():
        return np.zeros((20, 128, 128, 3), dtype=np.float32)

    _o2t_cf.download_test_image_data = _stub_download_test_image_data
    _o2t_main.download_test_image_data = _stub_download_test_image_data

    # Suppress json_auto_generator recovery. On any per-op conversion error
    # onnx2tf otherwise spawns `python -m onnx2tf` in a subprocess (bare
    # "python", no env) up to 3 times to search for parameter-replacement
    # fixes. In our bundled-Python sandbox bare "python" doesn't resolve;
    # even if it did, recovery only writes a hint JSON and re-raises the
    # original error -- it never retries the conversion. Pass an empty
    # replacements file so the recovery branch is skipped and errors
    # propagate immediately.
    empty_prf = os.path.join(weights_dir, "_no_replacements.json")
    with open(empty_prf, "w") as f:
        json.dump({"format_version": 1, "operations": []}, f)

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
        param_replacement_file=empty_prf,
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

    config_path = os.path.join(args.project, "project.json")
    with open(config_path) as f:
        config = json.load(f)

    # Descriptive filename: <sanitized_project>_<model>_<imgsz>.tflite, e.g.
    # "cats_and_dogs_yolo11n_192.tflite". Mirrors the default the old Save
    # dialog used to suggest. Sanitization rule matches the frontend:
    # anything outside [a-zA-Z0-9_-] becomes "_".
    project_name = os.path.basename(os.path.normpath(args.project))
    sanitized = re.sub(r"[^a-zA-Z0-9_-]", "_", project_name)
    model_tag = "_{}".format(config["model"]) if config.get("model") else ""
    save_name = "{}{}_{}.tflite".format(sanitized, model_tag, args.imgsz)

    export_dir = os.path.join(args.project, "export")
    os.makedirs(export_dir, exist_ok=True)
    # Each export overwrites; clear stale .tflite siblings so the dir holds
    # exactly one artifact (Rust deploys whatever .tflite is present).
    for f in os.listdir(export_dir):
        if f.endswith(".tflite"):
            try:
                os.remove(os.path.join(export_dir, f))
            except OSError:
                pass
    dest = os.path.join(export_dir, save_name)
    shutil.copy2(integer_quant, dest)

    # Step 5: Optional NPU compile. Overwrites the .tflite with the
    # target-specific artifact (Vela _vela.tflite or N6 network_rel.bin).
    if args.target != "cpu":
        print(json.dumps({"status": "compiling_for_{}".format(args.target)}), flush=True)
        compile_for_target(dest, args.target, args.models_dir, args.stedgeai_dir)
        print(json.dumps({"status": "compile_done"}), flush=True)

    # Sidecar so Deploy can detect a stale artifact when the target changes.
    target_marker = os.path.join(export_dir, ".target")
    with open(target_marker, "w") as f:
        f.write(args.target)

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
        "target": args.target,
    }), flush=True)


if __name__ == "__main__":
    import traceback
    try:
        main()
    except SystemExit as e:
        os._exit(e.code if isinstance(e.code, int) else 1)
    except BaseException:
        traceback.print_exc()
        os._exit(1)
    os._exit(0)
