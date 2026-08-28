"""Fas 2–3 — beskärning, embedding och färg.

Primitiverna som både batchjobbet (`embed_images.py`) och API:et använder, så
att säljarens bild behandlas **exakt** som annonsbilderna. Skulle de skilja sig
åt blir likhetspoängen meningslös.

Kedjan per bild:

    ladda -> YOLO-detektion -> beskär till möbeln -> DINOv2 -> L2-normalisera
                            \\-> färghistogram (HSV)

**Varför beskärning inte är valfri.** Annonsbilder är fulla av vardagsrum,
mattor, gardiner och husdjur. Utan beskärning mäter modellen rummet lika mycket
som möbeln. YOLO hittar möbeln i ~44 % av bilderna; resten används i sin helhet
och märks som obeskurna.

**Varför både embedding och färg.** DINOv2 fångar form, proportioner, ben,
sömmar och klädselstruktur — visuell identitet. Den är däremot förvånansvärt
tolerant mot färg, och färg är ofta en verklig prisskillnad (beige mot
mörkblå). Ett färghistogram kostar nästan ingenting och fångar det hårdare.
Vikten mellan dem är konfigurerbar (COLOR_WEIGHT).
"""

from __future__ import annotations

import logging
from functools import lru_cache

import numpy as np
from PIL import Image

from . import config

log = logging.getLogger(__name__)

#: COCO-klasser som räknas som möbel. Detektorn hittar även "suitcase",
#: "airplane" och "skateboard" på möbelbilder — de ignoreras medvetet,
#: hellre obeskuren bild än beskuren till fel sak.
FURNITURE_CLASSES = frozenset(
    {"chair", "couch", "bed", "dining table", "bench", "toilet"}
)


# --------------------------------------------------------------------------
# Modellerna laddas en gång per process
# --------------------------------------------------------------------------
@lru_cache(maxsize=1)
def detector():
    from ultralytics import YOLO

    return YOLO(config.DETECTOR_MODEL)


@lru_cache(maxsize=1)
def embedder():
    import torch
    from transformers import AutoImageProcessor, AutoModel

    torch.set_num_threads(config.TORCH_THREADS)
    processor = AutoImageProcessor.from_pretrained(config.EMBED_MODEL)
    model = AutoModel.from_pretrained(config.EMBED_MODEL).eval()
    return processor, model


# --------------------------------------------------------------------------
# Fas 2 — beskärning
# --------------------------------------------------------------------------
def _largest_furniture_box(result):
    """Största möbelrutan i ett YOLO-resultat, eller None."""
    boxes = getattr(result, "boxes", None)
    if boxes is None or len(boxes) == 0:
        return None
    best, best_area = None, 0.0
    for xyxy, cls, conf in zip(boxes.xyxy, boxes.cls, boxes.conf):
        if result.names[int(cls)] not in FURNITURE_CLASSES:
            continue
        if float(conf) < config.DETECT_CONF:
            continue
        x1, y1, x2, y2 = (float(v) for v in xyxy)
        area = (x2 - x1) * (y2 - y1)
        if area > best_area:
            best, best_area = (x1, y1, x2, y2), area
    return best


def crop_batch(images: list) -> tuple:
    """Beskär en lista PIL-bilder till möbeln. Returnerar (bilder, beskurna).

    `beskurna` är en bool per bild — False betyder att detektionen föll ur och
    hela bilden används.
    """
    if not images:
        return [], []
    results = detector().predict(
        images, verbose=False, conf=config.DETECT_CONF, imgsz=config.DETECT_IMGSZ
    )
    out, flags = [], []
    for image, result in zip(images, results):
        box = _largest_furniture_box(result)
        if box is None:
            out.append(image)
            flags.append(False)
            continue
        x1, y1, x2, y2 = box
        # Lite marginal runt rutan: YOLO klipper ofta precis vid kanten och
        # missar ben eller armstöd, som är just det DINOv2 ska titta på.
        w, h = image.size
        mx, my = (x2 - x1) * config.CROP_MARGIN, (y2 - y1) * config.CROP_MARGIN
        box = (max(0, x1 - mx), max(0, y1 - my), min(w, x2 + mx), min(h, y2 + my))
        out.append(image.crop(box))
        flags.append(True)
    return out, flags


# --------------------------------------------------------------------------
# Fas 3 — embedding och färg
# --------------------------------------------------------------------------
def embed_batch(images: list) -> np.ndarray:
    """DINOv2 CLS-token per bild, L2-normaliserad. (N, 384) float32.

    L2-normaliseringen gör att cosinuslikhet blir en ren skalärprodukt, vilket
    är både snabbare och enklare att resonera om.
    """
    import torch

    if not images:
        return np.zeros((0, config.EMBED_DIM), dtype=np.float32)
    processor, model = embedder()
    with torch.no_grad():
        inputs = processor(images=images, return_tensors="pt")
        outputs = model(**inputs)
        cls = outputs.last_hidden_state[:, 0]  # CLS-token
        cls = torch.nn.functional.normalize(cls, p=2, dim=1)
    return cls.numpy().astype(np.float32)


def color_batch(images: list) -> np.ndarray:
    """HSV-histogram per bild, L2-normaliserat. (N, 3*bins) float32.

    Per kanal i stället för gemensamt histogram: billigare, och räcker gott
    för "beige mot mörkblå".
    """
    bins = config.COLOR_BINS
    out = np.zeros((len(images), 3 * bins), dtype=np.float32)
    for i, image in enumerate(images):
        hsv = np.asarray(image.convert("HSV"), dtype=np.uint8).reshape(-1, 3)
        parts = [
            np.histogram(hsv[:, c], bins=bins, range=(0, 256))[0] for c in range(3)
        ]
        vector = np.concatenate(parts).astype(np.float32)
        norm = np.linalg.norm(vector)
        out[i] = vector / norm if norm else vector
    return out


def prepare_batch(images: list) -> tuple:
    """Hela kedjan för en batch: (embeddings, färger, beskurna)."""
    cropped, flags = crop_batch(images)
    return embed_batch(cropped), color_batch(cropped), flags


def prepare_one(image: Image.Image) -> tuple:
    """Samma kedja för en enda bild — används för säljarens foto."""
    vectors, colors, flags = prepare_batch([image.convert("RGB")])
    return vectors[0], colors[0], flags[0]


# --------------------------------------------------------------------------
# Likhet
# --------------------------------------------------------------------------
def similarity(
    query_vec: np.ndarray,
    query_color: np.ndarray,
    cand_vecs: np.ndarray,
    cand_colors: np.ndarray | None = None,
    color_weight: float | None = None,
) -> np.ndarray:
    """Sammanvägd likhet mot kandidater. Returnerar (N,) i [0, 1].

    Båda sidor är L2-normaliserade, så skalärprodukten ÄR cosinuslikheten.
    Vikten mellan bild och färg är konfigurerbar så att den går att justera
    mot data i stället för att gissas.
    """
    weight = config.COLOR_WEIGHT if color_weight is None else color_weight
    if cand_vecs.size == 0:
        return np.zeros(0, dtype=np.float32)

    image_sim = cand_vecs.astype(np.float32) @ query_vec.astype(np.float32)
    if cand_colors is None or weight <= 0:
        return image_sim

    color_sim = cand_colors.astype(np.float32) @ query_color.astype(np.float32)
    return (1.0 - weight) * image_sim + weight * color_sim
