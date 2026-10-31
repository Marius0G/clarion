import { useEffect, useRef, useState } from "react";
import { parseBCBP, type BoardingFlight } from "./bcbp";
interface Detector {
  detect(
    source: ImageBitmap | HTMLVideoElement,
  ): Promise<{ rawValue: string }[]>;
}
interface DetectorConstructor {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats(): Promise<string[]>;
}
const DetectorAPI = (
  globalThis as typeof globalThis & { BarcodeDetector?: DetectorConstructor }
).BarcodeDetector;
async function makeDetector(formats: string[]): Promise<Detector> {
  if (DetectorAPI && formats.includes('pdf417')) return new DetectorAPI({ formats });
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
    import('@zxing/browser'), import('@zxing/library'),
  ]);
  const reader = new BrowserMultiFormatReader(new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417, BarcodeFormat.AZTEC]]]));
  return { async detect(source) {
    const canvas = document.createElement('canvas');
    canvas.width = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    canvas.height = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height) return [];
    context.drawImage(source, 0, 0);
    try { return [{ rawValue: reader.decodeFromCanvas(canvas).getText() }]; }
    catch { return []; }
  } };
}
export default function Scanner({
  en,
  onFlight,
}: {
  en: boolean;
  onFlight: (flight: BoardingFlight) => void;
}) {
  const [formats, setFormats] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    DetectorAPI?.getSupportedFormats()
      .then((all) =>
        setFormats(all.filter((f) => ["pdf417", "aztec"].includes(f))),
      )
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!open) return;
    let stopped = false,
      stream: MediaStream | undefined,
      timer: ReturnType<typeof setTimeout>;
    const stop = () => {
      stream?.getTracks().forEach((track) => track.stop());
      if (video.current) video.current.srcObject = null;
    };
    let detector: Promise<Detector> | undefined;
    async function scan() {
      if (stopped || !video.current) return;
      try {
        if (video.current.readyState >= 2) {
          detector ??= makeDetector(formats);
          const results = await (await detector).detect(video.current);
          if (stopped) return;
          for (const result of results) {
            const flight = parseBCBP(result.rawValue);
            result.rawValue = "";
            if (flight) {
              stop();
              onFlight(flight);
              setOpen(false);
              return;
            }
          }
        }
      } catch {
        /* A frame can be unavailable while the camera starts. */
      }
      if (!stopped) timer = setTimeout(scan, 300);
    }
    Promise.resolve().then(() => {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera unavailable");
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    })
      .then(async (media) => {
        stream = media;
        if (stopped) {
          stop();
          return;
        }
        if (video.current) {
          video.current.srcObject = media;
          await video.current.play();
        }
        void scan();
      })
      .catch(() => {
        if (stopped) return;
        stop();
        setError(
          en
            ? "Camera unavailable. Upload a screenshot or enter your flight."
            : "Camera nu este disponibilă. Încarcă un screenshot sau scrie zborul.",
        );
      });
    return () => {
      stopped = true;
      clearTimeout(timer);
      stop();
    };
  }, [open, formats, en, onFlight]);
  return (
    <div className="join-scanner">
      <button
        type="button"
        className="join-scan"
        onClick={() => {
          setOpen(!open);
          setError("");
        }}
      >
        {open
          ? en
            ? "Close scanner"
            : "Închide scanarea"
          : en
            ? "Scan boarding pass"
            : "Scanează boarding pass"}
      </button>
      {open && (
        <div>
          <video
            ref={video}
            muted
            playsInline
            aria-label={en ? "Boarding pass camera" : "Cameră boarding pass"}
          />
          <label className="join-upload">
            {en ? "Upload screenshot" : "Încarcă screenshot"}
            <input
              type="file"
              accept="image/*"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                let bitmap: ImageBitmap | undefined;
                try {
                  bitmap = await createImageBitmap(file);
                  const results = await (await makeDetector(formats)).detect(bitmap);
                  let found: BoardingFlight | null = null;
                  for (const result of results) {
                    found ??= parseBCBP(result.rawValue);
                    result.rawValue = "";
                  }
                  if (!found) throw new Error("Unreadable");
                  onFlight(found);
                  setOpen(false);
                  setError("");
                } catch {
                  setError(
                    en
                      ? "Code unreadable. Enter your flight manually."
                      : "Codul nu poate fi citit. Scrie numărul zborului.",
                  );
                } finally {
                  bitmap?.close();
                }
              }}
            />
          </label>
          <p>
            {en
              ? "Processed on this phone. Name and booking reference are discarded."
              : "Procesat pe telefon. Numele și PNR-ul sunt eliminate."}
          </p>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
